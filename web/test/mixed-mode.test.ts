// Production shape while SQLite is the store: ported modules (auth, billing) use the Db layer and unported ones use the
// raw better-sqlite3 handle, on ONE connection. Concurrent requests of both kinds must all succeed, see only their own
// tenant's data, and never see or join another request's transaction, whether it commits or rolls back.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createPasswordUser, createSession, getSessionUser, sellerProfile, setSellerProfile } from '../lib/auth-db.ts'
import { resolveUser } from '../lib/auth-google.ts'
import { applyStripeEvent } from '../lib/billing/stripe.ts'
import { scanQuota } from '../lib/plans.ts'
import { getPlan } from './helpers/plan-fixture.ts'
import { createJob, listLeads } from '../lib/scan/store.ts'

test('mixed mode: concurrent ported transactions and raw requests on one SQLite connection', async () => {
  const raw = new Database(':memory:')
  migrateAllSqlite(raw)
  const db = sqliteDb(raw)

  // two tenants with a session, a profile and a finished scan with one lead each
  const tenants = ['A', 'B'] as const
  const token: Record<string, string> = {}
  const job: Record<string, string> = {}
  for (const t of tenants) {
    await createPasswordUser({ id: t, email: `${t}@x.com`, name: t, business_name: `Biz ${t}`, password_hash: 'h'.repeat(128), salt: 's'.repeat(32) }, db)
    token[t] = await createSession(t, db)
    setSellerProfile(raw, t, `sells ${t}`, `https://${t}.example`)
    job[t] = createJob(raw, t, { business_name: `Biz ${t}`, industry: 'software', location: 'Toronto' })
    raw.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job[t])
    raw.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score) VALUES (?, ?, '', ?, 'hiring', 'https://e.x/j', 80)").run(`lead-${t}`, job[t], `Co ${t}`)
    raw.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job[t])
  }
  // statements prepared up front, as long-lived unported code does
  const profileStmt = raw.prepare('SELECT sells, website FROM users WHERE id = ?')
  const insertJob = raw.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES (?, ?, 'Biz', 'software', 'Toronto')")

  // a protected request: session lookup on Db, then unported raw reads for the signed-in tenant
  const request = async (t: 'A' | 'B') => {
    const u = await getSessionUser(token[t], db)
    if (!u) throw new Error('not signed in')
    return {
      id: u.tenantId,
      profile: sellerProfile(raw, u.tenantId),
      prepared: profileStmt.get(u.tenantId) as { sells: string },
      plan: getPlan(raw, u.tenantId),
      quota: scanQuota(raw, u.tenantId),
      leads: listLeads(raw, u.tenantId, job[t]).map(l => (l as { id: string }).id),
      other: listLeads(raw, u.tenantId, job[t === 'A' ? 'B' : 'A']).length,
    }
  }
  const checkout = (id: string) => applyStripeEvent(db, { id, type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: 'A', customer: 'cus_A', subscription: 'sub_A' } } })
  // rollback control: a transaction that writes, then fails
  const doomed = (i: number) => db.tx(function* (t) {
    yield* t.run('INSERT INTO stripe_events (id, type) VALUES (?, ?)', [`evt_doomed_${i}`, 'x'])
    yield* t.run("UPDATE tenant_plans SET plan = 'pro' WHERE tenant_id = 'B'")
    throw new Error('rollback control')
  })

  for (let round = 0; round < 20; round++) {
    const ops: (() => Promise<unknown>)[] = [
      () => request('A'), () => request('B'), () => request('A'), () => request('B'),
      () => checkout(`evt_${round}`),
      () => doomed(round),
      () => resolveUser(db, { sub: `g${round}`, email: `g${round}@x.com`, name: 'G' }),
      () => resolveUser(db, { sub: `h${round}`, email: 'A@x.com', name: 'H' }),
      async () => { await null; insertJob.run(`raw-${round}`, 'B') }, // an unported write during it all
      () => request('A'), () => request('B'),
    ]
    for (let i = ops.length - 1; i > 0; i--) { const j = (i * 7 + round * 3) % (i + 1); [ops[i], ops[j]] = [ops[j], ops[i]] }
    const res = await Promise.allSettled(ops.map(f => f()))
    for (const r of res) {
      if (r.status === 'rejected') assert.match(String(r.reason), /rollback control/, `an unrelated operation failed: ${r.reason}`)
    }
    assert.equal(res.filter(r => r.status === 'rejected').length, 1)
    for (const r of res) {
      const v = r.status === 'fulfilled' ? r.value as { id?: string; profile?: string; prepared?: { sells: string }; plan?: string; leads?: string[]; other?: number } : null
      if (!v?.profile) continue
      // each request sees exactly its own tenant
      assert.equal(v.profile, `sells ${v.id} - https://${v.id}.example`)
      assert.equal(v.prepared!.sells, `sells ${v.id}`)
      assert.deepEqual(v.leads, [`lead-${v.id}`])
      assert.equal(v.other, 0)
      if (v.id === 'B') assert.equal(v.plan, 'free') // the rolled-back upgrade of B is never visible
    }
  }

  assert.equal(getPlan(raw, 'A'), 'pro')
  assert.equal(getPlan(raw, 'B'), 'free')
  assert.equal((raw.prepare("SELECT count(*) AS n FROM stripe_events WHERE id LIKE 'evt_doomed_%'").get() as { n: number }).n, 0)
  assert.equal((raw.prepare("SELECT count(*) AS n FROM stripe_events WHERE id LIKE 'evt_%'").get() as { n: number }).n, 20)
  assert.equal((raw.prepare("SELECT count(*) AS n FROM scan_jobs WHERE id LIKE 'raw-%' AND user_id = 'B'").get() as { n: number }).n, 20)
  assert.equal((raw.prepare("SELECT count(*) AS n FROM oauth_identities").get() as { n: number }).n, 20)
  assert.equal((raw.prepare("SELECT count(*) AS n FROM users WHERE email LIKE 'g%@x.com'").get() as { n: number }).n, 20)
  await db.close()
})
