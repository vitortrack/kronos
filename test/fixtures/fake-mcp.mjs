import { createInterface } from 'node:readline';

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
let initializeId = null;

const handlers = {
  initialize: (id) => {
    initializeId = id;
    send({ id: 'server-ping', method: 'ping' });
  },
  'tools/list': (id, params) => {
    if (!params?.cursor) send({ id, result: { tools: [{ name: 'echo', description: 'Echoes the arguments', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }], nextCursor: 'page-2' } });
    else send({ id, result: { tools: [{ name: 'fail', description: 'Always fails', annotations: { readOnlyHint: true } }] } });
  },
  'tools/call': (id, params) => {
    if (params.name === 'echo') send({ id, result: { content: [{ type: 'text', text: `echo ${params.arguments.text} from ${process.env.FAKE_LABEL}` }] } });
    else send({ id, result: { content: [{ type: 'text', text: 'boom' }], isError: true } });
  },
};

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === 'server-ping' && message.result) {
    send({ id: initializeId, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
    return;
  }
  handlers[message.method]?.(message.id, message.params);
});
