// Two personal workspaces, A and B, with a marked row in every tenant-scoped table, on either engine (the lifecycle
// tests' fixture): each tenant's users row, its organizations row (kind personal) and itself as the sole owner member.
import assert from 'node:assert/strict'
import type { EngineCtx } from './engines.ts'
import { seedTenantSqlite, snapshotSqlite } from './tenant-seed-sqlite.ts'
import { seedTenant, snapshot } from './tenant-seed.ts'

export type Fixture = { ids: Record<string, Record<string, string>>; snap: (tenant: string) => Promise<Record<string, string>> }
export async function tenantFixture(c: EngineCtx, tenants: [string, string][]): Promise<Fixture> {
  const ids: Fixture['ids'] = {}
  if (c.kind === 'sqlite') {
    for (const [t, tag] of tenants) {
      const s = seedTenantSqlite(c.raw!, t, tag); assert.deepEqual(s.failed, {}, `every tenant table seeded for ${t}`); ids[t] = s.ids
      c.raw!.prepare("UPDATE memberships SET member_id = ?, role = 'owner' WHERE tenant_id = ?").run(t, t)
      c.raw!.prepare("INSERT OR IGNORE INTO organizations (id, name, kind, created_by, created_at) VALUES (?, ?, 'personal', ?, 1)").run(t, `${t} workspace`, t)
    }
    return { ids, snap: async t => snapshotSqlite(c.raw!, t) }
  }
  for (const [t, tag] of tenants) {
    await c.db.run("INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, 'x', 'y')", [t, `${tag}@example.test`])
    const s = await seedTenant(c.db, t, tag); assert.deepEqual(s.failed, {}, `every tenant table seeded for ${t}`)
    ids[t] = Object.fromEntries(Object.entries(s.ids).map(([k, v]) => [k, v[0]]))
    await c.db.run("UPDATE memberships SET member_id = ?, role = 'owner' WHERE tenant_id = ?", [t, t])
    await c.db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, ?, 'personal', ?, 1) ON CONFLICT (id) DO NOTHING", [t, `${t} workspace`, t])
  }
  return { ids, snap: t => snapshot(c.db, t) }
}
// Engine-specific DDL for a BEFORE trigger whose body is one statement (tests inject failures and "other runs" with it).
export async function rawTrigger(c: EngineCtx, name: string, event: string, table: string, body: string): Promise<void> {
  if (c.kind === 'sqlite') { await c.db.run(`CREATE TRIGGER ${name} BEFORE ${event} ON ${table} BEGIN ${body}; END`); return }
  await c.db.run(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body.replace(/RAISE\(ABORT, '([^']*)'\)/, "RAISE EXCEPTION '$1'").replace(/^SELECT RAISE EXCEPTION/, 'RAISE EXCEPTION')}; RETURN OLD; END $$`)
  await c.db.run(`CREATE TRIGGER ${name} BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`)
}
export async function dropTrigger(c: EngineCtx, name: string, table: string): Promise<void> {
  await c.db.run(c.kind === 'sqlite' ? `DROP TRIGGER ${name}` : `DROP TRIGGER ${name} ON ${table}`)
  if (c.kind === 'pg') await c.db.run(`DROP FUNCTION ${name}()`)
}
