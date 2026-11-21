// Refs #1463: repo-wide guard tests run on every PR whatever changed, and a PR that only changes the test selector
// (.github/scripts/**) still runs web-ci. Run: node --test '.github/scripts/*.test.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const select = fileURLToPath(new URL('./affected-tests.mjs', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const always = () => {
  const m = readFileSync(select, 'utf8').match(/const ALWAYS = \[([\s\S]*?)\]/)
  assert.ok(m, 'affected-tests.mjs declares ALWAYS')
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])
}

test('web-ci runs on a pull request that only changes .github/scripts (the test selector)', () => {
  const yml = readFileSync(join(repoRoot, '.github/workflows/web-ci.yml'), 'utf8')
  const m = yml.match(/\n {2}pull_request:\n(?: {4}.*\n)*? {4}paths: \[([^\]]*)\]/)
  assert.ok(m, 'web-ci.yml has pull_request.paths')
  const paths = [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1])
  assert.ok(paths.includes('.github/scripts/**'), `pull_request.paths includes .github/scripts/** (got ${paths.join(', ')})`)
})

test('every repo-wide guard is named in the selector and exists in web/test', () => {
  const names = always()
  for (const n of ['ops-sentry.test.ts', 'ops-errors.test.ts', 'paid-paths-guarded.test.ts', 'tenant-isolation-manifest.test.ts',
    'route-error-capture.test.ts', 'test-discovery.test.ts', 'scan-spend-cap-paths.test.ts', 'server-action-probes-1088.test.ts',
    'preview-pipeline-fail-closed.test.ts', 'pg-fixture-honesty.test.ts']) assert.ok(names.includes(n), `${n} is always run`)
  for (const n of names) assert.ok(existsSync(join(repoRoot, 'web/test', n)), `${n} exists`)
})

test('guards are selected for an unrelated source change and for a change with no affected tests', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'dazl-guards-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  git(cwd, 'init', '-b', 'main'); git(cwd, 'config', 'user.name', 'CI'); git(cwd, 'config', 'user.email', 'ci@invalid.test')
  mkdirSync(join(cwd, 'web/test'), { recursive: true }); mkdirSync(join(cwd, 'web/lib'))
  for (const n of always()) writeFileSync(join(cwd, 'web/test', n), 'export {}')
  writeFileSync(join(cwd, 'web/test/unrelated.test.ts'), "import '../lib/other.ts'")
  writeFileSync(join(cwd, 'web/lib/other.ts'), 'export {}'); writeFileSync(join(cwd, 'web/lib/lonely.ts'), 'export {}')
  writeFileSync(join(cwd, 'README.md'), 'x')
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base'); const base = git(cwd, 'rev-parse', 'HEAD')
  const pick = from => execFileSync(process.execPath, [select, from], { cwd, encoding: 'utf8' }).trim().split(' ')
  writeFileSync(join(cwd, 'web/lib/other.ts'), 'export const x = 1'); git(cwd, 'commit', '-qam', 'src')
  const a = pick(base)
  assert.ok(a.includes('test/unrelated.test.ts'))
  for (const n of always()) assert.ok(a.includes(`test/${n}`), `${n} with a source change`)
  writeFileSync(join(cwd, 'web/lib/lonely.ts'), 'export const y = 1'); writeFileSync(join(cwd, 'README.md'), 'y'); git(cwd, 'commit', '-qam', 'nothing affected')
  const b = pick(git(cwd, 'rev-parse', 'HEAD~1'))
  assert.notDeepEqual(b, ['NONE'])
  for (const n of always()) assert.ok(b.includes(`test/${n}`), `${n} even when nothing else is affected`)
})
