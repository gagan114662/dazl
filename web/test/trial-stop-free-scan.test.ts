// Two trial bugs from Hermes-PC's cap test (job 275b3dca), both on a free scan that stopped at its spending limit (done / trial_budget_reached):
// (a) the Leads page said nothing about the stop; it now shows the same words as Campaigns and the past-scans list, plus "Nothing was charged." when no spend was recorded.
// (c) a stop that found no company gave the person nothing but still used one of the three free scans; it now gives the place back. Only the attempt
//     count is released: the recorded spend still counts against the $1 account total and the day, so the dollar caps bind exactly as before.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Db } from '../lib/db/client.ts'
import { admitTrialScan, ledger, linkTrialReservation, settleTrialReservation, utcDay, type LedgerRow } from '../lib/billing/trial-budget.ts'
import { scanOutcome } from '../lib/scan/scan-outcome.ts'
import { readTrialStatus } from '../lib/scan/trial.ts'
import { bothEngines } from './helpers/engines.ts'

const NOW = 1_800_000_000, DAY = utcDay(NOW)
const caps = { DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1', DAZL_TRIAL_GLOBAL_DAILY_USD: '10', TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0', DAZL_TRIAL_TINYFISH_FETCH_USD: '0', DAZL_TRIAL_ANTHROPIC_KEY: 'sk-fixture' }
const mkUser = async (db: Db, id: string, email: string) => {
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
  await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
  return { id, email }
}
let n = 0
const ended = async (db: Db, u: { id: string; email: string }, o: { status: string; error: string | null; spent: number | null; candidates: number | null; settle?: boolean }) => {
  const a = await admitTrialScan(db, u, { env: caps, now: NOW }); assert.ok(a.ok, JSON.stringify(a))
  const id = `stop${String(++n).padStart(20, '0')}`
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, error, created_at, spend_reserved_usd, candidates, finished_at) VALUES (?, ?, 'b', 'i', 'l', ?, ?, ?, ?, ?, ?)", [id, u.id, o.status, o.error, NOW, o.spent, o.candidates, NOW])
  await linkTrialReservation(db, u.id, a.reservation, id)
  await db.run("INSERT INTO trial_scans (tenant_id, job_id, ip_hash) VALUES (?, ?, 'h')", [u.id, id])
  if (o.settle !== false) await settleTrialReservation(db, id, Number((await db.get<{ a: number }>('SELECT attempts AS a FROM scan_jobs WHERE id = ?', [id]))!.a), NOW)
}
const row = (o: Partial<LedgerRow>): LedgerRow => ({ tenant_id: 'T', kind: 'scan', reserve_usd: 0.3, spent_usd: null, day: DAY, created_at: NOW, settled_at: NOW, settled_attempt: 1, status: 'done', error: 'trial_budget_reached', candidates: 0, attempts: 1, spend_reserved_usd: 0.12, ...o })
const stop = { status: 'done', error: 'trial_budget_reached' }

// ---- (c)
test('(c) ledger: a settled trial stop with 0 candidates is not a used free scan, but its recorded spend still counts as money', () => {
  const l = ledger([row({}), row({}), row({})], 'T', DAY)
  assert.equal(l.attempts, 0)
  assert.ok(Math.abs(l.account - 0.36) < 1e-9, 'spend still counts against the account total')
  assert.ok(Math.abs(l.today - 0.36) < 1e-9, 'and the day')
})
test('(c) ledger: every other ending keeps its place (controls)', () => {
  const one = (o: Partial<LedgerRow>) => ledger([row(o)], 'T', DAY).attempts
  assert.equal(one({ candidates: 2 }), 1, 'a stop that kept candidates is a used scan')
  assert.equal(one({ candidates: null }), 1, 'a stop whose candidate count was never recorded keeps it')
  assert.equal(one({ settled_at: null, settled_attempt: null }), 1, 'a stop whose run has not settled holds it')
  assert.equal(one({ settled_attempt: 0 }), 1, "an earlier attempt's settle does not release it")
  assert.equal(one({ status: 'running', settled_at: null, settled_attempt: null }), 1, 'running holds it')
  assert.equal(one({ status: 'failed', error: 'budget_stopped', spend_reserved_usd: 0.12 }), 1, 'a paid failure still holds it (unchanged)')
  assert.equal(one({ status: 'done', error: null }), 1, 'a finished scan holds it')
})
bothEngines('(c) admission: three empty trial stops leave all three free scans, the first check and the counter agree, and the $1 total still binds', async ({ db }) => {
  const u = await mkUser(db, 'a'.repeat(32), 'a@gmail.com')
  for (let i = 0; i < 3; i++) await ended(db, u, { ...stop, spent: 0.1, candidates: 0 })
  assert.equal((await admitTrialScan(db, u, { env: caps, now: NOW })).ok, true, 'a fourth attempt is admitted')
  const t = await readTrialStatus(db, u.id, '1.2.3.4', new Date(NOW * 1000), caps as unknown as NodeJS.ProcessEnv)
  assert.equal(t.used, 0, 'the free-scans counter (and the first check) count none of them')
  // control: the same three stops with candidates kept use the places up
  const v = await mkUser(db, 'b'.repeat(32), 'b@gmail.com')
  for (let i = 0; i < 3; i++) await ended(db, v, { ...stop, spent: 0.1, candidates: 4 })
  assert.deepEqual(await admitTrialScan(db, v, { env: caps, now: NOW }), { ok: false, reason: 'attempts_cap' })
  assert.equal((await readTrialStatus(db, v.id, '1.2.3.4', new Date(NOW * 1000), caps as unknown as NodeJS.ProcessEnv)).used, 3)
  // the dollar total still binds: two empty stops that recorded $0.45 each leave no room for a third $0.30 reserve
  const w = await mkUser(db, 'c'.repeat(32), 'c@gmail.com')
  await ended(db, w, { ...stop, spent: 0.45, candidates: 0 })
  await ended(db, w, { ...stop, spent: 0.45, candidates: 0 })
  assert.deepEqual(await admitTrialScan(db, w, { env: caps, now: NOW }), { ok: false, reason: 'account_total_cap' })
})

// ---- (a)
const rec = { id: 'j', status: 'done', error: 'trial_budget_reached', funded_by: 'trial', needs_review: 0, candidates: 0 } as const
test('(a) outcome: a trial stop with no recorded spend says nothing was charged; one with spend, or an unknown spend, does not', () => {
  assert.match(scanOutcome({ ...rec, spend_usd: 0 }).label, /before it found any companies\. Nothing was charged\.$/)
  assert.match(scanOutcome({ ...rec, spend_usd: null }).label, /Nothing was charged\.$/, 'no paid step recorded')
  assert.match(scanOutcome({ ...rec, spend_usd: '0' }).label, /Nothing was charged\.$/, 'Postgres returns numerics as strings')
  assert.match(scanOutcome({ ...rec, spend_usd: 0, needs_review: 2 }).label, /kept 2 results found before it stopped\. Nothing was charged\.$/)
  assert.doesNotMatch(scanOutcome({ ...rec, spend_usd: 0.12 }).label, /charged/, 'spend recorded: no claim')
  assert.doesNotMatch(scanOutcome({ ...rec, spend_usd: 'abc' }).label, /charged/, 'garbage: no claim')
  assert.doesNotMatch(scanOutcome({ ...rec }).label, /charged/, 'a reader that did not load the spend makes no claim')
  assert.equal(scanOutcome({ ...rec, spend_usd: 0.12 }).label, 'Stopped early: this free scan reached its spending limit before it found any companies.', 'wording unchanged otherwise')
})

// The first check / usage counter (lib/scan/trial.ts) and admission (the ledger) must count the same used scans for every ending.
bothEngines('(c) the first check and admission agree on every trial-stop ending', async ({ db }) => {
  const endings: [string, { status: string; error: string | null; spent: number | null; candidates: number | null; settle?: boolean }][] = [
    ['empty stop, settled', { ...stop, spent: 0.1, candidates: 0 }],
    ['empty stop, no spend recorded', { ...stop, spent: null, candidates: 0 }],
    ['empty stop, not settled', { ...stop, spent: 0.1, candidates: 0, settle: false }],
    ['stop with candidates', { ...stop, spent: 0.1, candidates: 3 }],
    ['stop, candidates not recorded', { ...stop, spent: 0.1, candidates: null }],
    ['done, no error', { status: 'done', error: null, spent: 0.05, candidates: 0 }],
    ['paid failure', { status: 'failed', error: 'budget_stopped', spent: 0.1, candidates: 0 }],
  ]
  let i = 0
  for (const [name, e] of endings) {
    const u = await mkUser(db, String(++i).repeat(32), `e${i}@gmail.com`)
    await ended(db, u, e)
    const first = (await readTrialStatus(db, u.id, '1.2.3.4', new Date(NOW * 1000), caps as unknown as NodeJS.ProcessEnv)).used
    const rows = await db.all<LedgerRow>('SELECT r.tenant_id, r.kind, r.reserve_usd, r.spent_usd, r.day, r.created_at, r.settled_at, r.settled_attempt, j.status, j.error, j.candidates, j.attempts, j.spend_reserved_usd FROM trial_reservations r LEFT JOIN scan_jobs j ON j.id = r.job_id WHERE r.tenant_id = ?', [u.id])
    assert.equal(first, ledger(rows, u.id, DAY).attempts, `${name}: first check ${first} vs admission`)
  }
})
