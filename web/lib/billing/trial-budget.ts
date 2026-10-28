// What dazl spends on free trial scans (owner decision 2026-10-28: new users get real results with no API key, on
// dazl's own keys), held by hard caps and abuse limits. lib/scan/trial.ts keeps the per-account scan count and the
// per-IP throttle; this module decides whether dazl can afford one more trial scan right now, and for whom.
//
// Admission (admitTrialScan), in one transaction that every admission takes in turn (the trial_budget_lock row):
//   1. caps configured: DAZL_TRIAL_SCAN_RESERVE_USD, DAZL_TRIAL_USER_DAILY_USD and DAZL_TRIAL_GLOBAL_DAILY_USD must all
//      be set to positive numbers, or no trial scan runs (fails closed; Instinct sets the numbers with the owner);
//   2. a verified Google account: the user signed in with Google (oauth_identities), whose email Google verified;
//   3. one trial per company: an email domain that is not a consumer mailbox (gmail.com, outlook.com, ...) gets one
//      trial account; a second account on the same domain is refused;
//   4. money: today's trial spend (UTC day) plus this scan's reserve must stay within the user's and the global cap.
//      A scan counts as its reserve until it ends, then as what it recorded as spent. So caps are checked against a
//      worst case for scans still running, and against recorded spend for finished ones.
// Inside the scan (lib/scan/runner.ts), every paid step on dazl's keys is counted against the scan's reserve before it
// is made: model calls, research (worst case, then settled to its reported usage), TinyFish searches and fetches,
// retries and failed calls. A step that does not fit stops the scan with what it has (trial_budget_reached), and web
// research stays on until then. A scan therefore never spends more than its reserve, except by what one research call
// reports above its own reserve, which is recorded and stops the scan. Search-profile previews are not counted.
import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import type { Db, Tx, TxBody } from '../db/client.ts'

export function migrateTrialBudget(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trial_reservations (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      job_id      TEXT,
      reserve_usd REAL NOT NULL CHECK (reserve_usd > 0),
      day         INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trial_reservations_day ON trial_reservations (day, tenant_id);
    CREATE TABLE IF NOT EXISTS trial_budget_lock (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO trial_budget_lock (id, n) VALUES (1, 0);
  `)
}

export interface TrialCaps {
  reserveUsd: number; userDailyUsd: number; globalDailyUsd: number
  // Prices of the paid steps a trial scan's own budget counts in the runner (lib/scan/runner.ts): a research call's worst
  // case (settled to the usage it reports), and each TinyFish search and fetched URL on dazl's key. Model calls are
  // priced from their tokens (lib/llm/spend-guard.ts PRICES_USD_PER_M). 0 is allowed for a free tier, but must be set.
  researchReserveUsd: number; tinyfishSearchUsd: number; tinyfishFetchUsd: number
}
const positive = (v: string | undefined) => { const n = Number(v); return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null }
const nonNegative = (v: string | undefined) => { const n = Number(v); return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null }
// null unless every number is set: no cap or no price, no trial. TinyFish prices are needed only while TinyFish is on.
export function trialCaps(env: Record<string, string | undefined> = process.env): TrialCaps | null {
  const reserveUsd = positive(env.DAZL_TRIAL_SCAN_RESERVE_USD), userDailyUsd = positive(env.DAZL_TRIAL_USER_DAILY_USD), globalDailyUsd = positive(env.DAZL_TRIAL_GLOBAL_DAILY_USD)
  const researchReserveUsd = positive(env.DAZL_TRIAL_RESEARCH_RESERVE_USD)
  const tfOn = !!env.TINYFISH_API_KEY && env.TINYFISH_ENABLED !== '0'
  const tinyfishSearchUsd = tfOn ? nonNegative(env.DAZL_TRIAL_TINYFISH_SEARCH_USD) : 0, tinyfishFetchUsd = tfOn ? nonNegative(env.DAZL_TRIAL_TINYFISH_FETCH_USD) : 0
  if (!reserveUsd || !userDailyUsd || !globalDailyUsd || !researchReserveUsd || tinyfishSearchUsd === null || tinyfishFetchUsd === null) return null
  return { reserveUsd, userDailyUsd, globalDailyUsd, researchReserveUsd, tinyfishSearchUsd, tinyfishFetchUsd }
}

// Mailbox providers anyone can sign up to: the one-trial-per-domain rule would lock out everyone else on them, so these
// count per account only (a verified Google account each).
export const CONSUMER_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'web.de', 'mail.com', 'zoho.com', 'yandex.com',
  'yandex.ru', 'mail.ru', 'qq.com', '163.com', '126.com', 'naver.com', 'rediffmail.com', 'hotmail.co.uk', 'yahoo.co.uk', 'yahoo.co.in', 'outlook.in'])
export const emailDomain = (email: string) => email.trim().toLowerCase().split('@')[1] ?? ''

export const utcDay = (nowS: number) => Math.floor(nowS / 86400)

// The reason a free-trial scan stopped at its budget (scan_jobs.error) and why its leads are in review (leads.review_reason).
export const TRIAL_BUDGET_REASON = 'trial_budget_reached'

export type TrialRefusal = 'not_configured' | 'google_required' | 'domain_used' | 'user_daily_cap' | 'global_daily_cap'
export type Admission = { ok: true; reservation: string } | { ok: false; reason: TrialRefusal }

// A reservation's cost for the day: its reserve while the scan runs (or before it exists), then what the scan recorded
// as spent once it ended: scan_jobs.spend_reserved_usd, every paid step the runner counted against the trial budget
// (model calls, research settled to its reported usage, TinyFish searches and fetched URLs, retries and failed calls).
const SPENT_SQL = `SELECT r.tenant_id, r.reserve_usd, j.status, j.spend_reserved_usd
  FROM trial_reservations r LEFT JOIN scan_jobs j ON j.id = r.job_id AND j.user_id = r.tenant_id
  WHERE r.day = ?`
type SpentRow = { tenant_id: string; reserve_usd: number; status: string | null; spend_reserved_usd: number | null }
export function spendByTenant(rows: SpentRow[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) {
    const ended = r.status === 'done' || r.status === 'failed'
    const cost = ended ? Math.max(0, Number(r.spend_reserved_usd ?? 0)) : Number(r.reserve_usd)
    out.set(r.tenant_id, (out.get(r.tenant_id) ?? 0) + cost)
  }
  return out
}

// The checks, as a transaction step: the reason a trial scan would be refused for this user now, or null.
function* refusal(t: Tx, user: { id: string; email: string }, caps: TrialCaps, day: number): TxBody<TrialRefusal | null> {
  const google = yield* t.get("SELECT 1 AS x FROM oauth_identities WHERE provider = 'google' AND user_id = ?", [user.id])
  if (!google) return 'google_required'
  const domain = emailDomain(user.email)
  if (domain && !CONSUMER_DOMAINS.has(domain)) {
    // another account on this company domain already had a trial scan
    const other = yield* t.get(`SELECT 1 AS x FROM trial_reservations r JOIN users u ON u.id = r.tenant_id
      WHERE u.id <> ? AND lower(u.email) LIKE ? LIMIT 1`, [user.id, `%@${domain}`])
    if (other) return 'domain_used'
  }
  const spent = spendByTenant(yield* t.all<SpentRow>(SPENT_SQL, [day]))
  const total = [...spent.values()].reduce((a, b) => a + b, 0)
  if ((spent.get(user.id) ?? 0) + caps.reserveUsd > caps.userDailyUsd) return 'user_daily_cap'
  if (total + caps.reserveUsd > caps.globalDailyUsd) return 'global_daily_cap'
  return null
}

export async function admitTrialScan(db: Db, user: { id: string; email: string }, o: { now?: number; env?: Record<string, string | undefined> } = {}): Promise<Admission> {
  const caps = trialCaps(o.env)
  if (!caps) return { ok: false, reason: 'not_configured' }
  const now = o.now ?? Math.floor(Date.now() / 1000), day = utcDay(now)
  return db.tx(function* (t: Tx): TxBody<Admission> {
    // every admission takes this row first, so two instances cannot both admit against the same remaining budget
    yield* t.run('UPDATE trial_budget_lock SET n = n + 1 WHERE id = 1')
    const why = yield* refusal(t, user, caps, day)
    if (why) return { ok: false, reason: why }
    const id = randomBytes(12).toString('hex')
    yield* t.run('INSERT INTO trial_reservations (id, tenant_id, job_id, reserve_usd, day, created_at) VALUES (?, ?, NULL, ?, ?, ?)', [id, user.id, caps.reserveUsd, day, now])
    return { ok: true, reservation: id }
  })
}

// For the free-scans counter: why a trial scan would be refused right now (null = it would run), without reserving.
export async function trialRefusal(db: Db, user: { id: string; email: string }, o: { now?: number; env?: Record<string, string | undefined> } = {}): Promise<TrialRefusal | null> {
  const caps = trialCaps(o.env)
  if (!caps) return 'not_configured'
  const day = utcDay(o.now ?? Math.floor(Date.now() / 1000))
  return db.tx(t => refusal(t, user, caps, day))
}

// The scan the reservation paid for, once it exists. Until then (or if creating it failed) the reservation counts as
// its full reserve for the day.
export async function linkTrialReservation(db: Db, tenantId: string, reservation: string, jobId: string): Promise<void> {
  await db.run('UPDATE trial_reservations SET job_id = ? WHERE id = ? AND tenant_id = ? AND job_id IS NULL', [jobId, reservation, tenantId])
}
