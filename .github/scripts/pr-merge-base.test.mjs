import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const verify = fileURLToPath(new URL('./pr-merge-base.mjs', import.meta.url))
const select = fileURLToPath(new URL('./affected-tests.mjs', import.meta.url))
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const node = (cwd, script, ...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })
function write(cwd, path, value) { writeFileSync(join(cwd, path), value) }
function commit(cwd, message) { git(cwd, 'add', '.'); git(cwd, 'commit', '-m', message); return git(cwd, 'rev-parse', 'HEAD') }

test('PR selection excludes base-only advances, but retains genuine PR changes and plumbing fallback', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'dazl-pr-scope-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  git(cwd, 'init', '-b', 'main')
  git(cwd, 'config', 'user.name', 'CI fixture')
  git(cwd, 'config', 'user.email', 'ci@invalid.test')
  for (const path of ['web/lib', 'web/test/helpers']) mkdirSync(join(cwd, path), { recursive: true })
  write(cwd, 'web/lib/target.ts', 'export const flag = 0')
  write(cwd, 'web/test/target.test.ts', "import '../lib/target.ts'")
  const old = commit(cwd, 'base before the pull request')
  git(cwd, 'checkout', '-b', 'pr')
  write(cwd, 'web/lib/target.ts', 'export const flag = 1')
  const pr = commit(cwd, 'change the module, no plumbing')
  git(cwd, 'checkout', 'main')
  write(cwd, 'web/test/helpers/main-only.ts', 'export const baseChange = true')
  const base = commit(cwd, 'advance main only')
  git(cwd, 'checkout', '--detach')
  git(cwd, 'merge', '--no-ff', pr)
  const merge = git(cwd, 'rev-parse', 'HEAD')

  assert.equal(node(cwd, select, old, merge).stdout.trim(), 'ALL', 'the stale pair reproduces the timeout trigger')
  for (const eventBase of [old, base]) {
    const result = node(cwd, verify, merge, pr, eventBase)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), base)
    assert.equal(node(cwd, select, result.stdout.trim(), merge).stdout.trim(), 'test/target.test.ts')
  }
  for (const [commit, head, eventBase] of [[pr, pr, old], [merge, old, old], [merge, pr, pr], [merge, pr, 'HEAD']]) {
    const result = node(cwd, verify, commit, head, eventBase)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '', 'never return an unverified narrowed base')
  }

  git(cwd, 'checkout', 'pr')
  mkdirSync(join(cwd, 'web/test/helpers'), { recursive: true })
  write(cwd, 'web/test/helpers/pr-only.ts', 'export const truePlumbingChange = true')
  const plumbingHead = commit(cwd, 'change a shared helper in the PR itself')
  git(cwd, 'checkout', '--detach', base)
  git(cwd, 'merge', '--no-ff', plumbingHead)
  const plumbingMerge = git(cwd, 'rev-parse', 'HEAD')
  const verified = node(cwd, verify, plumbingMerge, plumbingHead, old)
  assert.equal(verified.status, 0, verified.stderr)
  assert.equal(node(cwd, select, verified.stdout.trim(), plumbingMerge).stdout.trim(), 'ALL')

  git(cwd, 'checkout', 'pr')
  assert.equal(node(cwd, verify, plumbingHead, plumbingHead, old).status, 1, 'a plain head checkout has no merge parents')
})


test('both PR test jobs use the verified merge base rather than the event snapshot', () => {
  const workflow = readFileSync(new URL('../workflows/web-ci.yml', import.meta.url), 'utf8')
  for (const fragment of [
    'pr-merge-base.mjs "$GITHUB_SHA" "$PR_HEAD_SHA" "$PR_EVENT_BASE_SHA"',
    'affected-tests.mjs "$PR_BASE_SHA" "$GITHUB_SHA"',
  ]) {
    assert.equal(workflow.split(fragment).length - 1, 2, fragment)
  }
  assert.match(workflow, /git diff --name-only "\$PR_BASE_SHA\.\.\.\$GITHUB_SHA"/)
})
