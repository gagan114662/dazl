// #997 C1 of #920: characterization only, no product database cutover.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('status HTTP production authentication/domain/queue compatibility boundary (C1)', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0' }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/status-boundary-loader.mjs', '--test', './test/helpers/status-boundary-runtime.mts'], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 90000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /\[sqlite\] actual status HTTP/)
  if (env.DAZL_REQUIRE_PG === '1' || env.DAZL_TEST_PG_URL) assert.doesNotMatch(r.stdout, /# SKIP/)
})
