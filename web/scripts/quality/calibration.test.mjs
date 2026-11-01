import test from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';
import { analyzer } from './policy.mjs';
import { evidenceFor, newEvidence } from './evidence.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lint = analyzer(cwd);
const message = { ruleId: 'no-eval', message: 'eval can be harmful.', severity: 2, line: 1, column: 1, endLine: 1, endColumn: 13 };
const evidence = (source = 'eval(input);', m = message) => evidenceFor('web/lib/example.ts', source, [m]);
test('same fact deduplicates, moved line is stable', () => {
  const base = evidence();
  const moved = evidence('// moved\neval(input);', { ...message, line: 2, endLine: 2 });
  assert.deepEqual(newEvidence(base, moved), []);
});
test('same-rule/count substitution is new evidence', () => {
  assert.equal(newEvidence(evidence(), evidence('eval(other);')).length, 1);
});
test('additional duplicate finding is not hidden', () => {
  const base = evidence();
  assert.equal(newEvidence(base, [...base, ...base]).length, 1);
});
test('renames are conservatively new, deletion retires debt', () => {
  const base = evidence();
  assert.equal(newEvidence(base, evidenceFor('web/lib/renamed.ts', 'eval(input);', [message])).length, 1);
  assert.deepEqual(newEvidence(base, []), []);
});
test('fatal parse errors and absent rule identity fail closed, not baseline debt', () => {
  for (const m of [{ ...message, fatal: true }, { ...message, ruleId: null }, { ...message, line: 999 }]) {
    assert.throws(() => evidenceFor('bad.ts', 'bad', [message, m]));
  }
});
test('red plants: eval, Function, debugger, unused expression; comments are not code', async () => {
  const source = 'export function planted(input: string) { eval(input); new Function(input); debugger; false; }';
  const [result] = await lint.lintText(source, { filePath: path.join(cwd, 'lib/brain.ts') });
  for (const rule of ['no-eval', 'no-new-func', 'no-debugger', '@typescript-eslint/no-unused-expressions']) {
    assert.ok(result.messages.some(m => m.ruleId === rule), rule);
  }
  const [safe] = await lint.lintText('// eval(input); new Function(input); debugger;\nexport const text = "eval(input)";\n', { filePath: path.join(cwd, 'scripts/quality/__safe_probe.mjs') });
  assert.equal(safe.messages.filter(m => ['no-eval', 'no-new-func', 'no-debugger'].includes(m.ruleId)).length, 0);
});
test('inline disable cannot hide a new finding', async () => {
  const [result] = await lint.lintText('/* eslint-disable no-eval */\neval("1");', { filePath: path.join(cwd, 'scripts/quality/__disable_probe.mjs') });
  assert.ok(result.messages.some(m => m.ruleId === 'no-eval'));
});
test('parser failure really rejects ingestion', async () => {
  const [result] = await lint.lintText('export function (', { filePath: path.join(cwd, 'scripts/quality/__broken_probe.mjs') });
  assert.throws(() => evidenceFor('broken.mjs', 'export function (', result.messages));
});
test('typed async red plant uses actual TypeScript program', async () => {
  // Existing tracked TS file anchors projectService; source is linted, not executed.
  const [result] = await lint.lintText('export async function probe() { Promise.resolve(42); await 42; }', { filePath: path.join(cwd, 'lib/brain.ts') });
  for (const rule of ['quality/no-floating-promises', 'quality/await-thenable']) assert.ok(result.messages.some(m => m.ruleId === rule), JSON.stringify(result.messages));
});
test('invalid rules are analyzer failure, never green', async () => {
  const broken = new ESLint({ cwd, overrideConfig: [{ rules: { 'quality-nonexistent': 'error' } }] });
  await assert.rejects(() => broken.lintText('1;', { filePath: 'scripts/quality/probe.mjs' }));
});
