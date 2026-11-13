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
test('(a) outcome: a trial stop with a recorded spend of 0 says nothing was charged; one with spend, or an unknown spend, does not', () => {
  assert.match(scanOutcome({ ...rec, spend_usd: 0 }).label, /before it found any companies\. Nothing was charged\.$/)
  assert.doesNotMatch(scanOutcome({ ...rec, spend_usd: null }).label, /charged/, 'null is not a claim here: the readers decide an empty column on a read row is 0')
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

// ---- Hermes-PC review of #1057: "Nothing was charged." must never rest on a spend that could not be read.
const claims = (spend: unknown, extra: Record<string, unknown> = {}) => /Nothing was charged\./.test(scanOutcome({ ...rec, ...extra, ...(spend === undefined ? {} : { spend_usd: spend }) } as never).label)
test('(a) strict: only a numeric zero claims "nothing was charged"; every other value says nothing, one case each', () => {
  assert.equal(claims(0), true, 'number 0')
  assert.equal(claims('0'), true, 'Postgres numeric string 0')
  assert.equal(claims('0.00'), true, 'string 0.00')
  assert.equal(claims(undefined), false, 'undefined: a reader that could not read it')
  assert.equal(claims(null), false, 'null: not a claim')
  assert.equal(claims(''), false, "'' (Number('') is 0)")
  assert.equal(claims('  '), false, 'blank string')
  assert.equal(claims(false), false, 'false (Number(false) is 0)')
  assert.equal(claims(true), false, 'true')
  assert.equal(claims(Number.NaN), false, 'NaN')
  assert.equal(claims('abc'), false, 'text')
  assert.equal(claims(-0.5), false, 'negative')
  assert.equal(claims(0.01), false, 'any spend')
  assert.equal(claims('0.01'), false, 'any spend as text')
})

import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { readScanStatus } from '../lib/scan/status-read-service.ts'
import { historyJobs } from '../lib/scan/history-jobs.ts'
import { campaignDetail } from '../lib/outreach/campaign-detail.ts'
const stopJob = (raw: Database.Database, id: string, spend: number | null) => {
  raw.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES ('U', 'u@x.com', 'n', 'b', 'x', 'y')").run()
  raw.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, error, created_at, finished_at, candidates, verified, needs_review, spend_reserved_usd, funded_by) VALUES (?, 'U', 'b', 'i', 'l', 'done', 'trial_budget_reached', 1800000000, 1800000000, 0, 0, 0, ?, 'trial')").run(id, spend)
}
const ID = 'a'.repeat(24)
const failing = (real: ReturnType<typeof sqliteDb>, match: RegExp): ReturnType<typeof sqliteDb> => ({ ...real, get: (async (sql: string, p?: unknown[]) => { if (match.test(sql)) throw new Error('db down'); return real.get(sql, p as never) }) as never, all: (async (sql: string, p?: unknown[]) => { if (match.test(sql)) throw new Error('db down'); return real.all(sql, p as never) }) as never }) as never
const setup = (spend: number | null, cap: number | null = null) => { const raw = new Database(':memory:'); migrateAllSqlite(raw); stopJob(raw, ID, spend); if (cap !== null) raw.prepare('UPDATE scan_jobs SET spend_cap_reserved_usd = ? WHERE id = ?').run(cap, ID); return sqliteDb(raw) }

test('(a) status read: a successful read of an empty or zero column claims it; a recorded spend or a failed read does not', async () => {
  const label = async (db: ReturnType<typeof sqliteDb>) => ((await readScanStatus(db, 'U', ID)) as { outcome: { label: string } }).outcome.label
  assert.match(await label(setup(null)), /Nothing was charged\./, 'column empty, read ok')
  assert.match(await label(setup(0)), /Nothing was charged\./, 'zero, read ok')
  assert.doesNotMatch(await label(setup(0.12)), /charged/, 'spend recorded')
  assert.doesNotMatch(await label(setup(0, 0.05)), /charged/, 'only the cap ledger recorded a paid call: no claim')
  assert.doesNotMatch(await label(setup(null, 0.05)), /charged/, 'cap ledger only, reservation column empty: no claim')
  assert.match(await label(setup(0, 0)), /Nothing was charged\./, 'both ledgers zero')
  assert.doesNotMatch(await label(failing(setup(null), /spend_reserved_usd, spend_cap_reserved_usd/)), /charged/, 'the spend read FAILED: no claim')
})
test('(a) history list: an empty or zero column claims it; a recorded spend or a failed read does not (and the list still loads)', async () => {
  const label = async (db: ReturnType<typeof sqliteDb>) => { const j = (await historyJobs(db, 'U')).find(x => x.id === ID)!; return scanOutcome(j as never).label }
  assert.match(await label(setup(null)), /Nothing was charged\./)
  assert.match(await label(setup(0)), /Nothing was charged\./)
  assert.doesNotMatch(await label(setup(0.12)), /charged/)
  assert.doesNotMatch(await label(setup(0, 0.05)), /charged/, 'cap ledger positive: no claim')
  assert.doesNotMatch(await label(failing(setup(null), /spend_cap_reserved_usd, 0\) AS s FROM scan_jobs WHERE user_id/)), /charged/, 'the spend read FAILED: no claim, list intact')
})
test('(a) campaign page job: an empty or zero column reads as 0; a recorded spend stays', async () => {
  assert.equal((await campaignDetail(setup(null), 'U', ID))!.job.spend_usd, 0)
  assert.equal((await campaignDetail(setup(0.12), 'U', ID))!.job.spend_usd, 0.12)
  assert.equal((await campaignDetail(setup(0, 0.05), 'U', ID))!.job.spend_usd, 0.05, 'a spend recorded only in the cap ledger is not shown as 0')
})
