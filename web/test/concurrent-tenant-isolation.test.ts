// Tenant isolation with two app instances running concurrently on one Postgres (test/helpers/concurrent-tenant-instance.mts):
// two separate processes, each its own pool, signed in as tenant A and tenant B, run their rounds at the same time
// through the real routes: settings (memory, competitors, enrichment key), LinkedIn connections and warm paths, Cal.com
// secret and signed bookings, and signed Stripe webhooks with the plan read back. Each instance checks every read is
// only its own and every attempt on the other tenant is refused; then the rows each tenant owns are checked here, row by
// row, for anything of the other tenant. Stubbed throughout: no network call, Stripe fixtures signed with a test secret.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { pgDb, type Db } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

const run = promisify(execFile)
const web = fileURLToPath(new URL('../', import.meta.url))
const A = { tenant: 'a'.repeat(32), tag: 'tenantalpha', lead: 'a1'.repeat(12), job: 'a2'.repeat(12) }
const B = { tenant: 'b'.repeat(32), tag: 'tenantbravo', lead: 'b1'.repeat(12), job: 'b2'.repeat(12) }
const ROUNDS = 6
// test values only; the net fence deletes any *KEY*/*SECRET* variable from a child, so they travel under neutral names
const env = { CT_WEBHOOK: 'whsec_test' + randomBytes(8).toString('hex'), CT_MASTER: randomBytes(32).toString('base64') }

const instance = async (schema: string, me: typeof A, other: typeof A) => {
  const e: NodeJS.ProcessEnv = { ...process.env, ...env, CT_SCHEMA: schema, CT_TENANT: me.tenant, CT_TAG: me.tag, CT_LEAD: me.lead, CT_ROUNDS: String(ROUNDS), CT_OTHER: JSON.stringify(other) }
  delete e.NODE_TEST_CONTEXT
  const r = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs', './test/helpers/concurrent-tenant-instance.mts'],
    { cwd: web, env: e, encoding: 'utf8', timeout: 180_000 })
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { tag: string; rounds: number; violations: string[]; calcomSecret: string; startedAt: number; finishedAt: number }
}

async function seed(db: Db) {
  await db.run('CREATE TABLE ct_ready (instance TEXT NOT NULL)')
  for (const t of [A, B]) {
    await db.run("INSERT INTO users (id, email, password_hash, salt, business_name, created_at) VALUES (?, ?, 'h', 's', 'Co', 1)", [t.tenant, `${t.tag}@example.test`])
    await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, created_at) VALUES (?, ?, 'Co', 'dental', 'Toronto', 1)", [t.job, t.tenant])
    await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?", [t.job])
    await db.run("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, created_at) VALUES (?, ?, 'Pat', ?, 's', 'https://co.example.test/', 60, 1)", [t.lead, t.job, `${t.tag} Co`])
    // a contact at the tenant's own lead whose profile is in the tenant's connections, so its own warm path is non-empty
    await db.run("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES (?, ?, ?, 'apollo', 'contact', ?, ?, '2026-10-01', 1)",
      [`e${t.tag}`, t.lead, t.tenant, `${t.tag} Contact - CEO`, `https://www.linkedin.com/in/${t.tag}-contact-0`])
  }
}

test('[pg] two app instances, two tenants, at the same time: no read returns, and no write reaches, the other tenant', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 3 })
  try {
    await runPgMigrations(db.pool)
    await seed(db)
    const [ra, rb] = await Promise.all([instance(s.schema, A, B), instance(s.schema, B, A)])
    assert.deepEqual(ra.violations, [], 'tenant A instance')
    assert.deepEqual(rb.violations, [], 'tenant B instance')
    assert.deepEqual([ra.rounds, rb.rounds], [ROUNDS, ROUNDS])
    assert.ok(ra.startedAt < rb.finishedAt && rb.startedAt < ra.finishedAt, `the two instances ran at the same time (A ${ra.startedAt}-${ra.finishedAt}, B ${rb.startedAt}-${rb.finishedAt})`)

    // every row each tenant owns carries only that tenant's values
    const owned: [string, string][] = [
      ['tenant_memory', 'tenant_id'], ['tenant_competitors', 'tenant_id'], ['tenant_connections', 'tenant_id'], ['warm_user_paths', 'tenant_id'],
      ['calcom_hooks', 'tenant_id'], ['calcom_bookings', 'tenant_id'], ['tenant_connectors', 'tenant_id'], ['connector_audit', 'tenant_id'], ['tenant_plans', 'tenant_id'],
    ]
    for (const [table, col] of owned) {
      for (const [me, other] of [[A, B], [B, A]]) {
        const rows = await db.all(`SELECT * FROM ${table} WHERE ${col} = ?`, [me.tenant])
        assert.ok(!JSON.stringify(rows).includes(other.tag), `${table}: ${me.tag}'s rows hold ${other.tag}'s data`)
      }
    }
    for (const t of [A, B]) {
      const mem = await db.get<{ icp: string }>('SELECT icp FROM tenant_memory WHERE tenant_id = ?', [t.tenant])
      assert.equal(mem!.icp, `${t.tag} icp ${ROUNDS - 1}`)
      assert.deepEqual((await db.all<{ name: string }>('SELECT name FROM tenant_competitors WHERE tenant_id = ? ORDER BY position', [t.tenant])).map(r => r.name), [`${t.tag} Rival ${ROUNDS - 1}`])
      assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM tenant_connections WHERE tenant_id = ?', [t.tenant]))!.n), 2, 'the last import replaced the earlier ones')
      assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM calcom_bookings WHERE tenant_id = ?', [t.tenant]))!.n), ROUNDS, 'one booking per round, own secret only')
      assert.equal((await db.get<{ secret: string }>('SELECT secret FROM calcom_hooks WHERE tenant_id = ?', [t.tenant]))!.secret, (t === A ? ra : rb).calcomSecret)
      assert.deepEqual(await db.get('SELECT plan, subscription_status, stripe_customer_id FROM tenant_plans WHERE tenant_id = ?', [t.tenant]), { plan: 'free', subscription_status: 'canceled', stripe_customer_id: `cus_${t.tag}` })
    }
    assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM warm_user_paths'))!.n), 0, 'no path was attached to the other tenant\'s lead')
    assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM stripe_events'))!.n), 6, 'three events per tenant, each applied once')
  } finally { await db.close(); await s.drop() }
})
