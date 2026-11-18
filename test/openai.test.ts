import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenAICompatProvider, openRouterUsage } from '../src/providers/openai.js';
import type { StepRequest } from '../src/types.js';

type Sent = { url: string; auth: string; body: { stream: boolean; cache_control?: unknown; session_id?: string; max_tokens?: number; messages: { role: string; content: string | null; tool_call_id?: string; tool_calls?: { id: string; function: { arguments: string } }[] }[] } };

const sse = (...events: object[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n');

function stub(): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    const body = JSON.parse(init.body) as Sent['body'];
    sent.push({ url, auth: init.headers.authorization ?? '', body });
    if (!body.stream) return new Response(JSON.stringify({ choices: [{ message: { content: 'checkpoint summary' } }] }));
    return sse(
      { choices: [{ delta: { content: 'vou listar' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'bash', arguments: '{"comm' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 120, completion_tokens: 7 } },
    );
  }) as typeof fetch;
  return sent;
}

const req: StepRequest = { system: 's', tools: [{ name: 'bash', description: 'd', schema: { type: 'object', properties: {}, required: [] } }], signal: new AbortController().signal, onText: () => {}, onThinking: () => {} };

test('streamed tool-call fragments become one call, and its result goes back with the same tool_call_id', async () => {
  const sent = stub();
  const provider = new OpenAICompatProvider('qwen/qwen3-coder-next', 'https://router.test/v1', 'k');
  provider.addUser('liste os arquivos');

  const r = await provider.step(req);
  assert.equal(r.text, 'vou listar');
  assert.deepEqual(r.toolCalls.map((c) => [c.name, c.input]), [['bash', { command: 'ls' }]]);
  assert.equal(r.stop, 'tool_use');
  assert.deepEqual(r.usage, { input: 120, output: 7 });

  provider.addToolResults(r.toolCalls.map((c) => ({ id: c.id, name: c.name, output: 'a.ts', isError: false })));
  await provider.step(req);

  const second = sent[1]!;
  assert.equal(second.url, 'https://router.test/v1/chat/completions');
  assert.equal(second.auth, 'Bearer k');
  const [system, user, assistant, tool] = second.body.messages;
  assert.deepEqual([system?.role, user?.role, assistant?.role, tool?.role], ['system', 'user', 'assistant', 'tool']);
  assert.equal(assistant?.tool_calls?.[0]?.function.arguments, '{"command":"ls"}');
  assert.equal(tool?.tool_call_id, assistant?.tool_calls?.[0]?.id);
});

test('a missing key fails with what to set instead of calling the provider', async () => {
  const sent = stub();
  const provider = new OpenAICompatProvider('qwen/qwen3-coder-next', 'https://router.test/v1', '');
  provider.addUser('oi');
  await assert.rejects(provider.step(req), /OPENROUTER_API_KEY/);
  assert.equal(sent.length, 0);
});

function rateLimitedThenOk(failures: number): { calls: number } {
  const state = { calls: 0 };
  stub();
  const ok = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    state.calls++;
    if (state.calls <= failures) return new Response('{"error":{"code":429}}', { status: 429 });
    return ok(...args);
  }) as typeof fetch;
  return state;
}

test('a 429 from the provider is retried and the step goes through once the limit frees up', async () => {
  const state = rateLimitedThenOk(2);
  const provider = new OpenAICompatProvider('qwen/qwen3-coder-next', 'https://router.test/v1', 'k', [0, 0, 0]);
  provider.addUser('oi');
  const r = await provider.step(req);
  assert.equal(r.text, 'vou listar');
  assert.equal(state.calls, 3);
});

test('a 429 that outlasts every retry fails with the rate-limit hint', async () => {
  const state = rateLimitedThenOk(99);
  const provider = new OpenAICompatProvider('qwen/qwen3-coder-next', 'https://router.test/v1', 'k', [0, 0]);
  provider.addUser('oi');
  await assert.rejects(provider.step(req), /429 \(limite de requisições persistiu/);
  assert.equal(state.calls, 3);
});

test('the cost OpenRouter reports for a step comes back in its usage', async () => {
  stub();
  const ok = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const res = await ok(...args);
    const body = (await res.text()).replace('"completion_tokens":7}', '"completion_tokens":7,"cost":0.0123}');
    return new Response(body);
  }) as typeof fetch;
  const provider = new OpenAICompatProvider('qwen/qwen3-coder-next', 'https://router.test/v1', 'k');
  provider.addUser('oi');
  const r = await provider.step(req);
  assert.deepEqual(r.usage, { input: 120, output: 7, cost: 0.0123 });
});

function account(key: object | null, credits: object | null): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    const data = url.endsWith('/key') ? key : credits;
    if (!data) return new Response('forbidden', { status: 403 });
    return Response.json({ data });
  }) as typeof fetch;
  return urls;
}

const monthly = { limit_usd: 50, spend_usd: 8.7, reset_interval: 'monthly', resets_at: '2026-12-01T00:00:00.000Z' };

test('usage shows the key limit and account credits as percentages, with the pace of spending', async () => {
  const urls = account({ usage_weekly: 7, effective_budget: monthly }, { total_credits: 20, total_usage: 8.8 });
  const { bars, error } = await openRouterUsage('https://router.test/v1', 'k', new Date('2026-11-16T00:00:00.000Z'));
  assert.deepEqual(urls.sort(), ['https://router.test/v1/credits', 'https://router.test/v1/key']);
  assert.equal(error, undefined);
  assert.deepEqual(bars, [
    { label: 'Limite da chave (mês)', percent: 17, detail: 'US$ 8.70 de US$ 50.00 · renova 01/12', note: '50% do período já passou · no ritmo fecha em US$ 17.40' },
    { label: 'Créditos da conta', percent: 44, detail: 'US$ 8.80 de US$ 20.00 · saldo US$ 11.20', note: 'no ritmo dos últimos 7 dias (US$ 1.00/dia) o saldo dura ~11 dias' },
  ]);
});

test('a pace that would pass the key limit is flagged', async () => {
  account({ effective_budget: { ...monthly, spend_usd: 40 } }, null);
  const { bars } = await openRouterUsage('https://router.test/v1', 'k', new Date('2026-11-16T00:00:00.000Z'));
  assert.equal(bars[0]?.note, '50% do período já passou · no ritmo fecha em US$ 80.00 — acima do limite');
});

test('a key without limit and with no spend this week shows only the credits, without pace', async () => {
  account({ usage_weekly: 0, effective_budget: null }, { total_credits: 20, total_usage: 5 });
  const { bars } = await openRouterUsage('https://router.test/v1', 'k');
  assert.deepEqual(bars, [{ label: 'Créditos da conta', percent: 25, detail: 'US$ 5.00 de US$ 20.00 · saldo US$ 15.00', note: '' }]);
});

test('usage explains what is missing when there is no key or no answer', async () => {
  assert.match((await openRouterUsage('https://router.test/v1', '')).error ?? '', /OPENROUTER_API_KEY/);
  globalThis.fetch = (async () => {
    throw new Error('offline');
  }) as typeof fetch;
  assert.match((await openRouterUsage('https://router.test/v1', 'k')).error ?? '', /não respondeu/);
});

test('Claude models through OpenRouter get prompt caching, a sticky session and a bounded max_tokens; other models do not', async () => {
  const sent = stub();
  const claude = new OpenAICompatProvider('anthropic/claude-opus-5.5', 'https://router.test/v1', 'k');
  claude.addUser('oi');
  await claude.step(req);
  await claude.step(req);
  assert.deepEqual(sent[0]!.body.cache_control, { type: 'ephemeral' });
  assert.equal(sent[0]!.body.max_tokens, 32_000);
  assert.ok(sent[0]!.body.session_id);
  assert.equal(sent[1]!.body.session_id, sent[0]!.body.session_id);
  const qwen = new OpenAICompatProvider('qwen/qwen3-coder-next', 'https://router.test/v1', 'k');
  qwen.addUser('oi');
  await qwen.step(req);
  assert.equal(sent[2]!.body.cache_control, undefined);
  assert.equal(sent[2]!.body.max_tokens, undefined);
});
