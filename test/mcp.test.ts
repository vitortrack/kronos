import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { closeMcp, connectMcp, mcpReport, mcpSources, mcpToolName, type McpSource } from '../src/mcp.js';
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
  assert.deepEqual(status, { name: 'fake', origin: 'test', tools: 0, error: 'não aprovado' });
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

test('sources merge Claude Code and Kronos configs, expand variables, and hold project servers until approved', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kronos-mcp-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kronos-mcp-root-'));
  const saved = { HOME: process.env.HOME, KRONOS_HOME: process.env.KRONOS_HOME, KRONOS_MCP: process.env.KRONOS_MCP, TOKEN: process.env.TOKEN };
  Object.assign(process.env, { HOME: home, KRONOS_HOME: path.join(home, '.kronos'), TOKEN: 'abc' });
  delete process.env.KRONOS_MCP;
  try {
    fs.mkdirSync(path.join(home, '.kronos'));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { db: { command: 'node', args: ['db.mjs'] }, shared: { command: 'old' } } }));
    fs.writeFileSync(path.join(home, '.kronos', 'mcp.json'), JSON.stringify({ mcpServers: { shared: { url: 'https://x.test', headers: { authorization: 'Bearer ${TOKEN}' } } } }));
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { repo: { command: 'sh' }, trusted: { command: 'node', args: ['${MISSING:-fallback}'] } } }));
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['trusted'] }));
    const sources = Object.fromEntries(mcpSources(root).map((s) => [s.name, s]));
    assert.deepEqual(Object.keys(sources).sort(), ['db', 'repo', 'shared', 'trusted']);
    assert.equal(sources.shared!.origin, '~/.kronos/mcp.json');
    assert.equal(sources.shared!.config.headers!.authorization, 'Bearer abc');
    assert.match(sources.repo!.blocked ?? '', /não aprovado/);
    assert.equal(sources.trusted!.blocked, undefined);
    assert.deepEqual(sources.trusted!.config.args, ['fallback']);
    process.env.KRONOS_MCP = 'off';
    assert.deepEqual(mcpSources(root), []);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('tool names stay within the provider limit and only use allowed characters', () => {
  assert.equal(mcpToolName('detro-db', 'consultar'), 'mcp__detro-db__consultar');
  assert.equal(mcpToolName('a.b', 'x y'), 'mcp__a_b__x_y');
  assert.equal(mcpToolName('s', 'n'.repeat(100)).length, 64);
});
