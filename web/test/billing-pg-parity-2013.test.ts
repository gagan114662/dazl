// #2013 MONEY ON POSTGRES, PR 1: the billing money paths already run on the Db layer (lib/billing/trial-budget.ts,
// lib/billing/stripe.ts); this file pins that they behave IDENTICALLY on SQLite and Postgres - same admissions, same
// refusals, same ledger after reserve / link / settle / release, same Stripe dedup, same table columns - and that one
// tenant's trial money is invisible and untouchable to another. Every body runs under bothEngines, so the [pg] twin
// is the parity proof (CI runs it with DAZL_REQUIRE_PG=1). Amounts use the trial's real shapes (a $0.75 scan reserve,
// a $0.30 recorded scan cost); the assertions pin the general invariants - counts, statuses and amounts - not any
// fixture's data. Synthetic accounts only; no provider call, no fetch, no spend.
import assert from 'node:assert/strict'
import type { Db } from '../lib/db/client.ts'
import {
  admitTrialScan, linkTrialReservation, releaseTrialReservation, settlePinnedTrialReservation,
  settleTrialReservation, trialAllowanceLeft,
} from '../lib/billing/trial-budget.ts'
import { applyStripeEvent, type StripeEvent } from '../lib/billing/stripe.ts'
import { readPlan } from '../lib/plans.ts'
import { ipHash, readTrialStatus } from '../lib/scan/trial.ts'
import { bothEngines } from './helpers/engines.ts'

const NOW = 1_800_000_000
const OP = 'sk-ant-api03-PARITYPARITYPARITYPARITYPARITY'
// The trial wallet for these tests: a $0.75 reserve per scan and a $1.50 account total, so exactly two scans fit.
const caps: Record<string, string | undefined> = {
  DAZL_TRIAL_SCAN_RESERVE_USD: '0.75', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1.50', DAZL_TRIAL_GLOBAL_DAILY_USD: '10',
  TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0', DAZL_TRIAL_TINYFISH_FETCH_USD: '0',
}
// readTrialStatus decides from the operator key in the env it is handed.
const statusEnv: NodeJS.ProcessEnv = { ...process.env, DAZL_TRIAL_ANTHROPIC_KEY: OP }
const IP = '203.0.113.7'

const uid = (n: number) => n.toString(16).padStart(32, '0')
const mkUser = async (db: Db, id: string, email: string) => {
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
  await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
  return { id, email }
}
const jobId = (n: number) => `pgp${String(n).padStart(21, '0')}`
// A finished scan with a recorded cost, in the shape the scan store writes (mirrors trial-allowance-left.test.ts).
const doneJob = async (db: Db, userId: string, id: string, spent: number) => {
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, error, created_at, spend_reserved_usd, finished_at) VALUES (?, ?, 'b', 'i', 'l', 'done', NULL, ?, ?, ?)", [id, userId, NOW, spent, NOW])
  return Number((await db.get<{ a: number }>('SELECT attempts AS a FROM scan_jobs WHERE id = ?', [id]))!.a)
}
const left = async (db: Db, tenantId: string) => (await trialAllowanceLeft(db, tenantId, { env: caps, now: NOW }))!
const eqUsd = (actual: number, expected: number, what: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} != ${expected}`)

bothEngines('#2013 parity: trial lifecycle - admit within budget, refuse past it, link and settle; the allowance and the free-scan counter agree at every step', async ({ db }) => {
  const u = await mkUser(db, uid(0x2013a), 'parity-a@gmail.com')
  const status = () => readTrialStatus(db, u.id, IP, new Date(NOW * 1000), statusEnv)
  assert.deepEqual(await left(db, u.id), { left_usd: 1.5, total_usd: 1.5 })
  assert.deepEqual(await status(), { funded: true, used: 0, remaining: 3 })

  const a1 = await admitTrialScan(db, u, { env: caps, now: NOW }); assert.ok(a1.ok, JSON.stringify(a1))
  eqUsd((await left(db, u.id)).left_usd, 0.75, 'an unsettled reservation holds its full reserve')
  const a2 = await admitTrialScan(db, u, { env: caps, now: NOW }); assert.ok(a2.ok, JSON.stringify(a2))
  eqUsd((await left(db, u.id)).left_usd, 0, 'two reserves fill the account total')
  assert.deepEqual(await admitTrialScan(db, u, { env: caps, now: NOW }), { ok: false, reason: 'account_total_cap' }, 'past the budget the admission refuses')

  // The first scan finishes at a recorded cost below its reserve: link, settle, and record the scan.
  const id = jobId(1)
  const attempt = await doneJob(db, u.id, id, 0.30)
  await linkTrialReservation(db, u.id, a1.reservation, id)
  await settleTrialReservation(db, id, attempt, NOW)
  await db.run('INSERT INTO trial_scans (tenant_id, job_id, ip_hash, created_at) VALUES (?, ?, ?, ?)', [u.id, id, ipHash(IP), NOW])
  eqUsd((await left(db, u.id)).left_usd, 0.45, 'settled scan counts its recorded cost; the running one still holds its reserve')
  assert.deepEqual(await status(), { funded: true, used: 1, remaining: 2 })
})

bothEngines('#2013 parity: release frees the budget - a released reservation costs nothing and admits again; a settled one is never released', async ({ db }) => {
  const u = await mkUser(db, uid(0x2013b), 'parity-b@gmail.com')
  const a1 = await admitTrialScan(db, u, { env: caps, now: NOW }); assert.ok(a1.ok, JSON.stringify(a1))
  assert.equal(await releaseTrialReservation(db, u.id, a1.reservation), true)
  assert.deepEqual(await left(db, u.id), { left_usd: 1.5, total_usd: 1.5 }, 'the release gives the whole budget back')
  assert.equal(await releaseTrialReservation(db, u.id, a1.reservation), false, 'a second release finds nothing')
  const a2 = await admitTrialScan(db, u, { env: caps, now: NOW }); assert.ok(a2.ok, 'the freed budget admits a second scan')
  const id = jobId(2)
  const attempt = await doneJob(db, u.id, id, 0.30)
  await linkTrialReservation(db, u.id, a2.reservation, id)
  await settleTrialReservation(db, id, attempt, NOW)
  assert.equal(await releaseTrialReservation(db, u.id, a2.reservation), false, 'a settled reservation keeps its cost')
  eqUsd((await left(db, u.id)).left_usd, 1.2, 'the recorded cost still counts after the refused release')
})

bothEngines('#2013 parity: a Stripe event applies once - a replayed event id is a duplicate and changes nothing', async ({ db }) => {
  const ev: StripeEvent = {
    id: 'evt_parity_2013', type: 'checkout.session.completed', created: 1793000000,
    data: { object: { mode: 'subscription', client_reference_id: 'tenant-parity', customer: 'cus_parity', subscription: 'sub_parity' } },
  }
  assert.equal(await readPlan(db, 'tenant-parity'), 'free')
  assert.equal(await applyStripeEvent(db, ev), 'applied')
  assert.equal(await readPlan(db, 'tenant-parity'), 'pro')
  assert.equal(await applyStripeEvent(db, ev), 'duplicate', 'the same event id never applies twice')
  assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM stripe_events'))!.n), 1)
  assert.equal(await readPlan(db, 'tenant-parity'), 'pro')
})

bothEngines("#2013 parity: tenant isolation - one tenant's trial money is invisible and untouchable to another; a control tenant admits independently", async ({ db }) => {
  const A = await mkUser(db, uid(0x2013c), 'parity-c@gmail.com')
  const B = await mkUser(db, uid(0x2013d), 'parity-d@gmail.com')
  const C = await mkUser(db, uid(0x2013e), 'parity-e@gmail.com')
  const a = await admitTrialScan(db, A, { env: caps, now: NOW }); assert.ok(a.ok, JSON.stringify(a))

  // B's views show none of A's reservation.
  assert.deepEqual(await left(db, B.id), { left_usd: 1.5, total_usd: 1.5 })
  assert.deepEqual(await readTrialStatus(db, B.id, IP, new Date(NOW * 1000), statusEnv), { funded: true, used: 0, remaining: 3 })
  // B cannot release A's reservation.
  assert.equal(await releaseTrialReservation(db, B.id, a.reservation), false)
  eqUsd((await left(db, A.id)).left_usd, 0.75, "B's release attempt changed nothing for A")

  // A's scan completes; B cannot settle it under B's tenant pin either.
  const id = jobId(3)
  const attempt = await doneJob(db, A.id, id, 0.30)
  await linkTrialReservation(db, A.id, a.reservation, id)
  await settlePinnedTrialReservation(db, B.id, id, attempt, NOW)
  eqUsd((await left(db, A.id)).left_usd, 0.75, "B's settle attempt changed nothing: A still holds the full reserve")
  await settleTrialReservation(db, id, attempt, NOW)
  eqUsd((await left(db, A.id)).left_usd, 1.2, 'A settles at its recorded cost through the normal path')

  // Control: C admits on its own budget while A's money is spent, and A's view does not move.
  const c = await admitTrialScan(db, C, { env: caps, now: NOW }); assert.ok(c.ok, JSON.stringify(c))
  eqUsd((await left(db, C.id)).left_usd, 0.75, "C's own reservation counts against C only")
  eqUsd((await left(db, A.id)).left_usd, 1.2, "C's admission changed nothing for A")
})

bothEngines('#2013 parity: the trial and Stripe tables expose the same columns on both engines', async ({ db, kind, raw, schema }) => {
  const cols = async (table: string): Promise<string[]> => {
    if (kind === 'sqlite') return (raw!.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name).sort()
    const rows = await db.all<{ name: string }>('SELECT column_name AS name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?', [schema!, table])
    return rows.map(r => r.name).sort()
  }
  // SQLite: migrateTrialBudget's DDL + its kind/spent_usd ALTERs. Postgres: 0012_trial_budget + 0037_trial_site_reads.
  assert.deepEqual(await cols('trial_reservations'), ['created_at', 'day', 'id', 'job_id', 'kind', 'reserve_usd', 'settled_at', 'settled_attempt', 'spent_usd', 'tenant_id'])
  // SQLite: migrateBilling's DDL. Postgres: 0001_baseline.
  assert.deepEqual(await cols('stripe_events'), ['id', 'processed_at', 'type'])
})
