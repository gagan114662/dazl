// PR #959 / #931: runs test/helpers/replies-lifecycle-runtime.mts in its own process (it loads the real route handler
// through the test route loader): revoke / accept / reload, grant missing, reconnect, refused sync, separate bounce-scan consent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const web = fileURLToPath(new URL('../', import.meta.url))

test('reply-reading consent lifecycle through the real /api/outreach/replies route', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0' }
  delete env.NODE_TEST_CONTEXT // the child reports as its own run, so its output is readable here
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/replies-lifecycle-runtime.mts'], { cwd: web, env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined, String(r.error))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /(# |ℹ )fail 0/)
  assert.match(r.stdout, /(# |ℹ )pass 4/)
})
