import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { kronosHome } from './paths.js';
import { sseData } from './providers/openai.js';
import { pluginRoots } from './skills.js';
import type { Tool } from './tools.js';
import type { ToolSpec } from './types.js';

export interface McpServerConfig {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpSource {
  name: string;
  origin: string;
  config: McpServerConfig;
  blocked?: string;
}

export interface McpServerStatus {
  name: string;
  origin: string;
  tools: number;
  error?: string;
}

export interface McpHub {
  tools: Tool[];
  servers: McpServerStatus[];
}

type JsonRpc = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
type McpToolInfo = { name: string; description?: string; inputSchema?: Partial<ToolSpec['schema']>; annotations?: { readOnlyHint?: boolean } };
type CallResult = { content?: Array<{ type: string; text?: string; resource?: { uri?: string; text?: string } }>; structuredContent?: unknown; isError?: boolean };
type ServerMap = Record<string, McpServerConfig>;
type ClaudeProject = { mcpServers?: ServerMap; enabledMcpjsonServers?: string[]; disabledMcpjsonServers?: string[]; enableAllProjectMcpServers?: boolean };
type ClaudeJson = { mcpServers?: ServerMap; projects?: Record<string, ClaudeProject> };

const PROTOCOL = '2025-06-18';
const CONNECT_TIMEOUT_MS = 20_000;
const MAX_DESCRIPTION = 1_000;
const MAX_NAME = 64;

interface Transport {
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): void;
}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const serversIn = (json: unknown): ServerMap => (json as { mcpServers?: ServerMap } | null)?.mcpServers ?? {};

const expand = (value: string, vars: Record<string, string | undefined>): string =>
  value.replace(/\$\{([A-Za-z_]\w*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => vars[name] ?? fallback ?? '');

const expandConfig = (config: McpServerConfig, vars: Record<string, string | undefined>): McpServerConfig =>
  JSON.parse(JSON.stringify(config), (_, v: unknown) => (typeof v === 'string' ? expand(v, vars) : v)) as McpServerConfig;

function projectApproval(root: string, claude: ClaudeJson | null): (name: string) => boolean {
  const settings = [claude?.projects?.[root], readJson(path.join(root, '.claude', 'settings.json')), readJson(path.join(root, '.claude', 'settings.local.json'))] as Array<ClaudeProject | null | undefined>;
  return (name) => {
    if (settings.some((s) => s?.disabledMcpjsonServers?.includes(name))) return false;
    return settings.some((s) => s?.enableAllProjectMcpServers === true || s?.enabledMcpjsonServers?.includes(name));
  };
}

export function mcpSources(root: string): McpSource[] {
  if (process.env.KRONOS_MCP === 'off') return [];
  const claude = readJson(path.join(os.homedir(), '.claude.json')) as ClaudeJson | null;
  const approved = projectApproval(root, claude);
  const layers: Array<{ origin: string; servers: ServerMap; vars: Record<string, string | undefined>; needsApproval?: boolean }> = [
    ...pluginRoots().map((p) => ({ origin: `plugin ${p.id}`, servers: serversIn(readJson(path.join(p.root, '.mcp.json'))), vars: { ...process.env, CLAUDE_PLUGIN_ROOT: p.root } })),
    { origin: '~/.claude.json', servers: claude?.mcpServers ?? {}, vars: process.env },
    { origin: '~/.kronos/mcp.json', servers: serversIn(readJson(path.join(kronosHome(), 'mcp.json'))), vars: process.env },
    { origin: '.mcp.json', servers: serversIn(readJson(path.join(root, '.mcp.json'))), vars: process.env, needsApproval: true },
    { origin: '~/.claude.json (projeto)', servers: claude?.projects?.[root]?.mcpServers ?? {}, vars: process.env },
  ];
  const found = new Map<string, McpSource>();
  for (const { origin, servers, vars, needsApproval } of layers) {
    for (const [name, config] of Object.entries(servers)) {
      const source: McpSource = { name, origin, config: expandConfig(config, vars) };
      if (needsApproval && !approved(name)) source.blocked = 'servidor do .mcp.json do projeto ainda não aprovado: aprove no Claude Code (/mcp) ou copie a entrada para ~/.kronos/mcp.json';
      found.set(name, source);
    }
  }
  return [...found.values()];
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    onAbort();
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

class StdioTransport implements Transport {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private next = 1;
  private stderr = '';
  private closed: Error | null = null;

  constructor(config: McpServerConfig, cwd: string) {
    this.child = spawn(config.command ?? '', config.args ?? [], { cwd, env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr?.on('data', (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-2000)));
    this.child.on('error', (e) => this.fail(e));
    this.child.on('exit', (code) => this.fail(new Error(`o processo saiu (código ${code})${this.stderr.trim() ? `: ${this.stderr.trim().split('\n').at(-1)}` : ''}`)));
    createInterface({ input: this.child.stdout! }).on('line', (line) => this.receive(line));
  }

  private fail(e: Error): void {
    this.closed ??= e;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  private write(message: JsonRpc): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: JsonRpc;
    try {
      message = JSON.parse(line) as JsonRpc;
    } catch {
      return;
    }
    if (message.method && message.id !== undefined) {
      if (message.method === 'ping') this.write({ jsonrpc: '2.0', id: message.id, result: {} });
      else this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not supported: ${message.method}` } });
      return;
    }
    const waiting = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
    if (!waiting) return;
    this.pending.delete(message.id as number);
    if (message.error) waiting.reject(new Error(message.error.message));
    else waiting.resolve(message.result);
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.next++;
    const answer = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.write({ jsonrpc: '2.0', id, method, params });
    return abortable(answer, signal, () => {
      this.pending.delete(id);
      this.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  close(): void {
    this.child.stdin?.end();
    this.child.kill();
  }
}

async function* sseMessages(res: Response): AsyncGenerator<JsonRpc> {
  for await (const data of sseData(res)) {
    try {
      yield JSON.parse(data) as JsonRpc;
    } catch {
      continue;
    }
  }
}

class HttpTransport implements Transport {
  private sessionId: string | undefined;
  private next = 1;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  private async post(body: JsonRpc, signal?: AbortSignal): Promise<Response> {
    const res = await fetch(this.url, {
      method: 'POST',
      signal: signal ?? null,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL,
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify(body),
    });
    this.sessionId = res.headers.get('mcp-session-id') ?? this.sessionId;
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res;
  }

  async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.next++;
    const res = await this.post({ jsonrpc: '2.0', id, method, params }, signal);
    const stream = res.headers.get('content-type')?.includes('text/event-stream');
    const messages: AsyncIterable<JsonRpc> | JsonRpc[] = stream ? sseMessages(res) : [(await res.json()) as JsonRpc];
    for await (const message of messages) {
      if (message.id !== id) continue;
      if (message.error) throw new Error(message.error.message);
      return message.result;
    }
    throw new Error(`o servidor não respondeu a ${method}`);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const res = await this.post({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
    await res.body?.cancel();
  }

  close(): void {}
}

function transportFor(config: McpServerConfig, root: string): Transport {
  if (config.type === 'sse') throw new Error('transporte "sse" antigo não suportado: use "http" (streamable HTTP)');
  if (config.url) return new HttpTransport(config.url, config.headers);
  if (config.command) return new StdioTransport(config, root);
  throw new Error('configuração sem "command" nem "url"');
}

export const mcpToolName = (server: string, tool: string): string => `mcp__${server}__${tool}`.replace(/[^\w-]/g, '_').slice(0, MAX_NAME);

function resultText(result: CallResult): string {
  const parts = (result.content ?? []).map((c) => {
    if (c.type === 'text') return c.text ?? '';
    if (c.type === 'resource') return c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`;
    return `[${c.type} omitted]`;
  });
  const text = parts.join('\n').trim();
  if (text || result.structuredContent === undefined) return text;
  return JSON.stringify(result.structuredContent);
}

function toTool(server: string, info: McpToolInfo, transport: Transport): Tool {
  return {
    name: mcpToolName(server, info.name),
    readOnly: info.annotations?.readOnlyHint === true,
    group: `mcp:${server}`,
    description: `[MCP ${server}] ${info.description ?? info.name}`.slice(0, MAX_DESCRIPTION),
    schema: { type: 'object', properties: {}, required: [], ...info.inputSchema } as ToolSpec['schema'],
    async run(input, ctx) {
      const result = (await transport.request('tools/call', { name: info.name, arguments: input }, ctx.signal)) as CallResult;
      const text = resultText(result);
      if (result.isError) throw new Error(text || `${info.name} falhou sem mensagem`);
      return text || '(no output)';
    },
  };
}

const open: Transport[] = [];
const hubs = new Map<string, Promise<McpHub>>();

export function closeMcp(): void {
  for (const t of open.splice(0)) t.close();
  hubs.clear();
}

process.once('exit', closeMcp);

export async function connectMcp(source: McpSource, root: string): Promise<{ status: McpServerStatus; tools: Tool[] }> {
  const { name, origin } = source;
  if (source.blocked) return { status: { name, origin, tools: 0, error: source.blocked }, tools: [] };
  let transport: Transport | undefined;
  try {
    transport = transportFor(source.config, root);
    await transport.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'kronos', version: '0.1.0' } }, AbortSignal.timeout(CONNECT_TIMEOUT_MS));
    await transport.notify('notifications/initialized');
    const infos: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = (await transport.request('tools/list', cursor ? { cursor } : {}, AbortSignal.timeout(CONNECT_TIMEOUT_MS))) as { tools?: McpToolInfo[]; nextCursor?: string };
      infos.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor);
    open.push(transport);
    const connected = transport;
    return { status: { name, origin, tools: infos.length }, tools: infos.map((i) => toTool(name, i, connected)) };
  } catch (e) {
    transport?.close();
    const message = e instanceof Error ? e.message : String(e);
    return { status: { name, origin, tools: 0, error: message }, tools: [] };
  }
}

export function mcpHub(root: string): Promise<McpHub> {
  let hub = hubs.get(root);
  if (!hub) {
    hub = Promise.all(mcpSources(root).map((s) => connectMcp(s, root))).then((all) => ({ servers: all.map((a) => a.status), tools: all.flatMap((a) => a.tools) }));
    hubs.set(root, hub);
  }
  return hub;
}

function serverLine(s: McpServerStatus): string {
  if (s.error) return `- **${s.name}** (${s.origin}): falhou — ${s.error}`;
  return `- **${s.name}** (${s.origin}): ${s.tools} ferramenta(s)`;
}

export function mcpReport(hub: McpHub): string {
  if (!hub.servers.length) return 'Nenhum servidor MCP configurado. O Kronos lê o .mcp.json do projeto, o ~/.kronos/mcp.json e os servidores do Claude Code (~/.claude.json e plugins).';
  return ['Servidores MCP (as ferramentas entram quando o agente carrega o grupo mcp:<servidor>):', ...hub.servers.map(serverLine)].join('\n');
}
