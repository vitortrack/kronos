import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEdit, omissionPlaceholder, unescapeOverEscaped } from '../src/editing.js';
import { announcesNextAction, closestNames, LoopGuard } from '../src/loop-guard.js';

const repeat = (guard: LoopGuard, n: number, name: string, output: string, isError = false) =>
  Array.from({ length: n }, () => guard.record(name, { a: 1 }, output, isError));

test('loop guard: the same call with the same result warns at 4, then stops on the next cycle', () => {
  const guard = new LoopGuard();
  assert.deepEqual(repeat(guard, 4, 'bash', 'same'), ['ok', 'ok', 'ok', 'warn']);
  assert.deepEqual(repeat(guard, 4, 'bash', 'same'), ['ok', 'ok', 'ok', 'stop']);
});

test('loop guard: the same failing call warns at 3; a call whose result changes is progress', () => {
  assert.deepEqual(repeat(new LoopGuard(), 3, 'edit_file', 'no match', true), ['ok', 'ok', 'warn']);
  const guard = new LoopGuard();
  assert.deepEqual([1, 2, 3, 4, 5].map((i) => guard.record('bash', { c: 'tsc' }, `errors: ${i}`, false)), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.equal(new LoopGuard().record('bash', {}, 'Exit code: 0\nWall time: 0.1 s\nOutput:\nx', false), 'ok');
  const timed = new LoopGuard();
  assert.deepEqual(['0.1', '0.2', '0.3', '0.4'].map((t) => timed.record('bash', {}, `Exit code: 0\nWall time: ${t} s\nOutput:\nx`, false)), ['ok', 'ok', 'ok', 'warn']);
});

test('loop guard: an A/B/A/B/A/B alternation is a loop', () => {
  const guard = new LoopGuard();
  const out = [];
  for (let i = 0; i < 6; i++) out.push(guard.record(i % 2 ? 'grep' : 'read_file', {}, 'x', false));
  assert.deepEqual(out, ['ok', 'ok', 'ok', 'ok', 'ok', 'warn']);
});

test('unknown tool names get the closest real ones', () => {
  assert.equal(closestNames('read_fle', ['bash', 'read_file', 'grep', 'edit_file'], 1)[0], 'read_file');
  assert.equal(closestNames('edit', ['bash', 'read_file', 'edit_file'], 1)[0], 'edit_file');
});

test('announced next action without a tool call is detected in English and Portuguese', () => {
  assert.equal(announcesNextAction('Found it.\nNow I will edit src/a.ts to add the filter.'), true);
  assert.equal(announcesNextAction('Encontrei o ponto. Agora vou alterar o service.'), true);
  assert.equal(announcesNextAction('Done: the filter is in src/a.ts:12 and tsc passes.'), false);
});

test('edit defenses: omission placeholders are refused, over-escaped old_string is repaired, token spacing is tolerated', () => {
  assert.equal(omissionPlaceholder('a()', 'a();\n// ... rest of code'), '// ... rest of code');
  assert.equal(omissionPlaceholder('a()', '# ... existing code ...'), '# ... existing code ...');
  assert.equal(omissionPlaceholder('a()', '// existing users are kept\nb();'), null);
  assert.equal(omissionPlaceholder('x\n// ... rest of code', 'y\n// ... rest of code'), null);
  assert.equal(unescapeOverEscaped('a = 1;\\nb = 2;', 'a = 1;\nb = 2;\n'), 'a = 1;\nb = 2;');
  assert.equal(unescapeOverEscaped('a = 1;', 'a = 1;\n'), null);
  const r = applyEdit('if(a==b){\n  go( x,y );\n}\n', 'if (a == b) {\n  go(x, y);', 'if (a === b) {\n  go(x, y);', false);
  assert.ok(r.ok, !r.ok ? r.error : '');
  assert.equal(r.ok && r.content, 'if (a === b) {\n  go(x, y);\n}\n');
  assert.equal(r.ok && r.strategy, 'ignoring spacing between tokens');
});
