// Runs test/helpers/tenant-requests-runtime.mts in its own process (route handlers through the test route loader):
// tenant export and deletion requests (#359 part 2). Also the operator CLI on a temporary store file.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { requestDeletion } from '../lib/tenant/requests.ts'

const web = fileURLToPath(new URL('../', import.meta.url))

test('settings data routes and the operator step: requests change nothing, only a confirmed operator run deletes', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/tenant-requests-runtime.mts'], { cwd: web, env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined, String(r.error))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# fail 0/); assert.match(r.stdout, /# pass 4/)
})

test('operator CLI: list is read-only, execute without --confirm is a dry run, --confirm deletes, no policy is refused', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tenant-req-cli-'))
  const file = path.join(dir, 'app.db'), policy = path.join(dir, 'policy.json')
  const db = new Database(file); migrateAllSqlite(db)
  db.prepare("INSERT INTO users (id, email, password_hash, salt) VALUES ('t1', 't1@x.io', 'h', 's')").run()
  db.prepare("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES ('t1', 'w', 'personal', 't1', 1)").run()
  db.prepare("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES ('t1', 't1', 'owner', 1)").run()
  const req = await requestDeletion(sqliteDb(db), 't1')
  assert.ok(!('refused' in req)); db.close()
  writeFileSync(policy, JSON.stringify({ suppressions: 'erase' }))
  const cli = (...a: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/tenant-requests.mts', ...a, '--db', file], { cwd: web, encoding: 'utf8' })
  let r = cli('list', '--status', 'pending'); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout)[0].id, req.id)
  r = cli('execute', '--request', req.id, '--operator', 'ops-alex'); assert.equal(r.status, 2); assert.match(r.stderr, /--policy POLICY.json is required/)
  r = cli('execute', '--request', req.id, '--operator', 'ops-alex', '--policy', policy); assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /dry run only/)
  const check = new Database(file, { readonly: true })
  assert.equal((check.prepare("SELECT count(*) AS n FROM users WHERE id = 't1'").get() as { n: number }).n, 1, 'dry run deleted nothing'); check.close()
  r = cli('execute', '--request', req.id, '--operator', 'ops-alex', '--policy', policy, '--confirm'); assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).executed.state, 'completed')
  const after = new Database(file, { readonly: true })
  assert.equal((after.prepare("SELECT count(*) AS n FROM users WHERE id = 't1'").get() as { n: number }).n, 0); after.close()
})
