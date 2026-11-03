// Tenant isolation through the real routes with two app instances on one Postgres (test/helpers/pg-tenant-instance.mts):
// two processes, each with its own pool, sign up two tenants and run sign-in, sign-out, scans and leads, a play (query
// scan), CSV export, quarantine, billing (checkout, signed Stripe webhook, portal) and usage at the same time, then each
// tries the other's ids. Sessions are the real ones (cookie -> sessions table), not a stubbed user. Each instance checks
// its own responses; this test then checks the rows in the store, tenant by tenant, and that nothing touched SQLite.
// Lib-level paths (SEO drafts, the work queue, rate limits) are covered the same way by multi-instance-isolation.test.ts.
// Not covered here: modules still on the raw SQLite handle (outreach drafts, campaigns, most settings;
// lib/db/pg-port-status.ts) cannot run on Postgres yet, and /api/ready reports 503 (split) while any remain.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { pgDb } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

const run = promisify(execFile)
const web = fileURLToPath(new URL('../', import.meta.url))
// test values only, under neutral names (the net fence deletes *KEY*/*SECRET*/*PASSWORD* variables from a child)
const env = { PT_WEBHOOK: 'whsec_test' + randomBytes(8).toString('hex'), PT_PW: randomBytes(6).toString('hex') }
type Result = { tag: string; tenant: string; job: string; query: string; leads: string[]; violations: string[] }

const instance = async (schema: string, tag: string, otherTag: string) => {
  const e: NodeJS.ProcessEnv = { ...process.env, ...env, PT_SCHEMA: schema, PT_TAG: tag, PT_OTHER_TAG: otherTag }
  delete e.NODE_TEST_CONTEXT; delete e.DATABASE_URL
  const r = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/pg-session-loader.mjs', './test/helpers/pg-tenant-instance.mts'],
    { cwd: web, env: e, encoding: 'utf8', timeout: 180_000 })
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as Result
}

test('[pg] two instances, two tenants, real sessions: no route reads, lists, exports or changes the other tenant', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 2 })
  try {
    await runPgMigrations(db.pool)
    await db.run('CREATE TABLE pt_barrier (phase TEXT NOT NULL, tag TEXT NOT NULL, value TEXT, PRIMARY KEY (phase, tag))')
    const [a, b] = await Promise.all([instance(s.schema, 'alpha', 'bravo'), instance(s.schema, 'bravo', 'alpha')])
    assert.deepEqual(a.violations, [], `alpha: ${a.violations.join('\n')}`)
    assert.deepEqual(b.violations, [], `bravo: ${b.violations.join('\n')}`)
    assert.notEqual(a.tenant, b.tenant)

    for (const [me, other] of [[a, b], [b, a]] as const) {
      const t = me.tenant
      // accounts and sessions: one user each; after sign-out exactly one live session each, its own (the signed-out one
      // is kept, revoked, as the record of who ended it and when: lib/sessions.ts)
      assert.deepEqual((await db.all<{ email: string }>('SELECT email FROM users WHERE id = ?', [t])).map(r => r.email), [`${me.tag}@example.test`])
      assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL', [t]))!.n), 1)
      assert.deepEqual(await db.all('SELECT revoke_reason, revoked_by FROM sessions WHERE user_id = ? AND revoked_at IS NOT NULL', [t]), [{ revoke_reason: 'signed_out', revoked_by: t }])
      // scans and the play: the tenant's own two, the play still pending (the other's cancel changed nothing)
      const jobs = await db.all<{ id: string; status: string; query: string | null }>('SELECT id, status, query FROM scan_jobs WHERE user_id = ? ORDER BY id', [t])
      assert.deepEqual(jobs.map(j => j.id), [me.job, me.query].sort())
      assert.equal(jobs.find(j => j.id === me.query)!.status, 'pending')
      assert.equal(jobs.find(j => j.id === me.query)!.query, `SECRET-${me.tag}-PLAY`)
      // leads: on the tenant's own scan only; quarantine exactly as the owner left it (the other's attempts changed nothing)
      const leads = await db.all<{ id: string; company: string; quarantined_at: number | null }>('SELECT l.id, l.company, l.quarantined_at FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ? ORDER BY l.company', [t])
      assert.deepEqual(leads.map(l => [l.id, l.company, l.quarantined_at != null]), [[me.leads[0], `SECRET-${me.tag}-CO-1`, false], [me.leads[1], `SECRET-${me.tag}-CO-2`, true]])
      // billing rows: Pro with the tenant's own customer
      assert.deepEqual(await db.get('SELECT plan, stripe_customer_id FROM tenant_plans WHERE tenant_id = ?', [t]), { plan: 'pro', stripe_customer_id: `cus_${me.tag}` })
      // nothing of the other tenant in any row this tenant owns
      const owned = JSON.stringify({ jobs, leads, plan: await db.all('SELECT * FROM tenant_plans WHERE tenant_id = ?', [t]) })
      for (const leak of [other.tenant, other.tag, other.job, other.query, ...other.leads]) assert.ok(!owned.includes(leak), `${me.tag}'s rows hold ${leak}`)
    }
    assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM stripe_events'))!.n), 2)
    // every write went to Postgres: the SQLite path the instances were given was never created
    assert.equal(existsSync('/nonexistent-dazl-dir'), false)
  } finally { await db.close(); await s.drop() }
})
