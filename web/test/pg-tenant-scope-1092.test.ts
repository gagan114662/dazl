import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { pgDb } from '../lib/db/client.ts'
import { withTenantTransaction } from '../lib/db/tenant-scope.ts'
import { freshSchema, PG_URL, pgSkip } from './helpers/pg-test.ts'

test('[pg] tenant scope restricts an unfiltered query and clears after commit and rollback', { skip: pgSkip }, async () => {
  const { schema, drop } = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: schema, max: 1 })
  const role = `scope_${randomBytes(7).toString('hex')}`
  const tenantA = randomBytes(10).toString('hex')
  const tenantB = randomBytes(10).toString('hex')
  const readSql = 'SELECT tenant_id FROM scoped_leads ORDER BY tenant_id'
  let roleCreated = false
  try {
    await db.run(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`)
    roleCreated = true
    await db.run('CREATE TABLE scoped_leads (tenant_id TEXT NOT NULL, id TEXT PRIMARY KEY)')
    await db.run('INSERT INTO scoped_leads VALUES (?, ?), (?, ?)', [tenantA, 'one', tenantB, 'two'])
    await db.run('ALTER TABLE scoped_leads ENABLE ROW LEVEL SECURITY')
    await db.run("CREATE POLICY own_rows ON scoped_leads USING (tenant_id = current_setting('app.tenant_id', true))")
    await db.run(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`)
    await db.run(`GRANT SELECT, INSERT ON scoped_leads TO ${role}`)

    const asRole = `SET LOCAL ROLE ${role}`
    const visible = (tenantId: string) => withTenantTransaction(db, tenantId, function* (tx) {
      yield* tx.run(asRole)
      return yield* tx.all<{ tenant_id: string }>(readSql)
    })
    assert.deepEqual(await visible(tenantA), [{ tenant_id: tenantA }])
    const unscoped = () => db.tx(function* (tx) {
      yield* tx.run(asRole)
      return yield* tx.all(readSql)
    })
    assert.deepEqual(await unscoped(), [], 'commit does not carry a tenant on the single pooled connection')
    assert.deepEqual(await visible(tenantB), [{ tenant_id: tenantB }], 'an unrelated tenant retains its own access')
    await assert.rejects(withTenantTransaction(db, tenantA, function* (tx) {
      yield* tx.run(asRole)
      yield* tx.run('INSERT INTO scoped_leads VALUES (?, ?)', [tenantB, 'foreign'])
    }), /row-level security/)
    assert.deepEqual(await unscoped(), [], 'rollback clears the failed transaction scope')
    assert.deepEqual(await visible(tenantB), [{ tenant_id: tenantB }], 'the rejected write did not change tenant B')
  } finally {
    try {
      await drop()
      if (roleCreated) await db.run(`DROP ROLE ${role}`)
    } finally { await db.close() }
  }
})
