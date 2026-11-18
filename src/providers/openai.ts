import { setTimeout as sleep } from 'node:timers/promises';
import type { UsageBar, UsageReport } from '../types.js';
import { CLOUD_CTX_CAP, OllamaProvider, type OllamaChunk, type OllamaMessage } from './ollama.js';

type Body = { model: string; stream: boolean; messages: OllamaMessage[]; tools?: unknown[] };

type SseChunk = {
  choices?: {
    delta?: { content?: string | null; reasoning?: string | null; tool_calls?: { index: number; function?: { name?: string; arguments?: string } }[] };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string };
};

const HINTS: Record<number, string> = {
  401: 'chave inválida: confira OPENROUTER_API_KEY',
  402: 'créditos insuficientes: adicione créditos no provedor',
  404: 'modelo não encontrado: confira o nome, por exemplo qwen/qwen3-coder-next',
  429: 'limite de requisições persistiu após novas tentativas: aguarde e tente de novo',
};

export function toOpenAIMessages(messages: OllamaMessage[]): object[] {
  let pending: string[] = [];
  return messages.map((m, i) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: pending.shift() ?? `call_${i}`, content: m.content };
    if (m.role !== 'assistant' || !m.tool_calls?.length) return { role: m.role, content: m.content };
    pending = m.tool_calls.map((_, j) => `call_${i}_${j}`);
    const tool_calls = m.tool_calls.map((c, j) => ({
      id: pending[j],
      type: 'function',
      function: { name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments) },
    }));
    return { role: 'assistant', content: m.content, tool_calls };
  });
}

export async function* sseData(res: Response): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
}

export class OpenAICompatProvider extends OllamaProvider {
  constructor(
    model: string,
    private readonly baseUrl = process.env.OPENAI_BASE_URL ?? 'https://openrouter.ai/api/v1',
    private readonly apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
    private readonly retryDelaysMs = [2000, 5000, 15000, 30000],
  ) {
    super(model, CLOUD_CTX_CAP);
  }

  protected override async modelInfo(): Promise<{ thinking: boolean; vision: boolean; ctx: number }> {
    return { thinking: false, vision: false, ctx: CLOUD_CTX_CAP };
  }

  protected override async post(body: object, signal: AbortSignal): Promise<Response> {
    if (!this.apiKey) throw new Error('Defina OPENROUTER_API_KEY (ou OPENAI_API_KEY) para usar o provedor openai.');
    const { stream, messages, tools } = body as Body;
    let res = await this.send({ stream, messages, tools }, signal);
    for (const delay of this.retryDelaysMs) {
      if (res.status !== 429 && res.status < 500) break;
      await res.body?.cancel();
      await sleep(delay, undefined, { signal });
      res = await this.send({ stream, messages, tools }, signal);
    }
    if (!res.ok) {
      const hint = HINTS[res.status];
      throw new Error(`Provedor openai respondeu ${res.status}${hint ? ` (${hint})` : ''}: ${await res.text()}`);
    }
    if (stream) return res;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return Response.json({ message: { content: data.choices?.[0]?.message?.content ?? '' } });
  }

  private async send({ stream, messages, tools }: Omit<Body, 'model'>, signal: AbortSignal): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          stream,
          messages: toOpenAIMessages(messages),
          ...(tools?.length ? { tools } : {}),
          ...(stream ? { stream_options: { include_usage: true }, usage: { include: true } } : {}),
        }),
        signal,
      });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new Error(`Não foi possível conectar a ${this.baseUrl}. Confira a rede ou OPENAI_BASE_URL.`, { cause: e });
    }
  }

  protected override async *chunks(res: Response): AsyncGenerator<OllamaChunk> {
    const calls: { name: string; args: string }[] = [];
    let usage: SseChunk['usage'];
    let finish = '';
    for await (const data of sseData(res)) {
      if (data === '[DONE]') break;
      const chunk = JSON.parse(data) as SseChunk;
      if (chunk.error) throw new Error(`Provedor openai: ${chunk.error.message ?? 'erro sem descrição'}`);
      usage = chunk.usage ?? usage;
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta;
        if (delta?.content || delta?.reasoning) yield { message: { content: delta.content ?? '', thinking: delta.reasoning ?? '' } };
        for (const t of delta?.tool_calls ?? []) {
          const call = (calls[t.index] ??= { name: '', args: '' });
          call.name += t.function?.name ?? '';
          call.args += t.function?.arguments ?? '';
        }
        finish = choice.finish_reason ?? finish;
      }
    }
    yield {
      message: { tool_calls: calls.filter(Boolean).map((c) => ({ function: { name: c.name, arguments: c.args } })) },
      done: true,
      done_reason: finish === 'length' ? 'length' : 'stop',
      prompt_eval_count: usage?.prompt_tokens ?? 0,
      eval_count: usage?.completion_tokens ?? 0,
      ...(usage?.cost === undefined ? {} : { cost: usage.cost }),
    };
  }
}

type Budget = { limit_usd?: number; spend_usd?: number; reset_interval?: string | null; resets_at?: string | null };
type KeyInfo = { data?: { usage_weekly?: number; effective_budget?: Budget | null } };
type Credits = { data?: { total_credits?: number; total_usage?: number } };


const DAY_MS = 86_400_000;

const PERIOD_START: Record<string, (end: Date) => Date> = {
  daily: (end) => new Date(end.getTime() - DAY_MS),
  weekly: (end) => new Date(end.getTime() - 7 * DAY_MS),
  monthly: (end) => {
    const start = new Date(end);
    start.setUTCMonth(start.getUTCMonth() - 1);
    return start;
  },
};

const PERIOD_LABEL: Record<string, string> = { daily: 'dia', weekly: 'semana', monthly: 'mês' };

const usd = (n: number): string => `US$ ${n.toFixed(2)}`;
export const percentOf = (part: number, whole: number): number => Math.round((part / whole) * 100);
const dayMonth = (d: Date): string => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });

function keyBar(budget: Budget, now: Date): UsageBar | null {
  if (!budget.limit_usd) return null;
  const spend = budget.spend_usd ?? 0;
  const interval = budget.reset_interval ?? '';
  const bar: UsageBar = {
    label: `Limite da chave (${PERIOD_LABEL[interval] ?? 'total'})`,
    percent: percentOf(spend, budget.limit_usd),
    detail: `${usd(spend)} de ${usd(budget.limit_usd)}`,
    note: '',
  };
  const startOf = PERIOD_START[interval];
  if (!startOf || !budget.resets_at) return bar;
  const end = new Date(budget.resets_at);
  const start = startOf(end);
  bar.detail += ` · renova ${dayMonth(end)}`;
  const elapsed = (now.getTime() - start.getTime()) / (end.getTime() - start.getTime());
  if (elapsed <= 0) return bar;
  const projected = spend / elapsed;
  bar.note = `${percentOf(elapsed, 1)}% do período já passou · no ritmo fecha em ${usd(projected)}`;
  if (projected > budget.limit_usd) bar.note += ' — acima do limite';
  return bar;
}

function creditsBar(total: number, used: number, weekly: number): UsageBar {
  const balance = total - used;
  const bar: UsageBar = { label: 'Créditos da conta', percent: percentOf(used, total), detail: `${usd(used)} de ${usd(total)} · saldo ${usd(balance)}`, note: '' };
  const perDay = weekly / 7;
  if (perDay > 0) bar.note = `no ritmo dos últimos 7 dias (${usd(perDay)}/dia) o saldo dura ~${Math.floor(balance / perDay)} dias`;
  return bar;
}

export async function openRouterUsage(
  baseUrl = process.env.OPENAI_BASE_URL ?? 'https://openrouter.ai/api/v1',
  apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
  now = new Date(),
): Promise<UsageReport> {
  if (!apiKey) return { bars: [], error: 'saldo indisponível: defina OPENROUTER_API_KEY' };
  const get = async <T>(path: string): Promise<T | null> => {
    const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${apiKey}` } }).catch(() => null);
    if (!res?.ok) return null;
    return (await res.json()) as T;
  };
  const [key, credits] = await Promise.all([get<KeyInfo>('/key'), get<Credits>('/credits')]);
  const bars: UsageBar[] = [];
  const keyLimit = key?.data?.effective_budget && keyBar(key.data.effective_budget, now);
  if (keyLimit) bars.push(keyLimit);
  const c = credits?.data;
  if (c?.total_credits) bars.push(creditsBar(c.total_credits, c.total_usage ?? 0, key?.data?.usage_weekly ?? 0));
  if (!bars.length) return { bars, error: 'saldo indisponível: o OpenRouter não respondeu' };
  return { bars };
}
