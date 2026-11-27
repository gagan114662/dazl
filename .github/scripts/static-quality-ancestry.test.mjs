import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const workflow = readFileSync(new URL('../workflows/static-quality.yml', import.meta.url), 'utf8')
const resolver = workflow.match(/- name: Resolve exact comparison[^\n]*\n[\s\S]*?        run: \|\n([\s\S]*?)(?=^ {6}- name:)/m)[1]
  .replace(/^ {10}/gm, '')

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'static-quality-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'CI fixture')
  git('config', 'user.email', 'ci@invalid.test')
  function commit(file, date = '2026-01-01T00:00:00Z') {
    writeFileSync(join(cwd, file), file)
    git('add', file)
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', file], {
      cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    })
    return git('rev-parse', 'HEAD')
  }
  function resolve(base, event = 'pull_request') {
    const output = join(cwd, 'github-env')
    rmSync(output, { force: true })
    const result = spawnSync('bash', ['-c', resolver], {
      cwd, encoding: 'utf8', env: { ...process.env, BASE: base, EVENT_KIND: event, GITHUB_ENV: output },
    })
    return { ...result, comparison() { return readFileSync(output, 'utf8').trim().split('=')[1] } }
  }
  return { git, commit, resolve }
}

for (const [count, date, passes] of [
  [3, '2026-01-03T00:00:00Z', true],
  [31, '2026-01-01T12:00:00Z', true],
  [31, '2026-01-03T00:00:00Z', false],
]) {
  test(`PR base ${count} commits ahead at ${date}`, t => {
    const { git, commit, resolve } = fixture(t)
    const fork = commit('shared')
    git('branch', 'pr')
    let base
    for (let index = 0; index < count; index++) base = commit(`main-${index}`, date)
    git('checkout', 'pr')
    commit('pr-only')
    const result = resolve(base)
    if (passes) {
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.comparison(), fork)
      assert.equal(git('diff', '--name-only', result.comparison(), 'HEAD'), 'pr-only')
    } else {
      assert.equal(result.status, 1)
      assert.match(result.stderr, /31 commits.*rebase/)
    }
    for (const event of ['push', 'merge_group', 'workflow_dispatch']) {
      assert.equal(resolve(base, event).status, 1)
      const exact = resolve(fork, event)
      assert.equal(exact.status, 0, exact.stderr)
      assert.equal(exact.comparison(), fork)
    }
  })
}

test('PR rejects malformed, missing, disconnected, and off-first-parent bases', t => {
  const { git, commit, resolve } = fixture(t)
  commit('shared')
  git('checkout', '-b', 'side')
  commit('side')
  git('checkout', 'main')
  commit('main')
  git('-c', 'commit.gpgsign=false', 'merge', '--no-ff', 'side')
  const base = git('rev-parse', 'HEAD')
  git('checkout', 'side')
  for (const invalid of ['HEAD', 'a'.repeat(40), base]) {
    const result = resolve(invalid)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /rebase/)
  }
  git('checkout', '--orphan', 'disconnected')
  git('rm', '-rf', '.')
  commit('unrelated')
  const result = resolve(base)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /rebase/)
})
