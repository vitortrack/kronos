import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { installPlugin, pluginRoots, pluginsReport, removePlugin } from '../src/plugins.js';
import { projectDocs } from '../src/prompts.js';
import { findSkills } from '../src/skills.js';

let home = '';
let root = '';
const keys = ['HOME', 'KRONOS_HOME', 'KRONOS_CLAUDE_CONFIG', 'KRONOS_USER_SKILLS'] as const;
let saved: Record<string, string | undefined> = {};

const skill = (dir: string, name: string, description = `${name} skill`): void => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nbody of ${description}\n`);
};

function claudePlugin(id: string): string {
  const dir = path.join(home, '.claude', 'plugins', 'cache', id);
  skill(path.join(dir, 'skills', 'review'), 'review', `claude ${id} review`);
  const file = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  const installed = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { plugins: Record<string, unknown> }) : { plugins: {} };
  installed.plugins[id] = [{ installPath: dir }];
  fs.writeFileSync(file, JSON.stringify(installed));
  return dir;
}

beforeEach(() => {
  saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kronos-plugins-home-'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kronos-plugins-root-'));
  Object.assign(process.env, { HOME: home, KRONOS_HOME: path.join(home, '.kronos') });
  delete process.env.KRONOS_CLAUDE_CONFIG;
  delete process.env.KRONOS_USER_SKILLS;
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('a plugin installed from a folder lives in ~/.kronos/plugins and wins over a Claude Code plugin with the same name', async () => {
  claudePlugin('tools@market');
  claudePlugin('extra@market');
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'kronos-plugin-src-'));
  const folder = path.join(source, 'tools');
  skill(path.join(folder, 'skills', 'review'), 'review', 'kronos tools review');
  fs.mkdirSync(path.join(folder, 'node_modules', 'dep'), { recursive: true });

  assert.match(await installPlugin(folder), /plugin tools instalado/);
  assert.equal(fs.existsSync(path.join(home, '.kronos', 'plugins', 'tools', 'node_modules')), false);
  assert.deepEqual(pluginRoots().map((p) => [p.id, p.source]), [['tools', 'kronos'], ['extra@market', 'claude']]);
  const skills = findSkills(root);
  assert.equal(skills.find((s) => s.name === 'tools:review')!.description, 'kronos tools review');
  assert.match(pluginsReport(skills, []), /\*\*tools\*\* \(Kronos\) — 1 skill\(s\): review\n- \*\*extra@market\*\* \(reserva do Claude Code\)/);

  await assert.rejects(installPlugin(folder), /já está instalado/);
  assert.equal(removePlugin('tools'), 'plugin tools removido');
  assert.throws(() => removePlugin('extra@market'), /removidos pelo Claude Code/);
  assert.throws(() => removePlugin('../etc'), /informe o nome do plugin/);
  assert.throws(() => removePlugin('..'), /informe o nome do plugin/);
  assert.ok(fs.existsSync(path.join(home, '.kronos')));
});

test('a folder that is not a plugin is refused and nothing is left behind', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kronos-not-plugin-'));
  fs.writeFileSync(path.join(folder, 'README.md'), 'hi');
  await assert.rejects(installPlugin(folder), /não parece um plugin/);
  assert.deepEqual(fs.readdirSync(path.join(home, '.kronos', 'plugins')), []);
});

test('skills: project folders first, then Kronos user skills and plugins, then Claude Code as fallback', () => {
  skill(path.join(root, '.claude', 'skills', 'deploy'), 'deploy', 'project claude deploy');
  skill(path.join(root, '.kronos', 'skills', 'deploy'), 'deploy', 'project kronos deploy');
  skill(path.join(home, '.claude', 'skills', 'style'), 'style', 'claude style');
  skill(path.join(home, '.kronos', 'skills', 'style'), 'style', 'kronos style');
  skill(path.join(home, '.claude', 'skills', 'only-claude'), 'only-claude');
  claudePlugin('tools@market');
  const by = (name: string) => findSkills(root).find((s) => s.name === name)?.description;
  assert.equal(by('deploy'), 'project kronos deploy');
  assert.equal(by('style'), 'kronos style');
  assert.equal(by('only-claude'), 'only-claude skill');
  assert.equal(by('tools:review'), 'claude tools@market review');

  process.env.KRONOS_CLAUDE_CONFIG = 'off';
  assert.equal(by('only-claude'), undefined);
  assert.equal(by('tools:review'), undefined);
  assert.equal(by('deploy'), 'project kronos deploy', 'project files are repository content, not Claude Code config');
});

test('user instructions come from ~/.kronos/KRONOS.md, with ~/.claude/CLAUDE.md only as a fallback', () => {
  fs.writeFileSync(path.join(root, 'CLAUDE.local.md'), 'local rule');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'claude user rule');
  assert.match(projectDocs(root), /<file name="~\/\.claude\/CLAUDE\.md">\nclaude user rule/);
  assert.match(projectDocs(root), /<file name="CLAUDE\.local\.md">\nlocal rule/);

  fs.mkdirSync(path.join(home, '.kronos'), { recursive: true });
  fs.writeFileSync(path.join(home, '.kronos', 'KRONOS.md'), 'kronos user rule');
  assert.match(projectDocs(root), /<file name="~\/\.kronos\/KRONOS\.md">\nkronos user rule/);
  assert.doesNotMatch(projectDocs(root), /claude user rule/);

  fs.rmSync(path.join(home, '.kronos', 'KRONOS.md'));
  process.env.KRONOS_CLAUDE_CONFIG = 'off';
  assert.doesNotMatch(projectDocs(root), /claude user rule/);
});
