import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { McpServerStatus } from './mcp.js';
import { kronosHome, readsClaudeConfig } from './paths.js';
import type { Skill } from './skills.js';

const execFileP = promisify(execFile);

export type Plugin = { id: string; root: string; source: 'kronos' | 'claude' };

const PLUGIN_NAME = /^[\w@-][\w.@-]*$/;
const CLONE_TIMEOUT_MS = 120_000;

export const kronosPluginsDir = (): string => path.join(kronosHome(), 'plugins');

export const pluginPrefix = (id: string): string => `${id.split('@')[0]}:`;

const subdirs = (base: string): string[] => {
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(base, e.name))
      .sort();
  } catch {
    return [];
  }
};

function claudePlugins(): Plugin[] {
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: Record<string, Array<{ installPath?: string }>> };
    return Object.entries(installed.plugins ?? {}).flatMap(([id, entries]) => {
      const root = entries[0]?.installPath;
      return root ? [{ id, root, source: 'claude' as const }] : [];
    });
  } catch {
    return [];
  }
}

export function pluginRoots(): Plugin[] {
  const own = subdirs(kronosPluginsDir()).map((root) => ({ id: path.basename(root), root, source: 'kronos' as const }));
  if (!readsClaudeConfig()) return own;
  const taken = new Set(own.map((p) => pluginPrefix(p.id)));
  return [...own, ...claudePlugins().filter((p) => !taken.has(pluginPrefix(p.id)))];
}

const looksLikePlugin = (dir: string): boolean => ['skills', '.mcp.json', '.claude-plugin'].some((entry) => fs.existsSync(path.join(dir, entry)));

export async function installPlugin(from: string): Promise<string> {
  if (!from) throw new Error('informe a URL git ou a pasta do plugin: /plugins instalar <url-ou-pasta>');
  const name = path.basename(from.replace(/\/+$/, '')).replace(/\.git$/, '');
  if (!PLUGIN_NAME.test(name)) throw new Error(`nome de plugin inválido: ${name}`);
  const target = path.join(kronosPluginsDir(), name);
  if (fs.existsSync(target)) throw new Error(`o plugin ${name} já está instalado: remova antes com /plugins remover ${name}`);
  fs.mkdirSync(kronosPluginsDir(), { recursive: true });
  if (fs.existsSync(from)) fs.cpSync(from, target, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
  else await execFileP('git', ['clone', '--depth', '1', from, target], { timeout: CLONE_TIMEOUT_MS });
  if (!looksLikePlugin(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    throw new Error(`${from} não parece um plugin: falta a pasta skills/, o .mcp.json ou o .claude-plugin/`);
  }
  return `plugin ${name} instalado em ${target}`;
}

export function removePlugin(name: string): string {
  if (!PLUGIN_NAME.test(name)) throw new Error('informe o nome do plugin: /plugins remover <nome>');
  const target = path.join(kronosPluginsDir(), name);
  if (!fs.existsSync(target)) throw new Error(`não há plugin ${name} em ${kronosPluginsDir()} (plugins do Claude Code são removidos pelo Claude Code)`);
  fs.rmSync(target, { recursive: true, force: true });
  return `plugin ${name} removido`;
}

const ORIGIN: Record<Plugin['source'], string> = { kronos: 'Kronos', claude: 'reserva do Claude Code' };

export function pluginsReport(skills: Skill[], mcp: McpServerStatus[]): string {
  const plugins = pluginRoots();
  if (!plugins.length) return `Nenhum plugin instalado. Instale com /plugins instalar <url-git-ou-pasta> (fica em ${kronosPluginsDir()}).`;
  const lines = plugins.map(({ id, source }) => {
    const prefix = pluginPrefix(id);
    const own = skills.filter((s) => s.name.startsWith(prefix)).map((s) => s.name.slice(prefix.length));
    const servers = mcp.filter((s) => s.origin === `plugin ${id}`).map((s) => s.name);
    const parts = [`${own.length} skill(s)${own.length ? `: ${own.join(', ')}` : ''}`];
    if (servers.length) parts.push(`MCP: ${servers.join(', ')}`);
    return `- **${id}** (${ORIGIN[source]}) — ${parts.join(' · ')}`;
  });
  return ['Plugins em uso (skills com /<plugin>:<skill>; os do Kronos têm prioridade):', ...lines].join('\n');
}
