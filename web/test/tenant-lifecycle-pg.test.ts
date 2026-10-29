// Tenant export and deletion (lib/tenant/lifecycle.ts) on Postgres: the schema from every migration (0015 adds the
// tombstone tables and the guard triggers), a marked row in every tenant-scoped table for two tenants
// (test/helpers/tenant-seed.ts). Export is complete and leak-free; deletion empties the target, leaves the other tenant
// byte-identical, records what was retained; the guard refuses late writes. Skipped without DAZL_TEST_PG_URL; CI's
// postgres job sets DAZL_REQUIRE_PG so it cannot skip there.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pgDb } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { deleteTenant, exportTenant, EXPORT_EXCLUDED } from '../lib/tenant/lifecycle.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'
import { seedTenant, snapshot, tenantTables } from './helpers/tenant-seed.ts'

if (!PG_URL && process.env.DAZL_REQUIRE_PG === '1') throw new Error('DAZL_REQUIRE_PG=1 but DAZL_TEST_PG_URL is not set')
const A = 'pg-tenant-aaaa', B = 'pg-tenant-bbbb'

test('postgres: export complete, deletion erases only the target, other tenant byte-identical, late writes refused', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema })
  try {
    await runPgMigrations(db.pool)
    for (const [id, tag] of [[A, 'pa'], [B, 'pb']]) {
      await db.run("INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, 'x', 'y')", [id, `${tag}@example.test`])
      const r = await seedTenant(db, id, tag)
      assert.deepEqual(r.failed, {}, `every tenant table seeded for ${id}`)
      // a personal workspace: its organizations row, its founder as the sole owner
      await db.run("UPDATE memberships SET member_id = ?, role = 'owner' WHERE tenant_id = ?", [id, id])
      await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, ?, 'personal', ?, 1) ON CONFLICT (id) DO NOTHING", [id, `${id} workspace`, id])
    }
    const tables = [...(await tenantTables(db)).keys()]
    assert.ok(tables.length >= 70, `${tables.length} tenant tables`)
    const e = await exportTenant(db, A)
    for (const t of tables.filter(t => !EXPORT_EXCLUDED[t])) assert.ok(e.tables[t]?.length, `export has ${t}`)
    assert.ok(!JSON.stringify(e).includes('pb~'), 'nothing of the other tenant')
    const bBefore = await snapshot(db, B)
    const t = await deleteTenant(db, A, { policy: { suppressions: 'retain' }, requestedBy: 'synthetic pg test' })
    assert.equal(t.state, 'completed'); assert.deepEqual(JSON.parse(t.retained!), { evidence_purge_audit: 1, suppressions: 1 })
    const after = await snapshot(db, A)
    assert.deepEqual(Object.entries(after).filter(([k, v]) => !['suppressions', 'evidence_purge_audit'].includes(k) && v !== '[]').map(([k]) => k), [])
    assert.deepEqual(await snapshot(db, B), bBefore, 'the other tenant is byte-identical')
    await assert.rejects(db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES ('late', ?, 'x', 'y', 'z')", [A]), /tenant deleted/)
    assert.equal((await db.get<{ n: number }>('SELECT count(*) AS n FROM organizations WHERE id = ?', [A]))!.n, 0)
    await assert.rejects(db.run("INSERT INTO users (id, email, password_hash, salt) VALUES (?, 'again@example.test', 'x', 'y')", [A]), /tenant deleted/)
    await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES ('b-late', ?, 'x', 'y', 'z')", [B])
  } finally { await db.close(); await s.drop() }
})
