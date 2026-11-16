import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenAICompatProvider } from '../src/providers/openai.js';
import type { StepRequest } from '../src/types.js';

type Sent = { url: string; auth: string; body: { stream: boolean; messages: { role: string; content: string | null; tool_call_id?: string; tool_calls?: { id: string; function: { arguments: string } }[] }[] } };

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
