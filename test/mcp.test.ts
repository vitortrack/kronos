import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { closeMcp, connectMcp, mcpCommand, mcpReport, mcpSources, mcpToolName, type McpSource } from '../src/mcp.js';
import type { ToolContext } from '../src/tools.js';

const fixture = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'fake-mcp.mjs');
const ctx = { signal: new AbortController().signal } as ToolContext;
after(closeMcp);

const fake = (env: Record<string, string> = {}): McpSource => ({ name: 'fake', origin: 'test', config: { command: process.execPath, args: [fixture], env: { FAKE_LABEL: 'stdio', ...env } } });

test('a stdio server answers its ping, lists every page of tools, and its tools run through the agent tool interface', async () => {
  const { status, tools } = await connectMcp(fake(), os.tmpdir());
  assert.deepEqual(status, { name: 'fake', origin: 'test', tools: 2 });
  assert.deepEqual(tools.map((t) => [t.name, t.readOnly, t.group]), [
    ['mcp__fake__echo', false, 'mcp:fake'],
    ['mcp__fake__fail', true, 'mcp:fake'],
  ]);
  assert.deepEqual(tools[0]!.schema.required, ['text']);
  assert.equal(await tools[0]!.run({ text: 'oi' }, ctx), 'echo oi from stdio');
  await assert.rejects(tools[1]!.run({}, ctx), /boom/);
});

test('a server that cannot start is reported with its error instead of breaking the session', async () => {
  const { status, tools } = await connectMcp({ name: 'ghost', origin: 'test', config: { command: '/no/such/binary' } }, os.tmpdir());
  assert.equal(tools.length, 0);
  assert.match(status.error ?? '', /ENOENT/);
  assert.match(mcpReport({ tools: [], servers: [status] }), /\*\*ghost\*\* \(test\): falhou/);
});

test('a blocked source never starts its command', async () => {
  const { status } = await connectMcp({ ...fake(), blocked: 'não aprovado' }, os.tmpdir());
  assert.deepEqual(status, { name: 'fake', origin: 'test', tools: 0, error: 'não aprovado', blocked: true });
  assert.match(mcpReport({ tools: [], servers: [status] }), /\*\*fake\*\* \(test\): bloqueado — não aprovado/);
});

test('an http server keeps its session id and may answer as an event stream', async () => {
  const sent: Array<{ method?: string; session: string | null }> = [];
  globalThis.fetch = (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    const body = JSON.parse(init.body) as { id?: number; method?: string };
    sent.push({ method: body.method, session: init.headers['mcp-session-id'] ?? null });
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: {} }, { headers: { 'mcp-session-id': 's-1' } });
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result = body.method === 'tools/list' ? { tools: [{ name: 'q', inputSchema: { type: 'object', properties: {} } }] } : { content: [{ type: 'text', text: 'rows' }] };
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const { tools } = await connectMcp({ name: 'web', origin: 'test', config: { type: 'http', url: 'https://mcp.test/x' } }, os.tmpdir());
  assert.equal(await tools[0]!.run({}, ctx), 'rows');
  assert.deepEqual(sent, [
    { method: 'initialize', session: null },
    { method: 'notifications/initialized', session: 's-1' },
    { method: 'tools/list', session: 's-1' },
    { method: 'tools/call', session: 's-1' },
  ]);
});

function sandbox(): { home: string; root: string; restore(): void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kronos-mcp-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kronos-mcp-root-'));
  const keys = ['HOME', 'KRONOS_HOME', 'KRONOS_MCP', 'KRONOS_CLAUDE_CONFIG', 'TOKEN'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { HOME: home, KRONOS_HOME: path.join(home, '.kronos'), TOKEN: 'abc' });
  delete process.env.KRONOS_MCP;
  delete process.env.KRONOS_CLAUDE_CONFIG;
  fs.mkdirSync(path.join(home, '.kronos'));
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return { home, root, restore };
}

const write = (file: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

test('Kronos configs win over Claude Code ones, which fill in what Kronos does not have', () => {
  const { home, root, restore } = sandbox();
  try {
    write(path.join(home, '.claude.json'), { mcpServers: { db: { command: 'node', args: ['db.mjs'] }, shared: { command: 'claude-version' } } });
    write(path.join(home, '.kronos', 'mcp.json'), { mcpServers: { shared: { url: 'https://x.test', headers: { authorization: 'Bearer ${TOKEN}' } } } });
    write(path.join(root, '.kronos', 'mcp.json'), { mcpServers: { local: { command: 'node', args: ['${MISSING:-fallback}'] } } });
    write(path.join(root, '.mcp.json'), { mcpServers: { repo: { command: 'sh' }, trusted: { command: 'node' } } });
    write(path.join(root, '.claude', 'settings.local.json'), { enabledMcpjsonServers: ['trusted'] });
    const sources = Object.fromEntries(mcpSources(root).map((s) => [s.name, s]));
    assert.deepEqual(Object.keys(sources).sort(), ['db', 'local', 'repo', 'shared', 'trusted']);
    assert.equal(sources.shared!.origin, '~/.kronos/mcp.json');
    assert.equal(sources.shared!.config.headers!.authorization, 'Bearer abc');
    assert.equal(sources.db!.origin, '~/.claude.json');
    assert.match(sources.local!.blocked ?? '', /\/mcp ligar local/);
    assert.deepEqual(sources.local!.config.args, ['fallback']);
    assert.match(sources.repo!.blocked ?? '', /não aprovado/);
    assert.equal(sources.trusted!.blocked, undefined, 'an approval made in Claude Code still counts as a fallback');

    process.env.KRONOS_CLAUDE_CONFIG = 'off';
    const own = Object.fromEntries(mcpSources(root).map((s) => [s.name, s]));
    assert.deepEqual(Object.keys(own).sort(), ['local', 'repo', 'shared', 'trusted']);
    assert.match(own.trusted!.blocked ?? '', /não aprovado/);
    process.env.KRONOS_MCP = 'off';
    assert.deepEqual(mcpSources(root), []);
  } finally {
    restore();
  }
});

test('/mcp ligar approves a project server, desligar turns any server off, and both are kept by Kronos', async () => {
  const { home, root, restore } = sandbox();
  try {
    write(path.join(root, '.kronos', 'mcp.json'), { mcpServers: { local: { command: '/no/such/binary' } } });
    write(path.join(home, '.kronos', 'mcp.json'), { mcpServers: { other: { command: '/no/such/binary' } } });
    assert.match(await mcpCommand(root, 'ligar local'), /^local ligado neste projeto\./);
    assert.equal(mcpSources(root).find((s) => s.name === 'local')!.blocked, undefined);
    assert.match(await mcpCommand(root, 'desligar other'), /other desligado neste projeto/);
    assert.match(mcpSources(root).find((s) => s.name === 'other')!.blocked ?? '', /desligado neste projeto/);
    const state = JSON.parse(fs.readFileSync(path.join(home, '.kronos', 'mcp-state.json'), 'utf8')) as { projects: Record<string, unknown> };
    assert.deepEqual(state.projects[root], { enabled: ['local'], disabled: ['other'] });
    assert.match(await mcpCommand(root, 'ligar nenhum'), /não há servidor MCP chamado "nenhum"/);
    assert.match(await mcpCommand(root, 'apagar x'), /use \/mcp, \/mcp ligar/);
  } finally {
    closeMcp();
    restore();
  }
});

test('/mcp importar copies the Claude Code servers once, unexpanded and without overwriting Kronos ones', async () => {
  const { home, root, restore } = sandbox();
  try {
    write(path.join(home, '.claude.json'), { mcpServers: { db: { command: 'node', env: { URL: '${DATABASE_URL}' } }, shared: { command: 'claude-version' } } });
    write(path.join(home, '.kronos', 'mcp.json'), { mcpServers: { shared: { command: 'kronos-version' } } });
    process.env.KRONOS_MCP = 'off';
    const message = await mcpCommand(root, 'importar');
    assert.match(message, /importados para ~\/.kronos\/mcp.json: db; já existiam no Kronos e ficaram como estavam: shared/);
    const file = path.join(home, '.kronos', 'mcp.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mcpServers: { shared: { command: 'kronos-version' }, db: { command: 'node', env: { URL: '${DATABASE_URL}' } } } });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.match(await mcpCommand(root, 'importar'), /nenhum servidor novo/);
  } finally {
    closeMcp();
    restore();
  }
});

test('tool names stay within the provider limit and only use allowed characters', () => {
  assert.equal(mcpToolName('detro-db', 'consultar'), 'mcp__detro-db__consultar');
  assert.equal(mcpToolName('a.b', 'x y'), 'mcp__a_b__x_y');
  assert.equal(mcpToolName('s', 'n'.repeat(100)).length, 64);
});
