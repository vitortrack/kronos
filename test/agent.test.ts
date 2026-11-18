import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { renderMarkdownLine } from '../src/markdown.js';
import { closeMcp } from '../src/mcp.js';
import type { Judge } from '../src/contract.js';
import { orchestrate } from '../src/orchestrator.js';
import { systemPrompt } from '../src/prompts.js';
import { parseInlineToolCalls } from '../src/providers/ollama.js';
import { Session, type Config } from '../src/session.js';
import { allTools, cleanPath, isDangerous, safePath, suggestPath } from '../src/tools.js';
import type { Provider, StepRequest, StepResult, ToolResult } from '../src/types.js';
import { UI } from '../src/ui.js';
import { validateInput } from '../src/validate.js';

type Script = (seen: { user: string[]; results: ToolResult[][]; system: string }) => StepResult;

class ScriptedProvider implements Provider {
  readonly user: string[] = [];
  readonly results: ToolResult[][] = [];
  private turn = 0;
  constructor(private readonly script: Script[]) {}
  addUser(text: string): void {
    this.user.push(text);
  }
  addToolResults(results: ToolResult[]): void {
    this.results.push(results);
  }
  snapshot(): unknown {
    return { user: this.user, results: this.results };
  }
  restore(state: unknown): void {
    const s = state as { user?: string[]; results?: ToolResult[][] };
    this.user.splice(0, this.user.length, ...(s.user ?? []));
    this.results.splice(0, this.results.length, ...(s.results ?? []));
  }
  async step(req: StepRequest): Promise<StepResult> {
    const next = this.script[this.turn++];
    if (!next) throw new Error('script exhausted');
    return next({ user: this.user, results: this.results, system: req.system });
  }
}

const usage = { input: 10, output: 5 };
const call = (name: string, input: Record<string, unknown>): StepResult => ({
  text: '',
  toolCalls: [{ id: `${name}-${Math.random()}`, name, input }],
  stop: 'tool_use',
  usage,
});
const answer = (text: string): StepResult => ({ text, toolCalls: [], stop: 'end', usage });

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kronos-test-'));
}

function config(root: string, overrides: Partial<Config> = {}): Config {
  return {
    provider: 'ollama',
    model: 'mock',
    mode: 'auto',
    root,
    maxSteps: 10,
    review: false,
    effort: 'high',
    numCtx: 8192,
    tokenBudget: 0,
    lang: 'pt-BR',
    logDir: null,
    ...overrides,
  };
}

process.env.OLLAMA_HOST = 'http://127.0.0.1:9';
process.env.KRONOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kronos-home-'));

test('ReAct loop: act, observe an error, self-correct, and finish', async () => {
  const root = workspace();
  const provider = new ScriptedProvider([
    () => call('write_file', { path: 'src/app.txt', content: 'hello world\n' }),
    () => call('edit_file', { path: 'src/app.txt', old_string: 'missing', new_string: 'x' }),
    ({ results }) => {
      assert.equal(results.at(-1)![0]!.isError, true);
      assert.match(results.at(-1)![0]!.output, /not found/);
      return call('edit_file', { path: 'src/app.txt', old_string: 'world', new_string: 'Kronos' });
    },
    () => answer('done'),
  ]);
  const ui = UI.create();
  const session = new Session(config(root), ui, () => provider);
  const out = await session.run('change greeting');
  ui.close();
  assert.equal(out, 'done');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.txt'), 'utf8'), 'hello Kronos\n');
});

test('reflection: a reviewer rejection sends the agent back to work, then approval ends it', async () => {
  const root = workspace();
  let reviews = 0;
  const main = new ScriptedProvider([
    () => call('write_file', { path: 'a.txt', content: 'v1' }),
    () => answer('first attempt'),
    ({ user }) => {
      assert.match(user.at(-1)!, /requested changes/);
      assert.match(user.at(-1)!, /1\. a\.txt must say v2/);
      assert.doesNotMatch(user.at(-1)!, /<evaluation>/);
      return call('write_file', { path: 'a.txt', content: 'v2' });
    },
    () => answer('fixed'),
  ]);
  const critic = () =>
    new ScriptedProvider([() => answer(++reviews === 1 ? '<evaluation>NEEDS_IMPROVEMENT</evaluation>\n<feedback>1. a.txt must say v2</feedback>' : '<evaluation>PASS</evaluation>\n<feedback></feedback>')]);
  const providers = [main];
  const ui = UI.create();
  const session = new Session(config(root, { review: true }), ui, () => providers.shift() ?? critic());
  const out = await session.run('write v2 to a.txt');
  ui.close();
  assert.equal(out, 'fixed');
  assert.equal(reviews, 2);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'v2');
});

test('read-only mode denies writes and the loop guard warns after identical calls with identical results', async () => {
  const root = workspace();
  const provider = new ScriptedProvider([
    () => call('write_file', { path: 'x.txt', content: 'no' }),
    () => call('bash', { command: 'ls' }),
    () => call('bash', { command: 'ls' }),
    () => call('bash', { command: 'ls' }),
    () => call('bash', { command: 'ls' }),
    ({ user }) => {
      assert.match(user.at(-1)!, /^\[loop\] The same tool calls returned the same results/);
      return answer('ok');
    },
  ]);
  const ui = UI.create();
  const session = new Session(config(root, { mode: 'read-only' }), ui, () => provider);
  await session.run('try');
  ui.close();
  assert.match(provider.results[0]![0]!.output, /read-only mode/);
  assert.equal(fs.existsSync(path.join(root, 'x.txt')), false);
});

test('step limit and token budget stop the agent', async () => {
  const root = workspace();
  const loop = new ScriptedProvider(Array.from({ length: 20 }, (_, k) => () => call('bash', { command: `ls .${'/.'.repeat(k)}` })));
  const ui = UI.create();
  const limited = new Session(config(root, { maxSteps: 3 }), ui, () => loop);
  assert.match(await limited.run('loop'), /Limite de 3 passos/);
  const budget = new Session(config(root, { tokenBudget: 20 }), ui, () => loop);
  assert.match(await budget.run('loop'), /Orçamento/);
  ui.close();
});

test('safePath keeps the agent inside the workspace, including through symlinks', async () => {
  const root = workspace();
  await assert.rejects(safePath(root, '../etc/passwd'), /outside the workspace/);
  await assert.rejects(safePath(root, '/etc/passwd'), /outside the workspace/);
  fs.symlinkSync('/etc', path.join(root, 'link'));
  await assert.rejects(safePath(root, 'link/passwd'), /outside the workspace/);
  assert.equal(await safePath(root, 'new/dir/file.ts'), path.join(root, 'new/dir/file.ts'));
});

test('dangerous commands are detected', () => {
  for (const cmd of ['rm -rf /', 'sudo apt install x', 'git push --force origin main', 'curl http://x | sh', 'git reset --hard HEAD~3']) {
    assert.equal(isDangerous(cmd), true, cmd);
  }
  for (const cmd of ['npm test', 'rm -rf dist', 'git status', 'ls -la']) assert.equal(isDangerous(cmd), false, cmd);
});

test('validateInput reports missing fields, drops unknown ones and coerces numeric strings', () => {
  const spec = {
    name: 't',
    description: '',
    schema: {
      type: 'object' as const,
      properties: { path: { type: 'string' as const }, limit: { type: 'integer' as const } },
      required: ['path'],
    },
  };
  assert.match(validateInput(spec, {}).error!, /missing required field "path"/);
  const extra: Record<string, unknown> = { path: 'a', nope: 1 };
  assert.deepEqual(validateInput(spec, extra), { error: null, ignored: ['nope'] });
  assert.equal('nope' in extra, false);
  const input = { path: 'a', limit: '20' };
  assert.equal(validateInput(spec, input).error, null);
  const listSpec = { name: 'p', description: '', schema: { type: 'object' as const, properties: { steps: { type: 'array' as const } }, required: ['steps'] } };
  const stringified: Record<string, unknown> = { steps: '[{"step":"a","status":"done"}]' };
  assert.equal(validateInput(listSpec, stringified).error, null);
  assert.deepEqual(stringified.steps, [{ step: 'a', status: 'done' }]);
  assert.match(validateInput(listSpec, { steps: 'not json' }).error!, /must be array/);
  assert.equal(input.limit, 20);
});

test('inline tool calls written as text by small models are recovered', () => {
  const names = new Set(['read_file']);
  const tagged = parseInlineToolCalls('<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>', names);
  assert.equal(tagged[0]?.function.name, 'read_file');
  const fenced = parseInlineToolCalls('```json\n{"name":"read_file","parameters":{"path":"b.ts"}}\n```', names);
  assert.deepEqual(fenced[0]?.function.arguments, { path: 'b.ts' });
  assert.equal(parseInlineToolCalls('{"name":"rm","arguments":{}}', names).length, 0);
});

function stubJudge(replies: unknown[]): Judge & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    costUsd: 0,
    prompts,
    async ask<T>(prompt: string): Promise<T> {
      prompts.push(prompt);
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply as T;
    },
  };
}

const slice = (title: string, check: string) => ({ title, spec: `faça: ${title}`, files: ['x.txt'], criteria: [{ text: title, check, guard: false }] });

test('a batch mixing reads and a write runs the reads first and returns every result in the order asked', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'a.txt'), 'A\n');
  const batch = (): StepResult => ({
    text: '',
    toolCalls: [
      { id: 'r1', name: 'read_file', input: { path: 'a.txt' } },
      { id: 'w1', name: 'write_file', input: { path: 'b.txt', content: 'B\n' } },
      { id: 'r2', name: 'list_dir', input: { path: '.' } },
    ],
    stop: 'tool_use',
    usage,
  });
  const provider = new ScriptedProvider([batch, () => answer('ok')]);
  const ui = UI.create();
  await new Session(config(root), ui, () => provider).run('x');
  ui.close();
  const results = provider.results[0]!;
  assert.deepEqual(results.map((r) => r.id), ['r1', 'w1', 'r2']);
  assert.match(results[0]!.output, /A/);
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'B\n');
});

test('orchestrator: a slice goes back to a fresh worker with the gate failures until its checks pass', async () => {
  const root = workspace();
  const contract = { slices: [slice('cria x.txt', 'test -f x.txt')] };
  const judge = stubJudge([contract, contract, { approved: true, problems: [] }]);
  const workers = [
    new ScriptedProvider([]),
    new ScriptedProvider([() => answer('pronto')]),
    new ScriptedProvider([
      ({ user }) => {
        assert.match(user[0]!, /the gate failed/);
        assert.match(user[0]!, /\$ test -f x\.txt/);
        return call('write_file', { path: 'x.txt', content: 'ok' });
      },
      () => answer('pronto'),
    ]),
  ];
  const ui = UI.create();
  const out = await orchestrate(new Session(config(root), ui, () => workers.shift()!), 'crie x.txt', judge);
  ui.close();
  assert.equal(workers.length, 0);
  assert.match(out, /✔ cria x\.txt/);
  assert.match(out, /Checagens do contrato: 1\/1 passam/);
  assert.match(out, /Revisão do motor de decisão: aprovada/);
});

test('orchestrator: the judge validates its checks against their output on the unchanged code, and review problems go to a fix worker', async () => {
  const root = workspace();
  const judge = stubJudge([
    { slices: [slice('cria x.txt', 'true')] },
    { slices: [slice('cria x.txt', 'test -f x.txt')] },
    { approved: false, problems: [{ file: 'x.txt', problem: 'texto errado', fix: 'escreva certo' }] },
  ]);
  const workers = [
    new ScriptedProvider([]),
    new ScriptedProvider([() => call('write_file', { path: 'x.txt', content: 'errado' }), () => answer('pronto')]),
    new ScriptedProvider([
      ({ user }) => {
        assert.match(user[0]!, /texto errado/);
        return call('read_file', { path: 'x.txt' });
      },
      () => call('write_file', { path: 'x.txt', content: 'certo' }),
      () => answer('corrigido'),
    ]),
  ];
  const ui = UI.create();
  const out = await orchestrate(new Session(config(root), ui, () => workers.shift()!), 'crie x.txt', judge);
  ui.close();
  assert.match(judge.prompts[1]!, /<baseline>\n- \[criterion · PASSES\] cria x\.txt\n  \$ true/);
  assert.equal(fs.readFileSync(path.join(root, 'x.txt'), 'utf8'), 'certo');
  assert.match(out, /1 problema\(s\) enviados para correção/);
});

test('orchestrator: a criterion that stays red does not block the gate of later slices', async () => {
  const root = workspace();
  const judge = stubJudge([
    { slices: [slice('impossível', 'false'), slice('cria y.txt', 'test -f y.txt')] },
    { slices: [slice('impossível', 'false'), slice('cria y.txt', 'test -f y.txt')] },
    { approved: true, problems: [] },
  ]);
  const workers = [
    new ScriptedProvider([]),
    ...Array.from({ length: 3 }, () => new ScriptedProvider([() => answer('tentei')])),
    new ScriptedProvider([() => call('write_file', { path: 'y.txt', content: 'ok' }), () => answer('pronto')]),
  ];
  const ui = UI.create();
  const out = await orchestrate(new Session(config(root), ui, () => workers.shift()!), 'faça', judge);
  ui.close();
  assert.equal(workers.length, 0);
  assert.match(out, /✖ impossível/);
  assert.match(out, /✔ cria y\.txt/);
  assert.match(out, /1\/2 passam/);
});

test('orchestrator: an interrupted run resumes from the saved contract and skips the slices whose checks still pass', async () => {
  const root = workspace();
  const contract = { slices: [slice('cria a.txt', 'test -f a.txt'), slice('cria b.txt', 'test -f b.txt')] };
  let session!: Session;
  const first = [
    new ScriptedProvider([]),
    new ScriptedProvider([() => call('write_file', { path: 'a.txt', content: 'ok' }), () => answer('pronto')]),
    new ScriptedProvider([
      () => {
        session.abort();
        return answer('parei');
      },
    ]),
  ];
  let ui = UI.create();
  session = new Session(config(root), ui, () => first.shift()!);
  assert.match(await orchestrate(session, 'crie a e b', stubJudge([contract, contract])), /retomar do ponto em que parou/);
  ui.close();

  const judge = stubJudge([{ approved: true, problems: [] }]);
  const second = [new ScriptedProvider([]), new ScriptedProvider([() => call('write_file', { path: 'b.txt', content: 'ok' }), () => answer('pronto')])];
  ui = UI.create();
  const out = await orchestrate(new Session(config(root), ui, () => second.shift()!), 'crie a e b', judge);
  ui.close();
  assert.equal(second.length, 0);
  assert.equal(judge.prompts.length, 1, 'the contract must not be written again');
  assert.match(out, /✔ cria a\.txt\n✔ cria b\.txt/);
  assert.match(out, /2\/2 passam/);
});

test('orchestrator: without the decision engine it stops with an explanation instead of crashing', async () => {
  const ui = UI.create();
  const out = await orchestrate(new Session(config(workspace()), ui, () => new ScriptedProvider([])), 'x', stubJudge([new Error('spawn claude ENOENT')]));
  ui.close();
  assert.match(out, /Não foi possível escrever o contrato.*ENOENT/);
});

test('markdown lines are rendered for the terminal, including code fences', () => {
  const state = { inFence: false };
  const plain = (line: string) => stripVTControlCharacters(renderMarkdownLine(line, state));
  assert.equal(plain('## Resumo'), 'Resumo');
  assert.equal(plain('- use **total()** em `cart.js`'), '• use total() em cart.js');
  assert.equal(plain('```ts'), '┌─ ts');
  assert.equal(plain('- not a bullet inside code'), '│ - not a bullet inside code');
  assert.equal(plain('```'), '└─');
  assert.equal(state.inFence, false);
});

test('system prompt carries the chosen language and the answering method', () => {
  const root = workspace();
  assert.match(systemPrompt('main', root, 'pt-BR'), /in Brazilian Portuguese: answers, the short notes between tool calls/);
  assert.match(systemPrompt('main', root, 'es'), /in Spanish/);
  assert.match(systemPrompt('main', root, 'auto'), /language the user wrote in/);
  assert.match(systemPrompt('explorer', root, 'en'), /evidence as path\/to\/file.ts:42/);
});

test('no mid-run nudges: a long streak of reads gets plain tool outputs, with no focus, re-read, recap or budget notes', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
  const reads = Array.from({ length: 32 }, (_, i) => () => call('read_file', { path: 'a.txt', offset: 1 + (i % 2), limit: 5 + i }));
  const provider = new ScriptedProvider([...reads, () => answer('ok')]);
  const ui = UI.create();
  await new Session(config(root, { maxSteps: 33 }), ui, () => provider).run('investigate');
  ui.close();
  for (const [r] of provider.results) assert.doesNotMatch(r!.output, /\[(focus|note|recap|budget|reflection|loop)\]/);
});

test('missing paths get cleaned or a suggestion', async () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, 'web/src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web/src/App.tsx'), 'x\n');
  assert.equal(cleanPath(' `web/src/App.tsx` '), 'web/src/App.tsx');
  assert.match(await suggestPath(root, 'web/src/App.tsx child'), /Did you mean: web\/src\/App\.tsx\?/);
  assert.match(await suggestPath(root, 'src/App.tsx'), /web\/src\/App\.tsx/);
  const provider = new ScriptedProvider([() => call('read_file', { path: 'App.tsx child' }), () => answer('ok')]);
  const ui = UI.create();
  await new Session(config(root), ui, () => provider).run('x');
  ui.close();
  assert.match(provider.results[0]![0]!.output, /File not found: App\.tsx child\. Did you mean: web\/src\/App\.tsx\?/);
});

test('ambiguity rule: ask in interactive chat, decide alone otherwise', () => {
  const root = workspace();
  assert.match(systemPrompt('main', root, 'pt-BR', true), /ask the user one short question and stop/);
  assert.match(systemPrompt('main', root, 'pt-BR', false), /nobody is available to answer: choose the smaller option/);
  assert.match(systemPrompt('worker', root, 'pt-BR', true), /nobody is available to answer/);
  assert.doesNotMatch(systemPrompt('main', root, 'pt-BR', true), /INTERACTIVE_RULE/);
});

test('sessions are saved after each task, resumed with their history and forked under a new id', async () => {
  const root = workspace();
  const ui = UI.create();
  const first = new Session(config(root), ui, () => new ScriptedProvider([() => answer('primeira resposta')]));
  await first.run('primeira tarefa');

  const resumedProvider = new ScriptedProvider([({ user }) => answer(`vi ${user.length} mensagens`)]);
  const second = new Session(config(root), ui, () => resumedProvider);
  const saved = second.sessions.latest()!;
  assert.equal(saved.id, first.id);
  assert.deepEqual(saved.turns, [{ task: 'primeira tarefa', answer: 'primeira resposta' }]);
  assert.equal(second.resume(saved), null);
  assert.equal(await second.run('segunda tarefa'), 'vi 2 mensagens');
  assert.equal(second.sessions.load(first.id)!.turns.length, 2);

  second.fork();
  assert.notEqual(second.id, first.id);
  assert.equal(second.sessions.load(second.id)!.turns.length, 2);
  assert.match(new Session(config(root, { provider: 'anthropic' }), ui, () => new ScriptedProvider([])).resume(saved)!, /--provider ollama/);
  ui.close();
});

test('on a follow-up like "pode continuar", the reviewer gets the request of the conversation', async () => {
  const root = workspace();
  const goals: string[] = [];
  const nudges: string[] = [];
  const reply = ({ user }: { user: string[] }): StepResult => {
    nudges.push(user.at(-1)!);
    return answer('feito');
  };
  const main = new ScriptedProvider([() => answer('vou começar'), () => call('write_file', { path: 'src/a.js', content: 'export const a = 2;\n' }), reply, reply, reply, reply, reply, reply, reply]);
  const critic = () =>
    new ScriptedProvider([
      ({ user }) => {
        goals.push(user[0]!);
        return answer('<evaluation>PASS</evaluation>\n<feedback></feedback>');
      },
    ]);
  const providers = [main];
  const ui = UI.create();
  const session = new Session(config(root, { review: true }), ui, () => providers.shift() ?? critic());
  try {
    await session.run('escreva a = 2 em src/a.js');
    await session.run('pode continuar');
  } finally {
    ui.close();
  }
  assert.match(goals[0]!, /escreva a = 2 em src\/a\.js/);
});

test('with reviewModel set, the review runs in the Kronos engine as a critic on that model', async () => {
  const root = workspace();
  const main = new ScriptedProvider([() => call('write_file', { path: 'a.txt', content: 'v2' }), () => answer('feito'), () => answer('feito')]);
  const asked: (string | undefined)[] = [];
  const critic = new ScriptedProvider([({ system }) => {
    assert.match(system, /independent reviewer/);
    return answer('<evaluation>PASS</evaluation>\n<feedback></feedback>');
  }]);
  const ui = UI.create();
  const session = new Session(config(root, { review: true, reviewModel: 'minimax-m3.1-flash:cloud' }), ui, (model) => {
    asked.push(model);
    return model ? critic : main;
  });
  try {
    assert.equal(await session.run('escreva v2 em a.txt'), 'feito');
  } finally {
    ui.close();
  }
  assert.deepEqual(asked.filter(Boolean), ['minimax-m3.1-flash:cloud']);
});

test('a test the agent wrote in an earlier message of the conversation stays editable in a later one', async () => {
  const root = workspace();
  const results: string[] = [];
  const main = new ScriptedProvider([
    () => call('write_file', { path: 'tests/a.spec.js', content: "import assert from 'node:assert/strict';\nassert.equal(soma(1, 1), 3);\n" }),
    () => call('bash', { command: 'node -e 1' }),
    () => answer('escrevi o teste'),
    () => call('edit_file', { path: 'tests/a.spec.js', old_string: 'soma(1, 1), 3)', new_string: 'soma(1, 1), 2)' }),
    ({ results: r }) => {
      results.push(r.at(-1)![0]!.output);
      return answer('corrigi');
    },
    () => answer('corrigi'),
    () => answer('corrigi'),
  ]);
  const ui = UI.create();
  const session = new Session(config(root, { mode: 'auto' }), ui, () => main);
  try {
    assert.equal(await session.run('implemente soma com TDD'), 'escrevi o teste');
    await session.run('pode continuar');
  } finally {
    ui.close();
  }
  assert.match(results[0]!, /Edited tests\/a\.spec\.js/);
});

test('verification gate asks once to run something after unverified code edits', async () => {
  const root = workspace();
  const ui = UI.create();
  try {
    const unverified = new ScriptedProvider([
      () => call('write_file', { path: 'src/a.js', content: 'export const a = 1;\n' }),
      () => answer('pronto'),
      ({ user }) => {
        assert.match(user.at(-1)!, /^\[verification\] You changed code but have not run anything/);
        return answer('não há como rodar nada aqui');
      },
      () => answer('não há como rodar nada aqui'),
    ]);
    assert.equal(await new Session(config(root, { mode: 'auto' }), ui, () => unverified).run('crie a'), 'não há como rodar nada aqui');

    const verified = new ScriptedProvider([
      () => call('edit_file', { path: 'src/a.js', old_string: '1', new_string: '2' }),
      () => call('bash', { command: 'node src/a.js' }),
      () => answer('feito e testado'),
      () => answer('feito e testado'),
    ]);
    assert.equal(await new Session(config(root, { mode: 'auto' }), ui, () => verified).run('mude a'), 'feito e testado');

  } finally {
    ui.close();
  }
});

test('skills: Claude-compatible SKILL.md discovery, loading on demand, and no tool when there are none', async () => {
  const { findSkills, frontmatter, readSkill } = await import('../src/skills.js');
  process.env.KRONOS_USER_SKILLS = 'off';
  const root = workspace();
  const write = (f: string, c: string) => {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), c);
  };
  assert.deepEqual(frontmatter('---\nname: "a"\ndescription: >\n  first\n  second\nlicense: MIT\n---\nbody').fields, { name: 'a', description: 'first second', license: 'MIT' });
  write('.claude/skills/new-endpoint/SKILL.md', '---\nname: new-endpoint\ndescription: Use when adding an HTTP endpoint.\nallowed-tools: Bash\n---\n# Steps\nPut it behind a flag.\n');
  write('.claude/skills/new-endpoint/reference/flags.md', 'flag naming');
  write('.agents/skills/new-endpoint/SKILL.md', '---\nname: new-endpoint\ndescription: shadowed\n---\nignored');
  write('.agents/skills/other/SKILL.md', '---\ndescription: Folder name is the fallback name.\n---\nx');
  const skills = findSkills(root);
  assert.deepEqual(skills.map((s) => [s.name, s.description]), [['new-endpoint', 'Use when adding an HTTP endpoint.'], ['other', 'Folder name is the fallback name.']]);
  assert.match(readSkill(skills, 'new-endpoint'), /^# Steps\nPut it behind a flag\.\n\n\[Other files in this skill .*reference\/flags\.md\]$/);
  assert.equal(readSkill(skills, 'new-endpoint', 'reference/flags.md'), 'flag naming');
  assert.throws(() => readSkill(skills, 'new-endpoint', '../../../package.json'), /inside the skill folder/);

  const ui = UI.create();
  try {
    const seen: string[] = [];
    const withSkills = new ScriptedProvider([({ system }) => (seen.push(system), call('skill', { name: 'new-endpoint' })), ({ results }) => answer(results.at(-1)![0]!.output)]);
    assert.match(await new Session(config(root), ui, () => withSkills).run('adicione um endpoint'), /Put it behind a flag/);
    assert.match(seen[0]!, /<skills>[\s\S]*- new-endpoint: Use when adding an HTTP endpoint\./);
    const empty = workspace();
    const noSkills = new ScriptedProvider([({ system }) => (seen.push(system), call('skill', { name: 'x' })), () => answer('ok')]);
    await new Session(config(empty), ui, () => noSkills).run('x');
    assert.doesNotMatch(seen[1]!, /<skills>/);
    assert.match(noSkills.results[0]![0]!.output, /^Tool "skill" not found/);
  } finally {
    ui.close();
  }
});

test('offload: a huge tool output is saved to a git-ignored file and the model gets head, tail and the path', async () => {
  const root = workspace();
  execFileSync('git', ['init', '-q'], { cwd: root });
  const ui = UI.create();
  try {
    const provider = new ScriptedProvider([
      () => call('bash', { command: 'seq 1 50000' }),
      () => call('bash', { command: 'echo small' }),
      () => answer('ok'),
    ]);
    await new Session(config(root), ui, () => provider).run('liste os números');
    const big = provider.results[0]![0]!.output;
    const saved = /saved in (\.kronos\/outputs\/\S+\.txt)/.exec(big)?.[1];
    assert.ok(saved, big.slice(3000, 3400));
    assert.ok(big.length < 7000);
    assert.match(big, /^Exit code: 0\nWall time: [\d.]+ s\nOutput:\n1\n2\n3\n/);
    const [head, tail] = big.split(/\n\.\.\. \[output too long[^\n]*\] \.\.\.\n/);
    assert.equal(head!.length, 2400);
    assert.equal(tail!.length, 3600);
    assert.match(big, /50000$/);
    assert.match(big, /grep it or read the lines you need with read_file/);
    const full = fs.readFileSync(path.join(root, saved), 'utf8');
    assert.equal(full.split('\n').length, 50003);
    assert.match(full, /\n25000\n/);
    assert.match(provider.results[1]![0]!.output, /^Exit code: 0\nWall time: [\d.]+ s\nOutput:\nsmall$/);
    assert.equal(provider.results[0]![0]!.savedAs, saved);
    assert.equal(provider.results[1]![0]!.savedAs, undefined);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '');
  } finally {
    ui.close();
  }
});

test('progressive tools: rare tools stay out of the prompt until load_tools or a skill that allows them', async () => {
  process.env.KRONOS_USER_SKILLS = 'off';
  const root = workspace();
  fs.mkdirSync(path.join(root, '.claude/skills/docs-lookup'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude/skills/docs-lookup/SKILL.md'), '---\nname: docs-lookup\ndescription: Use when you need to save notes.\nallowed-tools: WebFetch, Bash\n---\nSave the note.\n');
  const ui = UI.create();
  const offered: string[][] = [];
  try {
    const provider = new ScriptedProvider([
      () => call('web_fetch', { url: 'http://127.0.0.1:9' }),
      () => call('skill', { name: 'docs-lookup' }),
      () => answer('ok'),
    ]);
    const session = new Session(config(root), ui, () => {
      const wrapped = Object.create(provider) as ScriptedProvider;
      wrapped.step = (req) => (offered.push(req.tools.map((t) => t.name)), provider.step(req));
      return wrapped;
    });
    await session.run('busque a documentação');
    assert.match(provider.results[0]![0]!.output, /^Tool "web_fetch" not found\. .*Available tools: .*\bload_tools\b/);
    assert.ok(!offered[0]!.includes('web_fetch'));
    assert.match(provider.results[1]![0]!.output, /\[tools\] Loaded for this skill: web_fetch\.$/);
    assert.ok(offered[2]!.includes('web_fetch'));

    const pinned = new ScriptedProvider([() => answer('ok')]);
    const seen: string[][] = [];
    const withList = new Session(config(workspace(), { tools: ['bash', 'grep'] }), ui, () => {
      const wrapped = Object.create(pinned) as ScriptedProvider;
      wrapped.step = (req) => (seen.push(req.tools.map((t) => t.name)), pinned.step(req));
      return wrapped;
    });
    await withList.run('x');
    assert.deepEqual(seen[0]!.sort(), ['bash', 'finish', 'grep']);
  } finally {
    ui.close();
  }
});

const ts5 = process.env.KRONOS_TEST_TS5;

test('edits that introduce type errors are reverted; unused names are only reported', { skip: !ts5 && 'set KRONOS_TEST_TS5 to a typescript@5 folder' }, async () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.symlinkSync(ts5!, path.join(root, 'node_modules/typescript'));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noUnusedLocals: true, lib: ['ES2022'] }, include: ['src'] }));
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1;\n');
  const provider = new ScriptedProvider([
    () => call('edit_file', { path: 'src/a.ts', old_string: 'export const a = 1;', new_string: 'export const a = missingName;' }),
    ({ results }) => {
      assert.equal(results.at(-1)![0]!.isError, true);
      assert.match(results.at(-1)![0]!.output, /^Edit rejected and reverted: .*\n.*TS2304: Cannot find name 'missingName'/);
      assert.equal(fs.readFileSync(path.join(root, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');
      return call('edit_file', { path: 'src/a.ts', old_string: 'export const a = 1;', new_string: 'const unused = 2;\nexport const a = 1;' });
    },
    ({ results }) => {
      assert.equal(results.at(-1)![0]!.isError, false, results.at(-1)![0]!.output);
      assert.match(results.at(-1)![0]!.output, /\[diagnostics\].*\n.*TS6133/);
      return call('bash', { command: 'node -e 1' });
    },
    () => answer('ok'),
    () => answer('ok'),
  ]);
  const ui = UI.create();
  try {
    assert.equal(await new Session(config(root), ui, () => provider).run('edite a'), 'ok');
  } finally {
    ui.close();
  }
});

test('handoff between runs: the note written at the end of one run opens the next', async () => {
  const root = workspace();
  const handoff = path.join(root, 'notes', 'handoff.md');
  const first = new ScriptedProvider([
    () => call('write_file', { path: 'a.txt', content: 'v1' }),
    () => answer('done'),
    ({ user }) => {
      assert.match(user.at(-1)!, /^\[handoff\]/);
      assert.match(user.at(-1)!, /## Tried and failed/);
      return answer('## State\nnote-body');
    },
  ]);
  let ui = UI.create();
  assert.equal(await new Session(config(root, { handoff }), ui, () => first).run('block one'), 'done');
  ui.close();
  const note = fs.readFileSync(handoff, 'utf8');
  assert.match(note, /note-body/);
  assert.match(note, /a\.txt/);
  const second = new ScriptedProvider([
    ({ user }) => {
      assert.match(user[0]!, /<previous_handoff>[\s\S]*note-body[\s\S]*<\/previous_handoff>/);
      assert.match(user[0]!, /block two\n\nYou have up to/);
      return answer('ok');
    },
    () => answer('## State\nsecond'),
  ]);
  ui = UI.create();
  await new Session(config(root, { handoff }), ui, () => second).run('block two');
  ui.close();
  assert.match(fs.readFileSync(handoff, 'utf8'), /second/);
});

test('gate: the agent sees the checks and is sent back at every turn end while one fails, until they pass', async () => {
  const root = workspace();
  const gate = [{ text: 'a.txt says ok', check: 'grep -q ok a.txt && echo fine || { echo "a.txt is wrong"; exit 1; }', guard: false }];
  const provider = new ScriptedProvider([
    ({ user }) => {
      assert.match(user[0]!, /\$ grep -q ok a\.txt/);
      return call('write_file', { path: 'a.txt', content: 'no' });
    },
    () => answer('done'),
    () => answer('done'),
    () => answer('done'),
    ({ user }) => {
      assert.equal(user.filter((u) => u.startsWith('[gate]')).length, 3);
      assert.match(user.at(-1)!, /^\[gate\] 0\/1 checks pass\. You cannot finish yet/);
      assert.match(user.at(-1)!, /a\.txt is wrong/);
      return call('write_file', { path: 'a.txt', content: 'ok' });
    },
    () => answer('done2'),
  ]);
  const ui = UI.create();
  assert.equal(await new Session(config(root, { gate }), ui, () => provider).run('make a.txt say ok'), 'done2');
  ui.close();
});


test('gate: the minimal-diff judge can send the agent back at most twice, then stops blocking', async () => {
  const root = workspace();
  const { MINIMAL_DIFF } = await import('../src/gate.js');
  const gate = [{ text: 'a.txt says ok', check: 'grep -q ok a.txt', guard: false }, MINIMAL_DIFF];
  const main = new ScriptedProvider([
    () => call('write_file', { path: 'a.txt', content: 'ok' }),
    () => answer('done'),
    ({ user }) => {
      assert.match(user.at(-1)!, /^\[gate\] 1\/2 checks pass[\s\S]*drop the helper/);
      return answer('done');
    },
    () => answer('done'),
  ]);
  let judged = 0;
  const factory = () => (judged++ === 0 ? main : new ScriptedProvider([() => answer('{"pass":false,"reason":"drop the helper"}')]));
  const ui = UI.create();
  assert.equal(await new Session(config(root, { gate }), ui, factory).run('make a.txt say ok'), 'done');
  ui.close();
  assert.equal(judged - 1, 2);
});

test('tool descriptions state the preconditions and consequences that caused rejected edits', () => {
  const describe = (name: string) => allTools.find((t) => t.name === name)!.description;
  assert.match(describe('edit_file'), /reverted/);
  assert.match(describe('edit_file'), /rename/i);
  assert.match(describe('edit_file'), /replace_all/);
  assert.match(describe('write_file'), /reverted/);
  assert.match(describe('bash'), /not progress/);
  assert.match(describe('bash'), /saved to a file/);
});

test('a message sent while the agent works reaches it at the next step and joins the request', async () => {
  const root = workspace();
  let session!: Session;
  const provider = new ScriptedProvider([
    () => {
      session.queue('use port 8081');
      return call('list_dir', { path: '.' });
    },
    ({ user }) => {
      assert.match(user.at(-1)!, /use port 8081/);
      return answer('done');
    },
  ]);
  const ui = UI.create();
  session = new Session(config(root), ui, () => provider);
  await session.run('start the server');
  ui.close();
  assert.equal(session.turns[0]!.task, 'start the server\n\nuse port 8081');
});

test('a /skill command turns the skill on for every step until /skill off', async () => {
  const { skillCommand, activeSkillsBlock } = await import('../src/skills.js');
  const root = workspace();
  fs.mkdirSync(path.join(root, '.claude/skills/lazy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude/skills/lazy/SKILL.md'), '---\nname: lazy\ndescription: Be lazy\n---\nWrite less code.\n');
  let seen = '';
  const provider = new ScriptedProvider([
    ({ system }) => {
      seen = system;
      return answer('ok');
    },
  ]);
  const ui = UI.create();
  const session = new Session(config(root), ui, () => provider);
  const task = skillCommand(session.skills, session.activeSkills, '/lazy fix the bug')!;
  assert.equal(task, 'fix the bug');
  await session.run(task);
  ui.close();
  assert.match(seen, /<active_skills>[\s\S]*Write less code\./);
  skillCommand(session.skills, session.activeSkills, '/lazy off');
  assert.equal(activeSkillsBlock(session.skills, session.activeSkills), '');
  assert.equal(skillCommand(session.skills, session.activeSkills, '/unknown x'), null);
  assert.equal(skillCommand(session.skills, session.activeSkills, 'lazy please'), null);
});

test('maxSteps 0 means no step limit: the agent runs until it answers', async () => {
  const root = workspace();
  const provider = new ScriptedProvider([...Array.from({ length: 12 }, (_, i) => () => call('list_dir', { path: '.', n: i })), () => answer('done')]);
  const ui = UI.create();
  const session = new Session(config(root, { maxSteps: 0 }), ui, () => provider);
  const out = await session.run('explore');
  ui.close();
  assert.equal(out, 'done');
});

test('a read announced while the model streams starts right away and runs only once', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
  const ui = UI.create();
  let resultsWhenStepEnded = -1;
  const results: ToolResult[][] = [];
  const read = { id: 'r1', name: 'read_file', input: { path: 'a.txt' } };
  let turn = 0;
  const provider: Provider = {
    addUser() {},
    addToolResults(r) {
      results.push(r);
    },
    snapshot: () => null,
    restore() {},
    async step(req) {
      if (turn++ > 0) return answer('ok');
      req.onToolCall?.(read);
      await new Promise((r) => setTimeout(r, 50));
      resultsWhenStepEnded = results.length;
      return { text: '', toolCalls: [read], stop: 'tool_use', usage };
    },
  };
  const session = new Session(config(root), ui, () => provider);
  const reads: unknown[] = [];
  const original = session.log.bind(session);
  session.log = (e: Record<string, unknown>) => {
    if (e.event === 'tool' && e.name === 'read_file') reads.push(e);
    original(e);
  };
  try {
    await session.run('read a.txt');
  } finally {
    ui.close();
  }
  assert.equal(resultsWhenStepEnded, 0);
  assert.equal(reads.length, 1, 'the early read must not run again');
  assert.match(results[0]![0]!.output, /hello/);
});

test('validateInput unwraps arguments the model nested under parameters/arguments', () => {
  const bash = allTools.find((t) => t.name === 'bash')!;
  const nested: Record<string, unknown> = { default_api: 'bash', parameters: '{"command":"ls"}' };
  assert.equal(validateInput(bash, nested).error, null);
  assert.deepEqual(nested, { command: 'ls' });
  const object: Record<string, unknown> = { arguments: { command: 'pwd' } };
  assert.equal(validateInput(bash, object).error, null);
  assert.equal(object.command, 'pwd');
  assert.match(validateInput(bash, { path: 'a.ts', limit: 10 }).error!, /missing required field "command"/);
});

test('an openai session adds up the cost each step reports, and says unknown when none came', () => {
  const ui = UI.create();
  const session = new Session(config(workspace(), { provider: 'openai' }), ui, () => new ScriptedProvider([]));
  assert.equal(session.costUsd(), null);
  session.addUsage({ input: 10, output: 1, cost: 0.01 });
  session.addUsage({ input: 10, output: 1, cost: 0.02 });
  ui.close();
  assert.ok(Math.abs(session.costUsd()! - 0.03) < 1e-9);
});

test('an MCP server from the Kronos config becomes a tool group the agent loads and calls', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kronos-mcp-user-'));
  const saved = { HOME: process.env.HOME, KRONOS_MCP: process.env.KRONOS_MCP };
  const fixture = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'fake-mcp.mjs');
  fs.writeFileSync(path.join(process.env.KRONOS_HOME!, 'mcp.json'), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [fixture], env: { FAKE_LABEL: 'kronos' } } } }));
  process.env.HOME = home;
  delete process.env.KRONOS_MCP;
  try {
    let loader = '';
    const provider = new ScriptedProvider([
      () => call('load_tools', { group: 'mcp:fake' }),
      () => call('mcp__fake__echo', { text: 'oi' }),
      ({ results }) => {
        assert.equal(results.at(-1)![0]!.output, 'echo oi from kronos');
        return answer('done');
      },
    ]);
    const spy: Provider = {
      ...provider,
      addUser: (t) => provider.addUser(t),
      addToolResults: (r) => provider.addToolResults(r),
      snapshot: () => provider.snapshot(),
      restore: (s) => provider.restore(s),
      step: (req) => {
        loader ||= req.tools.find((t) => t.name === 'load_tools')?.description ?? '';
        return provider.step(req);
      },
    };
    const ui = UI.create();
    const out = await new Session(config(workspace()), ui, () => spy).run('use the fake server');
    ui.close();
    assert.equal(out, 'done');
    assert.match(loader, /"mcp:fake" tools of the MCP server fake \(mcp__fake__echo, mcp__fake__fail\)/);
  } finally {
    closeMcp();
    fs.rmSync(path.join(process.env.KRONOS_HOME!, 'mcp.json'));
    process.env.HOME = saved.HOME;
    if (saved.KRONOS_MCP) process.env.KRONOS_MCP = saved.KRONOS_MCP;
  }
});

test('/compact says when the provider has no manual compaction, and usage has no context bar without a window', async () => {
  const ui = UI.create();
  const session = new Session(config(workspace()), ui, () => new ScriptedProvider([]));
  assert.equal(await session.compact(), null);
  assert.deepEqual(await session.usageReport(), { bars: [] });
  ui.close();
});

test('finish: the first call after changes returns the diff and a checklist; the second ends with the report', async () => {
  const root = workspace();
  const provider = new ScriptedProvider([
    () => call('write_file', { path: 'notes.md', content: 'ok\n' }),
    () => call('finish', { report: 'primeiro' }),
    ({ results }) => {
      assert.match(results.at(-1)![0]!.output, /^\[finish\] Before the task ends, review your changes below\.[\s\S]*notes\.md/);
      return call('finish', { report: 'escrevi notes.md' });
    },
  ]);
  const ui = UI.create();
  try {
    assert.equal(await new Session(config(root), ui, () => provider).run('crie notes.md'), 'escrevi notes.md');
  } finally {
    ui.close();
  }
});

test('finish without changes ends at once; finish mixed with other calls is refused', async () => {
  const provider = new ScriptedProvider([
    () => ({ text: '', toolCalls: [{ id: 'a', name: 'grep', input: { pattern: 'x' } }, { id: 'b', name: 'finish', input: { report: 'cedo' } }], stop: 'tool_use', usage }),
    ({ results }) => {
      assert.match(results.at(-1)![1]!.output, /^Not finished: call finish alone/);
      return call('finish', { report: 'nada a mudar' });
    },
  ]);
  const ui = UI.create();
  try {
    assert.equal(await new Session(config(workspace()), ui, () => provider).run('confira x'), 'nada a mudar');
  } finally {
    ui.close();
  }
});

test('an empty reply is retried and an announced next action gets "Please continue."', async () => {
  const provider = new ScriptedProvider([
    () => answer(''),
    ({ user }) => {
      assert.match(user.at(-1)!, /^\[System: your last reply had no text and no tool call/);
      return answer('Achei o arquivo. Agora vou editar o service.');
    },
    ({ user }) => {
      assert.equal(user.at(-1), 'Please continue.');
      return answer('pronto');
    },
  ]);
  const ui = UI.create();
  try {
    assert.equal(await new Session(config(workspace()), ui, () => provider).run('x'), 'pronto');
  } finally {
    ui.close();
  }
});

test('after a verified edit, a streak of steps without changes gets one nudge to finish', async () => {
  const root = workspace();
  const script: Script[] = [() => call('write_file', { path: 'a.js', content: 'export const a = 1;\n' }), () => call('bash', { command: 'node a.js' })];
  for (let i = 0; i < 6; i++) script.push(() => call('grep', { pattern: `a${i}` }));
  script.push(({ user }) => {
    assert.match(user.at(-1)!, /^\[progress\] Your last edit was verified 6 steps ago/);
    return call('finish', { report: 'feito' });
  });
  script.push(() => call('finish', { report: 'feito' }));
  const provider = new ScriptedProvider(script);
  const ui = UI.create();
  try {
    assert.equal(await new Session(config(root, { maxSteps: 20 }), ui, () => provider).run('crie a.js'), 'feito');
  } finally {
    ui.close();
  }
});
