import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Automatic deletion of audit events is OFF until the owner chooses a period (#371, lib/audit.ts auditRetention): the
// real tick route with AUDIT_RETENTION_DAYS unset, off or invalid deletes nothing, and a valid explicit period deletes
// only older events in bounded batches (test/helpers/audit-retention-tick-runtime.mts).
test('tick route: audit retention is off unless explicitly configured; a valid period purges bounded and fenced', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.AUDIT_RETENTION_DAYS
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/audit-retention-tick-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 2/)
  assert.match(r.stdout, /# fail 0/)
})
