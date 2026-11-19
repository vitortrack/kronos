import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { CHAT_BODY, ChatController, type ChatHost, type ChatSettings, type Message } from '../../src/chat-host.js';
import { kronosHome } from '../../src/paths.js';

const HERE = import.meta.dirname;
const STATIC: Record<string, [string, string]> = {
  '/chat.js': [path.join(HERE, '..', '..', 'vscode', 'media', 'chat.js'), 'text/javascript'],
  '/chat.css': [path.join(HERE, '..', '..', 'vscode', 'media', 'chat.css'), 'text/css'],
  '/shim.js': [path.join(HERE, '..', 'media', 'shim.js'), 'text/javascript'],
  '/desktop.css': [path.join(HERE, '..', 'media', 'desktop.css'), 'text/css'],
};

const PAGE = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="/desktop.css">
<link rel="stylesheet" href="/chat.css">
<title>Kronos</title>
</head>
<body>
${CHAT_BODY}
<script src="/shim.js"></script>
<script src="/chat.js"></script>
</body>
</html>`;

type Store = { settings?: Partial<ChatSettings>; sessions?: Record<string, string> };

const storeFile = (): string => path.join(kronosHome(), 'desktop.json');

function loadStore(): Store {
  try {
    return JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as Store;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`${storeFile()} não é um JSON válido: corrija ou apague o arquivo. (${(e as Error).message})`);
  }
}

function updateStore(change: (store: Store) => void): void {
  const store = loadStore();
  change(store);
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  fs.writeFileSync(storeFile(), `${JSON.stringify(store, null, 2)}\n`);
}

function openInEditor(target: string, line: number): void {
  spawn('code', ['-g', `${target}:${line || 1}`], { stdio: 'ignore', detached: true })
    .on('error', () => spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { stdio: 'ignore', detached: true }).on('error', () => {}).unref())
    .unref();
}

function desktopHost(root: string): ChatHost {
  return {
    noRoot: '',
    root: () => root,
    settings: () => ({
      provider: 'auto',
      model: process.env.KRONOS_MODEL ?? '',
      mode: 'ask',
      lang: process.env.KRONOS_LANG ?? 'pt-BR',
      review: false,
      reviewModel: process.env.KRONOS_REVIEW_MODEL ?? '',
      maxSteps: 0,
      ollamaHost: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
      ...loadStore().settings,
    }),
    saveModel: async (provider, model) => updateStore((s) => void (s.settings = { ...s.settings, provider, model })),
    openSessionId: () => loadStore().sessions?.[root],
    rememberSession: (id) =>
      updateStore((s) => {
        const sessions = { ...s.sessions };
        if (id) sessions[root] = id;
        else delete sessions[root];
        s.sessions = sessions;
      }),
    open: async (file, line) => {
      const target = path.resolve(root, file);
      const rel = path.relative(root, target);
      if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(target)) return;
      openInEditor(target, line);
    },
  };
}

async function readJson(request: IncomingMessage): Promise<Message> {
  let body = '';
  for await (const chunk of request) body += chunk;
  return JSON.parse(body || '{}') as Message;
}

export function startServer(root: string, port = 0): Promise<{ url: string; close: () => void }> {
  const token = randomBytes(16).toString('hex');
  const clients = new Map<string, ServerResponse>();
  const send = (client: ServerResponse | undefined, message: Message) => client?.write(`data: ${JSON.stringify(message)}\n\n`);
  const chat = new ChatController(desktopHost(root), (message) => {
    for (const client of clients.values()) send(client, message);
  });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const asset = STATIC[url.pathname];
    if (request.method === 'GET' && asset) {
      response.writeHead(200, { 'content-type': asset[1] });
      fs.createReadStream(asset[0]).pipe(response);
      return;
    }
    if (url.searchParams.get('t') !== token) {
      response.writeHead(403).end();
      return;
    }
    const id = url.searchParams.get('id') ?? '';
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
    } else if (request.method === 'GET' && url.pathname === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(': ok\n\n');
      clients.set(id, response);
      request.on('close', () => clients.delete(id));
    } else if (request.method === 'POST' && url.pathname === '/message') {
      try {
        const message = await readJson(request);
        response.writeHead(204).end();
        await chat.onMessage(message, (reply) => send(clients.get(id), reply));
      } catch (e) {
        if (!response.headersSent) response.writeHead(400).end();
        send(clients.get(id), { type: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    } else {
      response.writeHead(404).end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actual = typeof address === 'object' && address ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${actual}/?t=${token}`,
        close: () => {
          for (const client of clients.values()) client.end();
          server.close();
        },
      });
    });
  });
}
