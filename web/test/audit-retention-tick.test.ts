import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PG_URL, pgSkip } from './helpers/pg-test.ts'

// Automatic deletion of audit events is OFF until the owner chooses a period (#371, lib/audit.ts auditRetention): the
// real tick route with AUDIT_RETENTION_DAYS unset, off or invalid deletes nothing, and a valid explicit period deletes
// only older events in bounded batches (test/helpers/audit-retention-tick-runtime.mts), on SQLite and on Postgres.
function run(engine: 'sqlite' | 'pg') {
  const env: NodeJS.ProcessEnv = { ...process.env, AUDIT_TICK_ENGINE: engine }
  delete env.NODE_TEST_CONTEXT
  delete env.AUDIT_RETENTION_DAYS
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/audit-retention-tick-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 180000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, new RegExp(`\\[${engine}\\] unset, off and invalid`))
  assert.match(r.stdout, /# pass 2/)
  assert.match(r.stdout, /# fail 0/)
}

test('[sqlite] tick route: audit retention is off unless explicitly configured; a valid period purges bounded and fenced', () => run('sqlite'))
test('[pg] tick route: the same on a fresh Postgres schema', { skip: pgSkip }, () => { assert.ok(PG_URL); run('pg') })
