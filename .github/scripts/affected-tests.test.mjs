// Qodo finding on #1437: a changed nested fixture such as web/test/fixtures/gate-check/pass.test.mjs was emitted as-is by
// affected-tests.mjs, and web-ci's shard validator (top-level test files only) rejected it, failing both lanes.
// A nested test-tree change must cover all direct and indirect consumers, without running the fixture itself. Run: node --test '.github/scripts/*.test.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const select = fileURLToPath(new URL('./affected-tests.mjs', import.meta.url))
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const run = (cwd, ...args) => execFileSync(process.execPath, [select, ...args], { cwd, encoding: 'utf8' }).trim()
const workflow = readFileSync(new URL('../workflows/web-ci.yml', import.meta.url), 'utf8')
const blocks = [...workflow.matchAll(/^          # the full list[^\n]*\n(?:^          .*\n)+/gm)]
function runShards(cwd, selection) {
  assert.equal(blocks.length, 2, 'each database lane must have its shard runner')
  const env = {...process.env, SEL: selection}
  delete env.NODE_TEST_CONTEXT
  for (const [lane, [body]] of blocks.entries()) {
    // Count actual test callbacks, not reporter output: Node's TAP can print
    // the same test label for both its subtest header and its result.
    const trace = join(cwd, `consumers-${lane}.log`)
    writeFileSync(trace, '')
    env.FIXTURE_CONSUMER_TRACE = trace
    for (let shard = 1; shard <= 4; shard++) {
      const command = body.replaceAll('${{ github.event_name }}', 'pull_request').replaceAll('${{ matrix.shard }}', String(shard))
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', command], {
        cwd: join(cwd, 'web'), env, encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stdout + result.stderr)
    }
    assert.deepEqual(readFileSync(trace, 'utf8').split('\n').filter(Boolean).sort(), ['direct', 'indirect'],
      'both top-level consumer callbacks execute exactly once per database lane')
  }
}

function repo(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'dazl-affected-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  git(cwd, 'init', '-b', 'main'); git(cwd, 'config', 'user.name', 'CI fixture'); git(cwd, 'config', 'user.email', 'ci@invalid.test')
  mkdirSync(join(cwd, 'web/test/fixtures/gate-check'), { recursive: true })
  mkdirSync(join(cwd, 'web/test/helpers'))
  mkdirSync(join(cwd, 'web/lib'))
  writeFileSync(join(cwd, 'web/package.json'), JSON.stringify({type:'module',scripts:{test:
    'SITECRAWL_ENABLED=0 NEWS_SEARCH_ENABLED=0 node --experimental-strip-types --import ./test/helpers/net-fence.ts --test test/*.test.ts test/crm-webhook-unknown-ui.test.mjs'}}))
  writeFileSync(join(cwd, 'web/test/helpers/net-fence.ts'), 'export {}')
  writeFileSync(join(cwd, 'web/test/crm-webhook-unknown-ui.test.mjs'), 'export {}')
  writeFileSync(join(cwd, 'web/lib/other.ts'), 'export {}')
  writeFileSync(join(cwd, 'web/test/gate-check.test.ts'), "import test from 'node:test'; import {appendFileSync} from 'node:fs'; test('fixture direct consumer',()=>appendFileSync(process.env.FIXTURE_CONSUMER_TRACE, 'direct\\n')); // test/fixtures/gate-check")
  writeFileSync(join(cwd, 'web/test/indirect.test.ts'), "import test from 'node:test'; import {appendFileSync} from 'node:fs'; import './helpers/runtime.mts'; test('fixture indirect consumer',()=>appendFileSync(process.env.FIXTURE_CONSUMER_TRACE, 'indirect\\n'))")
  writeFileSync(join(cwd, 'web/test/helpers/runtime.mts'), "import {statSync} from 'node:fs'; statSync(new URL('../fixtures/gate-check/pass.test.mjs',import.meta.url))")
  writeFileSync(join(cwd, 'web/test/other.test.ts'), "import '../lib/other.ts'")
  writeFileSync(join(cwd, 'web/test/fixtures/gate-check/pass.test.mjs'), 'export {}')
  git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'base')
  return [cwd, git(cwd, 'rev-parse', 'HEAD')]
}

test('a fixture-only change executes both top-level consumers, never the nested fixture', t => {
  const [cwd, base] = repo(t)
  writeFileSync(join(cwd, 'web/test/fixtures/gate-check/pass.test.mjs'), "throw Error('nested fixture must not execute')")
  git(cwd, 'commit', '-am', 'fixture only')
  const out = run(cwd, base, 'HEAD')
  assert.equal(out, 'ALL')
  runShards(cwd, out)
})

test('a nested test-tree change nobody references falls back to ALL instead of an invalid entry', t => {
  const [cwd, base] = repo(t)
  mkdirSync(join(cwd, 'web/test/fixtures/orphan'), { recursive: true })
  writeFileSync(join(cwd, 'web/test/fixtures/orphan/x.test.mjs'), 'export {}')
  git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'orphan fixture')
  assert.equal(run(cwd, base, 'HEAD'), 'ALL')
})

test('a changed top-level test still selects itself', t => {
  const [cwd, base] = repo(t)
  writeFileSync(join(cwd, 'web/test/other.test.ts'), "import '../lib/other.ts' // edit")
  git(cwd, 'commit', '-am', 'top-level test')
  assert.equal(run(cwd, base, 'HEAD'), 'test/other.test.ts')
})


test('fast PR checks run explicitly changed tests when shared changes require the full tier', t => {
  const [cwd] = repo(t)
  mkdirSync(join(cwd, '.github/scripts'), { recursive: true })
  writeFileSync(join(cwd, '.github/scripts/affected-tests.mjs'), readFileSync(select))
  writeFileSync(join(cwd, 'web/test/helpers/runtime.mts'), 'export {}')
  writeFileSync(join(cwd, 'web/test/other.test.ts'), "console.log('changed test executed')")
  writeFileSync(join(cwd, 'web/test/rename-source.test.ts'), "console.log('renamed test executed')")
  git(cwd, 'add', 'web/test/rename-source.test.ts')
  git(cwd, 'commit', '-m', 'add test to rename', '--', 'web/test/rename-source.test.ts')
  const beforeChanges = git(cwd, 'rev-parse', 'HEAD')
  git(cwd, 'mv', 'web/test/rename-source.test.ts', 'web/test/rename-target.test.ts')
  git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'shared and top-level changes')
  const start = workflow.indexOf('      - name: Run affected unit tests')
  assert.ok(start >= 0)
  const body = workflow.slice(start).match(/^        run: \|\n((?:^          .*\n)+)/m)?.[1]
  assert.ok(body)
  const env = { ...process.env, PR_BASE_SHA: beforeChanges, GITHUB_SHA: git(cwd, 'rev-parse', 'HEAD'),
    GITHUB_STEP_SUMMARY: join(cwd, 'summary') }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync('bash', ['-e', '-c', body], { cwd: join(cwd, 'web'), env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /changed test executed/)
  assert.match(result.stdout, /renamed test executed/)
  assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /Shared changes require the full tier/)
})

test('renamed library source selects its consumers while a docs-only diff selects none', t => {
  const [cwd, base] = repo(t)
  git(cwd, 'mv', 'web/lib/other.ts', 'web/lib/renamed.ts')
  git(cwd, 'commit', '-m', 'rename library source')
  assert.equal(git(cwd, 'diff', '--name-status', '-M', base, 'HEAD'), 'R100\tweb/lib/other.ts\tweb/lib/renamed.ts')
  assert.equal(run(cwd, base, 'HEAD'), 'test/other.test.ts')

  const renamed = git(cwd, 'rev-parse', 'HEAD')
  writeFileSync(join(cwd, 'README.md'), '# Documentation')
  git(cwd, 'add', 'README.md')
  git(cwd, 'commit', '-m', 'docs only')
  assert.equal(run(cwd, renamed, 'HEAD'), 'NONE')
})
