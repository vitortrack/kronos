import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.KRONOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kronos-home-'));
process.env.OLLAMA_HOST = 'http://127.0.0.1:9';
const { startServer } = await import('../desktop/src/server.js');

test('desktop server: token, page, static assets and message bridge', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kronos-root-'));
  const { url, close } = await startServer(root);
  const base = new URL(url);
  const token = base.searchParams.get('t');
  const at = (p: string) => new URL(p, base).href;
  try {
    assert.equal((await fetch(at('/'))).status, 403);
    assert.equal((await fetch(at('/message?t=errado'), { method: 'POST', body: '{}' })).status, 403);

    const page = await fetch(url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /id="composer"/);
    assert.match(html, /src="\/shim.js"[\s\S]*src="\/chat.js"/);

    for (const asset of ['/chat.js', '/chat.css', '/shim.js', '/desktop.css']) assert.equal((await fetch(at(asset))).status, 200, asset);

    const events = await fetch(at(`/events?t=${token}&id=a`));
    const reader = events.body!.pipeThrough(new TextDecoderStream()).getReader();
    assert.equal((await fetch(at(`/message?t=${token}&id=a`), { method: 'POST', body: JSON.stringify({ type: 'ready' }) })).status, 204);
    let received = '';
    while (!received.includes('"type":"skills"')) received += (await reader.read()).value;
    const types = [...received.matchAll(/^data: (.+)$/gm)].map((m) => (JSON.parse(m[1]!) as { type: string }).type);
    assert.deepEqual(types, ['words', 'status', 'models', 'skills']);
    await reader.cancel();
  } finally {
    close();
  }
});
