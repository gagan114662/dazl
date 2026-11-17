import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { stagingFakeReplies } from '../lib/outreach/staging-fake-replies.ts'

// #413: TEST-ONLY staging reply source, so the live check can watch ingest, suppression, the refused second send and the
// stale-safety hold through the real tick at $0, without a real Gmail client (test/helpers/staging-fake-replies-runtime.mts).
test('#413 the staging fake reply source is inert outside staging, with a real staging Gmail, or without the flag', () => {
  assert.equal(stagingFakeReplies({ DAZL_STAGING_FAKE_REPLIES: '1' }), false)
  assert.equal(stagingFakeReplies({ DAZL_ENV: 'production', DAZL_STAGING_FAKE_REPLIES: '1' }), false)
  assert.equal(stagingFakeReplies({ DAZL_ENV: 'staging' }), false)
  assert.equal(stagingFakeReplies({ DAZL_ENV: 'staging', DAZL_STAGING_FAKE_REPLIES: '1', DAZL_STAGING_REAL_GMAIL: '1', GMAIL_STAGING_CLIENT_ID: 'a', GMAIL_STAGING_CLIENT_SECRET: 'b', DAZL_STAGING_GMAIL_ALLOWLIST: 'x@y.test' }), false)
  assert.equal(stagingFakeReplies({ DAZL_ENV: 'staging', DAZL_STAGING_FAKE_REPLIES: '1' }), true)
})

test('#413 staging fake replies through the real tick route', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/staging-fake-replies-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 2/)
})
