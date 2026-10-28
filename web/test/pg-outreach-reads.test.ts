// The follow-ups page and reply-thread metrics on Postgres with two tenants, through the real /api/outreach/followups
// and /api/replies/thread-metrics handlers (test/helpers/pg-outreach-reads-runtime.mts, run under the route loader):
// each tenant gets only its own threads, sent follow-ups, Gmail account, switch and metrics, and a thread row that names
// another tenant's lead never shows that lead's company.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pgSkip } from './helpers/pg-test.ts'

test('[pg] follow-ups and thread metrics: each tenant reads only its own rows through the routes', { skip: pgSkip }, () => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/pg-outreach-reads-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 1\b/)
  assert.match(r.stdout, /PG_OUTREACH_READS ok/)
})
