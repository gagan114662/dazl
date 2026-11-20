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
  for (const [body] of blocks) {
    const nodes = []
    for (let shard = 1; shard <= 4; shard++) {
      const command = body.replaceAll('${{ github.event_name }}', 'pull_request').replaceAll('${{ matrix.shard }}', String(shard))
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', command], {
        cwd: join(cwd, 'web'), env, encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stdout + result.stderr)
      nodes.push(result.stdout)
    }
    const all = nodes.join('\n')
    for (const label of ['fixture direct consumer', 'fixture indirect consumer']) {
      assert.equal(all.split(label).length - 1, 1, `${label} must execute exactly once per database lane`)
    }
    assert.doesNotMatch(all, /nested fixture must not execute/)
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
  writeFileSync(join(cwd, 'web/test/gate-check.test.ts'), "import test from 'node:test'; test('fixture direct consumer',()=>{}); // test/fixtures/gate-check")
  writeFileSync(join(cwd, 'web/test/indirect.test.ts'), "import test from 'node:test'; import './helpers/runtime.mts'; test('fixture indirect consumer',()=>{})")
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
