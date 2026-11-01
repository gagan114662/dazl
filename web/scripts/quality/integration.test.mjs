import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('actual git gate: clean/shift/delete pass; substitution/rename/add/parse/missing/shallow fail', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'quality-integration-'));
  const cwd = path.join(root, 'web');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = () => { git('add', '.'); git('-c', 'user.name=Calibration', '-c', 'user.email=calibration@example.invalid', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  const run = (base, expected, dir = cwd) => {
    const output = path.join(root, 'evidence.json');
    const result = spawnSync(process.execPath, [path.join(dir, 'scripts/quality/gate.mjs'), '--base', base, '--report', output], { encoding: 'utf8', timeout: 45000 });
    assert.equal(result.status, expected, result.stdout + result.stderr);
    return readFile(output, 'utf8').then(JSON.parse);
  };
  try {
    await mkdir(path.join(cwd, 'scripts'), { recursive: true });
    await cp(path.join(web, 'scripts/quality'), path.join(cwd, 'scripts/quality'), { recursive: true });
    await cp(path.join(web, 'eslint.config.mjs'), path.join(cwd, 'eslint.config.mjs'));
    await symlink(path.join(web, 'node_modules'), path.join(cwd, 'node_modules'), 'dir');
    await writeFile(path.join(root, '.gitignore'), 'node_modules\n');
    git('init', '-q');
    await writeFile(path.join(cwd, 'source.mjs'), 'export const old = eval("1");\n');
    const base = commit();
    assert.equal((await run(base, 0)).status, 'passed');
    await writeFile(path.join(cwd, 'source.mjs'), '// line shift\nexport const old = eval("1");\n'); commit();
    assert.equal((await run(base, 0)).newFindings.length, 0);
    await writeFile(path.join(cwd, 'source.mjs'), 'export const old = eval("2");\n'); commit();
    assert.ok((await run(base, 1)).newFindings.some(f => f.rule === 'no-eval'));
    git('reset', '--hard', base); git('mv', 'web/source.mjs', 'web/renamed.mjs'); commit();
    assert.ok((await run(base, 1)).newFindings.length);
    git('reset', '--hard', base); git('rm', 'web/source.mjs'); commit();
    assert.equal((await run(base, 0)).status, 'passed');
    await writeFile(path.join(cwd, 'new.mjs'), '/* eslint-disable no-eval */\nexport const added = eval("1");\n'); commit();
    assert.ok((await run(base, 1)).newFindings.some(f => f.rule === 'no-eval'));
    await writeFile(path.join(cwd, 'new.mjs'), 'export function ('); commit();
    assert.equal((await run(base, 1)).status, 'unavailable');
    assert.equal((await run('0'.repeat(40), 1)).status, 'unavailable');
    assert.equal((await run('not-a-sha', 1)).status, 'unavailable');
    const shallow = path.join(root, 'shallow');
    execFileSync('git', ['clone', '--depth=1', `file://${root}`, shallow], { stdio: 'pipe' });
    await symlink(path.join(web, 'node_modules'), path.join(shallow, 'web/node_modules'), 'dir');
    assert.equal((await run(base, 1, path.join(shallow, 'web'))).status, 'unavailable');
  } finally { await rm(root, { recursive: true, force: true }); }
});
