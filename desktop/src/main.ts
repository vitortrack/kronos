import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { startServer } from './server.js';

const QUICK_EXIT_MS = 3000;
const HERE = import.meta.dirname;

function openBrowser(url: string): void {
  const opener = ({ darwin: ['open'], win32: ['cmd', '/c', 'start', ''] } as Record<string, string[]>)[process.platform] ?? ['xdg-open'];
  spawn(opener[0]!, [...opener.slice(1), url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

function sandboxFlags(electron: string): string[] {
  if (process.platform !== 'linux') return [];
  try {
    const { uid, mode } = statSync(path.join(path.dirname(electron), 'chrome-sandbox'));
    if (uid === 0 && mode & 0o4000) return [];
  } catch {}
  return ['--no-sandbox'];
}

async function openWindow(url: string, onClose: () => void): Promise<ChildProcess | undefined> {
  const electron = await import('electron').then((m) => m.default as unknown as string, () => null);
  let fellBack = false;
  const fallback = () => {
    if (fellBack) return;
    fellBack = true;
    console.log('Não consegui abrir a janela do aplicativo; abrindo no navegador.');
    openBrowser(url);
  };
  if (!electron) {
    fallback();
    return undefined;
  }
  const startedAt = Date.now();
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
  const window = spawn(electron, [...sandboxFlags(electron), path.join(HERE, '..', 'window.cjs'), url], { stdio: 'ignore', env });
  window.on('error', fallback);
  window.on('exit', () => (Date.now() - startedAt < QUICK_EXIT_MS ? fallback() : onClose()));
  return window;
}

const args = process.argv.slice(2);
const browserOnly = args.includes('--navegador');
const root = path.resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd());
const { url, close } = await startServer(root, Number(process.env.KRONOS_PORT) || 0).catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
console.log(`Kronos — ${root}\n\n  ${url}\n\nFeche a janela ou use Ctrl+C para encerrar.`);
const quit = () => {
  close();
  process.exit(0);
};
const window = browserOnly ? (openBrowser(url), undefined) : await openWindow(url, quit);
process.on('SIGINT', () => {
  window?.kill();
  quit();
});
