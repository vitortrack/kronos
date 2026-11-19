import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentUI } from './agent-ui.js';
import { bestOf } from './attempts.js';
import { mcpCommand } from './mcp.js';
import { orchestrate } from './orchestrator.js';
import { INIT_TASK } from './prompts.js';
import { DEFAULT_MODEL, Session, type Config, type ProviderName } from './session.js';
import { SessionStore } from './sessions.js';
import { findSkills, skillCommand } from './skills.js';
import { THINKING_WORDS } from './thinking-words.js';
import type { Decision, Mode, PlanItem } from './tools.js';
import type { Image, Usage } from './types.js';

const BUILTIN_COMMANDS = [
  { name: 'usage', description: 'tokens, custo e contexto da conversa; no OpenRouter, gasto e saldo da conta' },
  { name: 'compact', description: 'resume o histórico agora para gastar menos tokens (opcional: o que manter em foco)' },
  { name: 'clear', description: 'começa uma conversa nova' },
  { name: 'mcp', description: 'servidores MCP; ligar|desligar <servidor> ou importar (traz os do Claude Code)' },
  { name: 'plugins', description: 'plugins em uso; instalar <url-git-ou-pasta> ou remover <nome>' },
  { name: 'init', description: 'cria ou melhora o AGENTS.md com os comandos e regras do projeto' },
];

export type Message = Record<string, unknown>;
export type Post = (message: Message) => void;
type Pending = Map<string, (decision: Decision) => void>;

const STOP_PREFIXES = ['Interrompido', 'Limite', 'Orçamento', 'O modelo recusou'];

export const CHAT_BODY = `<div id="status"></div>
<div id="plan" hidden></div>
<main id="messages">
  <div class="welcome">
    <h2>Kronos</h2>
    <p>Pergunte sobre o código ou peça uma alteração. Ele investiga, altera, verifica e passa por um revisor independente.</p>
    <p class="hint">Enter envia · Shift+Enter quebra linha · referências <code>arquivo:linha</code> abrem no editor</p>
  </div>
  <div id="working" hidden></div>
</main>
<form id="composer">
  <div id="attachments" hidden></div>
  <div id="slash" role="listbox" hidden></div>
  <textarea id="input" rows="3" placeholder="Pergunte ou peça uma tarefa… (cole um print com Ctrl+V ou arraste arquivos)"></textarea>
  <div class="actions">
    <input type="file" id="file" multiple hidden>
    <button type="button" id="attach" class="secondary" title="Anexar arquivos ou imagens" aria-label="Anexar arquivos">📎</button>
    <label class="toggle"><input type="checkbox" id="orchestrate"> multiagente</label>
    <label class="toggle" title="Roda 3 tentativas isoladas e aplica a que passa nos testes com o menor diff (3× mais tokens)"><input type="checkbox" id="best3"> melhor de 3</label>
    <span class="spacer"></span>
    <select id="model" title="Modelo do Ollama (lista os modelos instalados nesta máquina)" aria-label="Modelo"></select>
    <button type="button" id="stop" hidden>Parar</button>
    <button type="submit" id="send">Enviar</button>
  </div>
</form>`;

class ChatUI implements AgentUI {
  constructor(
    private readonly post: Post,
    private readonly pending: Pending,
    private readonly agent = '',
  ) {}

  readonly text = (delta: string): void => {
    if (!this.agent && delta) this.post({ type: 'text', delta });
  };

  readonly thinking = (delta: string): void => {
    if (!this.agent) this.post({ type: 'thinking', delta });
  };

  stepUsage(usage: Usage): void {
    if (!this.agent) this.post({ type: 'step-usage', input: usage.input, output: usage.output });
  }

  tool(name: string, args: string): void {
    this.post({ type: 'tool', agent: this.agent, name, args });
  }

  observation(ok: boolean, output: string): void {
    this.post({ type: 'observation', agent: this.agent, ok, output: output.slice(0, 6000) });
  }

  plan(items: PlanItem[]): void {
    this.post({ type: 'plan', items });
  }

  phase(title: string): void {
    this.post({ type: 'phase', title });
  }

  info(message: string): void {
    this.post({ type: 'info', agent: this.agent, message });
  }

  warn(message: string): void {
    this.post({ type: 'warn', agent: this.agent, message });
  }

  error(message: string): void {
    this.post({ type: 'error', message });
  }

  final(text: string): void {
    this.post({ type: 'final', text });
  }

  confirm(question: string, signal: AbortSignal, alwaysLabel?: string): Promise<Decision> {
    const id = randomUUID();
    this.post({ type: 'confirm', id, question, agent: this.agent, alwaysLabel: alwaysLabel ?? null });
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        this.post({ type: 'confirmClosed', id });
        reject(new Error('Interrompido pelo usuário.'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, (decision) => {
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        resolve(decision);
      });
    });
  }

  child(label: string): AgentUI {
    return new ChatUI(this.post, this.pending, label);
  }
}

export interface ChatSettings {
  provider: string;
  model: string;
  mode: Mode;
  lang: string;
  review: boolean;
  reviewModel: string;
  maxSteps: number;
  ollamaHost: string;
}

export interface ChatHost {
  readonly noRoot: string;
  root(): string | undefined;
  settings(): ChatSettings;
  saveModel(provider: ProviderName, model: string): Promise<void>;
  openSessionId(): string | undefined;
  rememberSession(id: string | undefined): void;
  open(file: string, line: number): Promise<void>;
}

const hasAnthropicKey = (): boolean => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const CLAUDE_MODELS = hasAnthropicKey() ? ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] : [];
const OPENROUTER_MODELS = process.env.OPENROUTER_API_KEY ? [DEFAULT_MODEL.openai, 'z-ai/glm-5.2', 'anthropic/claude-opus-5.5'] : [];

function readConfig(root: string, s: ChatSettings): Config {
  const provider: ProviderName = s.provider === 'ollama' || s.provider === 'anthropic' || s.provider === 'openai' ? s.provider : hasAnthropicKey() ? 'anthropic' : 'ollama';
  process.env.OLLAMA_HOST = s.ollamaHost;
  return {
    provider,
    model: s.model || DEFAULT_MODEL[provider],
    mode: s.mode,
    root,
    maxSteps: s.maxSteps,
    reviewModel: s.reviewModel || undefined,
    review: s.review || Boolean(s.reviewModel),
    effort: 'high',
    numCtx: 65536,
    tokenBudget: 0,
    lang: s.lang,
    interactive: true,
    logDir: Session.defaultLogDir(),
  };
}

const statusText = (cfg: Config): string => `${cfg.provider} · ${cfg.model} · ${cfg.mode}`;

type Attachment = { name: string; mime: string; data: string };

function saveAttachments(root: string, list: Attachment[]): { lines: string[]; images: Image[] } {
  const dir = path.join(root, '.kronos', 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
  const lines = list.map((a) => {
    const file = path.join(dir, `${Date.now()}-${path.basename(a.name).replace(/[^\w.-]/g, '_')}`);
    fs.writeFileSync(file, Buffer.from(a.data, 'base64'));
    return `- ${path.relative(root, file)} (${a.mime || 'tipo desconhecido'})`;
  });
  return { lines, images: list.filter((a) => a.mime.startsWith('image/')).map((a) => ({ mime: a.mime, data: a.data })) };
}

async function hasVision(model: string): Promise<boolean> {
  try {
    const res = await fetch(`${process.env.OLLAMA_HOST}/api/show`, { method: 'POST', body: JSON.stringify({ model }) });
    return ((await res.json()) as { capabilities?: string[] }).capabilities?.includes('vision') ?? false;
  } catch {
    return false;
  }
}

async function localModels(current: string): Promise<string[]> {
  try {
    const res = await fetch(`${process.env.OLLAMA_HOST}/api/tags`);
    const body = (await res.json()) as { models?: { name: string; details?: { family?: string } }[] };
    const names = (body.models ?? []).filter((m) => !/embed/i.test(m.name) && !/bert/i.test(m.details?.family ?? '')).map((m) => m.name);
    return [...new Set([current, ...names, ...CLAUDE_MODELS, ...OPENROUTER_MODELS])].sort();
  } catch {
    return [...new Set([current, ...CLAUDE_MODELS, ...OPENROUTER_MODELS])].sort();
  }
}

export class ChatController {
  private session: Session | undefined;
  private plainRun = false;
  private readonly pending: Pending = new Map();

  constructor(
    private readonly host: ChatHost,
    private readonly post: Post,
  ) {}

  newChat(): void {
    this.session?.abort();
    this.session = undefined;
    this.host.rememberSession(undefined);
    this.post({ type: 'cleared' });
  }

  private restore(root: string, post: Post): void {
    const id = this.host.openSessionId();
    if (!this.session && id) {
      const saved = new SessionStore(root).load(id);
      const session = saved && this.ensureSession();
      if (saved && session && session.resume(saved) !== null) this.session = undefined;
    }
    const session = this.session;
    if (session?.turns.length) post({ type: 'restored', id: session.id, turns: session.turns, plan: session.plan });
  }

  private ensureSession(): Session | null {
    const root = this.host.root();
    if (!root) {
      this.post({ type: 'error', message: this.host.noRoot });
      return null;
    }
    const cfg = readConfig(root, this.host.settings());
    const current = this.session?.cfg;
    if (!this.session || current?.root !== root || current.provider !== cfg.provider || current.model !== cfg.model) {
      const previous = this.session;
      this.session = new Session(cfg, new ChatUI(this.post, this.pending));
      if (previous?.turns.length && current?.root === root && current.provider === cfg.provider) {
        previous.save();
        const saved = previous.sessions.load(previous.id);
        if (saved) this.session.resume(saved);
        for (const name of previous.activeSkills) this.session.activeSkills.add(name);
      }
    } else {
      Object.assign(this.session.cfg, { mode: cfg.mode, lang: cfg.lang, review: cfg.review, reviewModel: cfg.reviewModel, maxSteps: cfg.maxSteps });
    }
    return this.session;
  }

  async onMessage(m: Message, reply: Post): Promise<void> {
    switch (m.type) {
      case 'ready': {
        reply({ type: 'words', words: THINKING_WORDS });
        const root = this.host.root();
        if (root) {
          const cfg = readConfig(root, this.host.settings());
          reply({ type: 'status', text: statusText(cfg) });
          reply({ type: 'models', models: await localModels(cfg.model), current: cfg.model });
          reply({ type: 'skills', skills: [...BUILTIN_COMMANDS, ...findSkills(root).map(({ name, description }) => ({ name, description }))] });
          this.restore(root, reply);
        }
        return;
      }
      case 'setModel':
        return this.setModel(String(m.model ?? ''));
      case 'send':
        return this.send(String(m.text ?? ''), m.orchestrate === true, m.best3 === true, Array.isArray(m.attachments) ? (m.attachments as Attachment[]) : []);
      case 'stop':
        this.session?.abort();
        return;
      case 'confirmResult':
        this.pending.get(String(m.id))?.(m.decision === 'always' ? 'always' : m.decision === 'yes' ? 'yes' : 'no');
        return;
      case 'open':
        return this.host.open(String(m.file), Number(m.line));
      case 'newChat':
        this.newChat();
        return;
    }
  }

  private async setModel(model: string): Promise<void> {
    const root = this.host.root();
    if (!model || !root || this.session?.busy) return;
    const provider: ProviderName = CLAUDE_MODELS.includes(model) ? 'anthropic' : OPENROUTER_MODELS.includes(model) ? 'openai' : 'ollama';
    await this.host.saveModel(provider, model);
    if (this.session) this.ensureSession();
    this.post({ type: 'status', text: statusText(readConfig(root, this.host.settings())) });
  }

  private async send(text: string, viaOrchestrator: boolean, best3: boolean, attachments: Attachment[]): Promise<void> {
    let task = text.trim();
    if (!task && !attachments.length) return;
    const session = this.ensureSession();
    if (!session) return;
    const [, command = '', arg = ''] = /^\/(\w+)\s*([\s\S]*)$/.exec(task) ?? [];
    const builtin = this.commands[command];
    if (builtin && !attachments.length) return builtin(session, arg.trim());
    if (command === 'init') task = INIT_TASK;
    task = skillCommand(session.skills, session.activeSkills, task) ?? task;
    if (session.busy) {
      if (!this.plainRun || attachments.length || viaOrchestrator || best3) {
        this.post({ type: 'warn', message: 'Aguarde a tarefa atual terminar ou clique em Parar.' });
        return;
      }
      session.queue(task);
      this.post({ type: 'info', message: 'Mensagem entregue ao agente no próximo passo.' });
      return;
    }
    const { lines, images } = saveAttachments(session.cfg.root, attachments);
    if (lines.length) task = `${task || 'Analise os arquivos anexados.'}\n\nFiles attached by the user (read them; images are also shown to you when the model has vision; for a PDF run: pdftotext <file> -):\n${lines.join('\n')}`;
    if (images.length && session.cfg.provider === 'ollama' && !(await hasVision(session.cfg.model))) {
      this.post({ type: 'warn', message: `O modelo ${session.cfg.model} não lê imagens: ele recebe só o caminho do arquivo. Para interpretar o print, escolha um modelo com visão no seletor (ex.: glm-5.3-flash:cloud).` });
    }
    this.post({ type: 'status', text: statusText(session.cfg) });
    this.post({ type: 'busy', value: true });
    const start = { ...session.usage };
    const tokens = () => this.post({ type: 'tokens', input: session.usage.input - start.input, output: session.usage.output - start.output });
    const timer = setInterval(tokens, 1000);
    let report: Message;
    try {
      let out: string;
      if (viaOrchestrator) out = await orchestrate(session, task);
      else if (best3) {
        const result = await session.track(() => bestOf(session.cfg, session.ui, task, 3, undefined, session.signal));
        session.addUsage(result.usage);
        out = result.answer;
      } else {
        this.plainRun = true;
        out = await session.run(task, images).finally(() => (this.plainRun = false));
        this.host.rememberSession(session.id);
      }
      if (STOP_PREFIXES.some((p) => out.startsWith(p))) report = { type: 'warn', message: out };
      else report = { type: 'answer', text: out };
    } catch (e) {
      report = { type: 'error', message: e instanceof Error ? e.message : String(e) };
    }
    clearInterval(timer);
    tokens();
    this.post(report);
    this.post({ type: 'usage', input: session.usage.input, output: session.usage.output, cost: session.costUsd() });
    this.post({ type: 'busy', value: false });
    const leftover = session.takeQueued();
    if (leftover.length && report.type === 'answer') await this.send(leftover.join('\n\n'), false, false, []);
  }

  private readonly commands: Record<string, (session: Session, arg: string) => Promise<void>> = {
    usage: async (session) => {
      this.post({ type: 'usage', input: session.usage.input, output: session.usage.output, cost: session.costUsd() });
      this.post({ type: 'usage-panel', ...(await session.usageReport()) });
    },
    compact: (session, arg) => this.compact(session, arg),
    clear: async () => this.newChat(),
    mcp: async (session, arg) => this.post({ type: 'final', text: await mcpCommand(session.cfg.root, arg) }),
    plugins: async (session, arg) => {
      this.post({ type: 'final', text: await session.plugins(arg) });
      this.post({ type: 'skills', skills: [...BUILTIN_COMMANDS, ...session.skills.map(({ name, description }) => ({ name, description }))] });
    },
  };

  private async compact(session: Session, focus: string): Promise<void> {
    if (session.busy) {
      this.post({ type: 'warn', message: 'Aguarde a tarefa atual terminar para compactar.' });
      return;
    }
    this.post({ type: 'busy', value: true });
    try {
      const done = await session.compact(focus || undefined);
      if (done === null) this.post({ type: 'warn', message: 'Este provedor não tem compactação manual.' });
      else if (done) this.post({ type: 'info', message: 'Histórico resumido: os próximos passos enviam menos tokens.' });
      else this.post({ type: 'info', message: 'Nada a compactar ainda.' });
    } catch (e) {
      this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
    this.post({ type: 'busy', value: false });
  }
}
