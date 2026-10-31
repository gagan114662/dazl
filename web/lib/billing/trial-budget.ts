// What dazl spends on free trial scans (owner decision 2026-10-28: new users get real results with no API key, on
// dazl's own keys), held by hard ceilings and abuse limits. lib/scan/trial.ts keeps the per-account scan count and the
// per-IP throttle; this module decides whether dazl can afford one more trial scan right now, and for whom.
//
// Funded trials stay OFF until Gagan approves the spend directly: with any number below unset, no trial scan runs. The
// numbers Instinct proposed (not approved spend) are $0.30 a scan, $1 per trial account in total, $10 a day globally.
//
// Three ceilings, each a hard bound on money spent, not an estimate:
//   - per scan (DAZL_TRIAL_SCAN_RESERVE_USD): the runner's guard reserves every paid step's MAXIMUM cost before the step
//     is sent and refuses a step that does not fit (lib/scan/runner.ts). A step whose cost cannot be bounded is never
//     made on a trial: the model's own web search (its search results are billed input with no limit dazl can set) is
//     refused, so a trial's web research is TinyFish, at a fixed price per search and per fetched URL. Model calls are
//     bounded by their prompt's UTF-8 bytes plus a margin, and their max_tokens. Failed calls and retries keep their
//     reservation; a re-claimed attempt starts from what the job already reserved (scan_jobs.spend_reserved_usd).
//   - per trial account, in total across all days (DAZL_TRIAL_ACCOUNT_TOTAL_USD), and
//   - globally per UTC day (DAZL_TRIAL_GLOBAL_DAILY_USD): checked at admission, in one transaction every admission takes
//     in turn (the trial_budget_lock row), so concurrent workers and instances cannot admit against the same room. A
//     scan counts as its full reserve until ALL its paid work has ended - the scan, then its enrichment (buyer fit is
//     a guarded model call after the scan reads 'done') - which the runner records as the reservation's settled_at at
//     the very end of the run (settleTrialReservation), with that run's attempt number. Only when the scan is finished
//     AND its current attempt is the settled one does it count as what it recorded as spent: a retry (queued, or
//     claimed again, which raises the attempt) counts as the full reserve again until that attempt settles.
//     For the day's ceiling, a scan admitted on an earlier day also counts unless its current attempt settled before
//     today began, so work that runs past midnight (a retry included) is charged to both days, never to neither.
// Attempts: at most TRIAL_SCANS_PER_ACCOUNT (3) admitted trial scans per account that can cost dazl money, counted at
// admission under the same lock: a failed or cancelled scan keeps its place once any paid step was reserved; only a
// scan that failed before any cost releases it (releasedBeforeCost).
// Admission (admitTrialScan) also requires a verified Google account, and one trial per company email domain (consumer
// mailboxes count per account). Owner-funded calls outside a scan are off: the search-profile preview of a trial
// account returns the plain profile with no model call (lib/scan/runner.ts previewIcp). "Fill the profile from my
// website" may run on the trial key for a keyless account (#409, lib/scan/trial-site-read.ts): it is paid work in this
// same wallet, a 'site_read' reservation of TRIAL_SITE_READ_RESERVE_USD admitted under the same lock and ceilings
// (account total, day, across midnight), counted at its full reserve until its single model call settles to the cost
// the provider reported, in full even above the reserve. A failed or unreported call is settled AT its full reserve
// (settleTrialSiteRead with null): it keeps costing the account its reserve, but it ends, so it does not count toward
// every later day's global ceiling. A read that never settles at all (the process died between admission and settle)
// is treated as ended READ_GRACE_S after it was admitted for the day ceiling, and keeps its reserve for the account.
// It is not one of the scan attempts.
import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { captureError } from '../ops/errors.ts'
import { asDb, type Db, type DbLike, type Tx, type TxBody } from '../db/client.ts'
import { TRIAL_SCANS_PER_ACCOUNT } from '../scan/trial.ts'

export function migrateTrialBudget(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trial_reservations (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      job_id      TEXT,
      reserve_usd REAL NOT NULL CHECK (reserve_usd > 0),
      day         INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      settled_at  INTEGER,
      settled_attempt INTEGER
    );
    CREATE INDEX IF NOT EXISTS trial_reservations_day ON trial_reservations (day, tenant_id);
    CREATE TABLE IF NOT EXISTS trial_budget_lock (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL DEFAULT 0);
  `)
  // #409: what the reservation paid for (a scan, or a trial-funded website read), and a read's settled cost.
  const cols = (db.prepare('PRAGMA table_info(trial_reservations)').all() as { name: string }[]).map(c => c.name)
  if (!cols.includes('kind')) db.exec("ALTER TABLE trial_reservations ADD COLUMN kind TEXT NOT NULL DEFAULT 'scan' CHECK (kind IN ('scan', 'site_read'))")
  if (!cols.includes('spent_usd')) db.exec('ALTER TABLE trial_reservations ADD COLUMN spent_usd REAL CHECK (spent_usd IS NULL OR spent_usd >= 0)')
}

// The most one trial-funded website read may cost: reserved before its model call (lib/scan/icp-from-site.ts bounds
// the call to fit it with a spend guard).
export const TRIAL_SITE_READ_RESERVE_USD = 0.05
// A read's single call is bounded (the provider timeout, lib/llm/provider.ts) to far less than this. An unsettled read
// older than this counts as ended for the day ceiling (its reserve stays on the account), so a crash between admission
// and settle cannot hold a slice of every later day's global budget.
export const READ_GRACE_S = 3600

export interface TrialCaps {
  reserveUsd: number; accountTotalUsd: number; globalDailyUsd: number
  // Prices of the paid web research a trial scan's own budget counts in the runner (lib/scan/runner.ts): each TinyFish
  // search and fetched URL on dazl's key. Model calls are priced from their bounds (lib/llm/spend-guard.ts). 0 is allowed
  // for a free tier, but must be set.
  tinyfishSearchUsd: number; tinyfishFetchUsd: number
}
const positive = (v: string | undefined) => { const n = Number(v); return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null }
const nonNegative = (v: string | undefined) => { const n = Number(v); return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null }
// null unless every number is set and TinyFish (a trial's only web research) is on: no ceiling or no price, no trial.
export function trialCaps(env: Record<string, string | undefined> = process.env): TrialCaps | null {
  const reserveUsd = positive(env.DAZL_TRIAL_SCAN_RESERVE_USD), accountTotalUsd = positive(env.DAZL_TRIAL_ACCOUNT_TOTAL_USD), globalDailyUsd = positive(env.DAZL_TRIAL_GLOBAL_DAILY_USD)
  if (!env.TINYFISH_API_KEY || env.TINYFISH_ENABLED === '0') return null
  const tinyfishSearchUsd = nonNegative(env.DAZL_TRIAL_TINYFISH_SEARCH_USD), tinyfishFetchUsd = nonNegative(env.DAZL_TRIAL_TINYFISH_FETCH_USD)
  if (!reserveUsd || !accountTotalUsd || !globalDailyUsd || tinyfishSearchUsd === null || tinyfishFetchUsd === null) return null
  return { reserveUsd, accountTotalUsd, globalDailyUsd, tinyfishSearchUsd, tinyfishFetchUsd }
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

export type TrialRefusal = 'not_configured' | 'google_required' | 'domain_used' | 'attempts_cap' | 'account_total_cap' | 'global_daily_cap'
export type Admission = { ok: true; reservation: string } | { ok: false; reason: TrialRefusal }

// A reservation's cost: its reserve while the scan runs (or before it exists, or if creating it failed), then what the
// scan recorded as spent once it ended: scan_jobs.spend_reserved_usd, every paid step the runner counted against the
// trial budget (the runner never records more than the reserve; if a row ever did, it counts in full). The rows: this account's reservations on any day, and every reservation that
// counts toward today (admitted today, or admitted earlier and still running or ended today).
// SETTLED_SQL and settled() are the same rule: the scan is finished and its current attempt's run has settled.
const SETTLED_SQL = "(j.status IN ('done', 'failed') AND r.settled_at IS NOT NULL AND r.settled_attempt = j.attempts)"
const LEDGER_SQL = `SELECT r.tenant_id, r.kind, r.reserve_usd, r.spent_usd, r.day, r.created_at, r.settled_at, r.settled_attempt, j.status, j.error, j.attempts, j.spend_reserved_usd
  FROM trial_reservations r LEFT JOIN scan_jobs j ON j.id = r.job_id AND j.user_id = r.tenant_id
  WHERE r.tenant_id = ? OR r.day = ? OR (r.day < ? AND ((r.kind = 'site_read' AND COALESCE(r.settled_at, r.created_at + ${READ_GRACE_S}) >= ?)
    OR (r.kind <> 'site_read' AND (NOT COALESCE(${SETTLED_SQL}, FALSE) OR r.settled_at >= ?))))`
export type LedgerRow = { tenant_id: string; kind?: string | null; reserve_usd: number; spent_usd?: number | null; day: number; created_at?: number | null; settled_at: number | null; settled_attempt: number | null; status: string | null; error?: string | null; attempts: number | null; spend_reserved_usd: number | null }
const isRead = (r: LedgerRow) => r.kind === 'site_read'
// A website read has ended once its call settled (settled_at); it then counts as the cost the provider reported (or its
// full reserve, for a failed or unreported call). For the day ceiling only, a read that never settled counts as ended
// READ_GRACE_S after it was admitted (see above); its reserve stays on the account.
const readSettled = (r: LedgerRow) => r.settled_at !== null && r.spent_usd !== null && r.spent_usd !== undefined
const readEndedAt = (r: LedgerRow) => r.settled_at !== null ? Number(r.settled_at) : Number(r.created_at ?? 0) + READ_GRACE_S
// Every paid step of the scan has ended: it is finished ('done' or 'failed', not queued for a retry) AND the attempt
// that finished it has settled (a scan reads 'done' before its enrichment, which can still pay for model calls; an
// earlier attempt's settle never releases a later attempt's reserve).
const settled = (r: LedgerRow) => (r.status === 'done' || r.status === 'failed') && r.settled_at !== null && r.settled_attempt !== null && Number(r.settled_attempt) === Number(r.attempts)
// A settled read counts as what the provider reported, in full: its reserve is dazl's own bound, not a vendor-enforced
// maximum, so a reported cost above it is real spend and later work is refused against it.
export const reservationCost = (r: LedgerRow) => isRead(r)
  ? (readSettled(r) ? Math.max(0, Number(r.spent_usd)) : Number(r.reserve_usd))
  : settled(r) ? Math.max(0, Number(r.spend_reserved_usd ?? 0)) : Number(r.reserve_usd)
const countsToday = (r: LedgerRow, day: number) => Number(r.day) === day
  || (Number(r.day) < day && (isRead(r) ? readEndedAt(r) >= day * 86400 : (!settled(r) || Number(r.settled_at) >= day * 86400)))
// A trial attempt released before any cost: its scan failed (not cancelled: a cancelled scan may have paid for work
// already under way), recorded no spend at all, and its current attempt has settled. Every other admission keeps its
// place among the account's TRIAL_SCANS_PER_ACCOUNT attempts: running, queued for a retry, linked to no scan, or
// failed after any paid step.
export const releasedBeforeCost = (r: LedgerRow) => !isRead(r) && settled(r) && r.status === 'failed' && r.error !== 'cancelled' && Number(r.spend_reserved_usd ?? 0) === 0
export function ledger(rows: LedgerRow[], tenantId: string, day: number): { account: number; today: number; attempts: number } {
  let account = 0, today = 0, attempts = 0
  for (const r of rows) {
    // website reads are money in the wallet, not scan attempts
    if (r.tenant_id === tenantId && !isRead(r) && !releasedBeforeCost(r)) attempts++
    if (r.tenant_id === tenantId) account += reservationCost(r)
    if (countsToday(r, day)) today += reservationCost(r)
  }
  return { account, today, attempts }
}

// The checks, as a transaction step: the reason a trial scan would be refused for this user now, or null.
function* refusal(t: Tx, user: { id: string; email: string }, caps: TrialCaps, day: number, reserveUsd = caps.reserveUsd): TxBody<TrialRefusal | null> {
  const google = yield* t.get("SELECT 1 AS x FROM oauth_identities WHERE provider = 'google' AND user_id = ?", [user.id])
  if (!google) return 'google_required'
  const domain = emailDomain(user.email)
  if (domain && !CONSUMER_DOMAINS.has(domain)) {
    // Another account on this company domain already drew on the trial: a scan, or a website read (#409). A read is paid
    // trial work on dazl's key for that company, so it claims the company's one trial like a scan does; the trial then
    // belongs to the account that started it (its reads and scans), not to a colleague. Flagged for the owner in #444.
    // Pinned by test/trial-site-read.test.ts ("a founder's read claims the company domain").
    const other = yield* t.get(`SELECT 1 AS x FROM trial_reservations r JOIN users u ON u.id = r.tenant_id
      WHERE u.id <> ? AND lower(u.email) LIKE ? LIMIT 1`, [user.id, `%@${domain}`])
    if (other) return 'domain_used'
  }
  const l = ledger(yield* t.all<LedgerRow>(LEDGER_SQL, [user.id, day, day, day * 86400, day * 86400]), user.id, day)
  // a small tolerance for float sums (0.1 + 0.2), far below a cent
  // three admitted attempts that can cost dazl money per account, paid failures and cancellations included
  if (l.attempts >= TRIAL_SCANS_PER_ACCOUNT) return 'attempts_cap'
  if (l.account + reserveUsd > caps.accountTotalUsd + 1e-9) return 'account_total_cap'
  if (l.today + reserveUsd > caps.globalDailyUsd + 1e-9) return 'global_daily_cap'
  return null
}

export async function admitTrialScan(db: Db, user: { id: string; email: string }, o: { now?: number; env?: Record<string, string | undefined> } = {}): Promise<Admission> {
  const caps = trialCaps(o.env)
  if (!caps) return { ok: false, reason: 'not_configured' }
  const now = o.now ?? Math.floor(Date.now() / 1000), day = utcDay(now)
  return db.tx(function* (t: Tx): TxBody<Admission> {
    // every admission takes this row first (created by the first admission, so a freshly migrated store stays empty), so
    // two instances cannot both admit against the same remaining budget: the upsert locks the row until this commits
    yield* t.run('INSERT INTO trial_budget_lock (id, n) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET n = trial_budget_lock.n + 1')
    const why = yield* refusal(t, user, caps, day)
    if (why) return { ok: false, reason: why }
    const id = randomBytes(12).toString('hex')
    yield* t.run('INSERT INTO trial_reservations (id, tenant_id, job_id, reserve_usd, day, created_at) VALUES (?, ?, NULL, ?, ?, ?)', [id, user.id, caps.reserveUsd, day, now])
    return { ok: true, reservation: id }
  })
}

// #409: admit one trial-funded website read: the same checks and lock as a scan, against the read's own reserve, and a
// 'site_read' reservation of that reserve in the wallet. Settle it with settleTrialSiteRead once its call has ended.
export async function admitTrialSiteReadBudget(db: Db, user: { id: string; email: string }, o: { now?: number; env?: Record<string, string | undefined> } = {}): Promise<Admission> {
  const caps = trialCaps(o.env)
  if (!caps) return { ok: false, reason: 'not_configured' }
  const now = o.now ?? Math.floor(Date.now() / 1000), day = utcDay(now)
  return db.tx(function* (t: Tx): TxBody<Admission> {
    yield* t.run('INSERT INTO trial_budget_lock (id, n) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET n = trial_budget_lock.n + 1')
    const why = yield* refusal(t, user, caps, day, TRIAL_SITE_READ_RESERVE_USD)
    if (why) return { ok: false, reason: why }
    const id = randomBytes(12).toString('hex')
    yield* t.run("INSERT INTO trial_reservations (id, tenant_id, job_id, reserve_usd, day, created_at, kind) VALUES (?, ?, NULL, ?, ?, ?, 'site_read')", [id, user.id, TRIAL_SITE_READ_RESERVE_USD, day, now])
    return { ok: true, reservation: id }
  })
}
// A read's call has ended. With the cost the provider reported, it counts as that from now on, even above its reserve.
// With null (the call failed, or reported no usable cost), or a non-finite or negative cost, it counts as its full
// reserve from now on: the money stays on the account, but the read has ended, so it no longer counts toward later
// days. Best effort: if this write fails the row stays unsettled (full reserve; READ_GRACE_S bounds its day count), and
// the failure is recorded (lib/ops/errors.ts), never swallowed.
export async function settleTrialSiteRead(db: Db, tenantId: string, reservation: string, spentUsd: number | null, nowS = Math.floor(Date.now() / 1000)): Promise<void> {
  const usd = spentUsd !== null && Number.isFinite(spentUsd) && spentUsd >= 0 ? spentUsd : TRIAL_SITE_READ_RESERVE_USD
  try { await db.run("UPDATE trial_reservations SET settled_at = ?, spent_usd = ? WHERE id = ? AND tenant_id = ? AND kind = 'site_read' AND settled_at IS NULL", [nowS, usd, reservation, tenantId]) }
  catch (e) { captureError(e, { source: 'process', where: 'trial-budget:settleTrialSiteRead', tenantId }) }
}

// For the free-scans counter: why a trial scan would be refused right now (null = it would run), without reserving.
// reserveUsd: the amount the admission would reserve (default: a scan's reserve; a website read passes its own).
export async function trialRefusal(db: Db, user: { id: string; email: string }, o: { now?: number; env?: Record<string, string | undefined>; reserveUsd?: number } = {}): Promise<TrialRefusal | null> {
  const caps = trialCaps(o.env)
  if (!caps) return 'not_configured'
  const day = utcDay(o.now ?? Math.floor(Date.now() / 1000))
  return db.tx(t => refusal(t, user, caps, day, o.reserveUsd))
}

// Called by the runner as the very last step of a trial scan's run (lib/scan/runner.ts), after the scan, its enrichment
// and every guarded paid call: the reservation may now count as what the scan recorded instead of its full reserve.
// Best effort: if this write fails, the reservation keeps counting in full (never less than it could spend).
export async function settleTrialReservation(db: DbLike, jobId: string, attempt: number, nowS = Math.floor(Date.now() / 1000)): Promise<void> {
  try { await asDb(db).run('UPDATE trial_reservations SET settled_at = ?, settled_attempt = ? WHERE job_id = ?', [nowS, attempt, jobId]) }
  catch (e) { captureError(e, { source: 'process', where: 'trial-budget:settleTrialReservation' }) } // stays at its full reserve; recorded (was silent on main)
}

// The scan the reservation paid for, once it exists. Until then (or if creating it failed) the reservation counts as
// its full reserve for the day.
export async function linkTrialReservation(db: Db, tenantId: string, reservation: string, jobId: string): Promise<void> {
  await db.run('UPDATE trial_reservations SET job_id = ? WHERE id = ? AND tenant_id = ? AND job_id IS NULL', [jobId, reservation, tenantId])
}

// An admission that ends with no scan (anything after the reservation threw before the job existed) is released: the attempt and the reserved budget are given back. Only a reservation
// of this tenant that was never linked to a job, or that was pre-linked to `neverCreatedJobId` - the id of a job whose creation was rolled back (the caller confirms it does not exist).
// A reservation linked to a real scan is never touched here.
export async function releaseTrialReservation(db: Db, tenantId: string, reservation: string, neverCreatedJobId?: string): Promise<boolean> {
  if (neverCreatedJobId) {
    const exists = await db.get('SELECT 1 AS x FROM scan_jobs WHERE id = ?', [neverCreatedJobId])
    if (exists) return false
    return (await db.run('DELETE FROM trial_reservations WHERE id = ? AND tenant_id = ? AND (job_id IS NULL OR job_id = ?)', [reservation, tenantId, neverCreatedJobId])).changes > 0
  }
  return (await db.run('DELETE FROM trial_reservations WHERE id = ? AND tenant_id = ? AND job_id IS NULL', [reservation, tenantId])).changes > 0
}

// Whose free trial a workspace draws on: the account that founded it, read on the server, and only while that account
// itself is acting (app/api/scan/route.ts, app/api/scan/icp-from-url/route.ts, app/api/usage/route.ts). A personal
// workspace's id is its founder's user id (lib/workspaces.ts createPersonalWorkspace); the principal is that users row,
// whose id carries the wallet, attempts and Google sign-in and whose email the one-trial-per-company-domain rule reads.
// The acting session's email never stands in for it. Another member acting in the workspace, a team workspace, or a
// workspace without its founder's users row has no trial principal: refused (fails closed). The trial stays with the
// workspace's founder account; it does not follow a member.
export async function trialPrincipal(db: Db, user: { tenantId: string; actorId: string }): Promise<{ id: string; email: string } | null> {
  if (user.actorId !== user.tenantId) return null
  const r = await db.get<{ id: string; email: string }>(
    "SELECT u.id, u.email FROM organizations o JOIN users u ON u.id = o.id AND u.id = o.created_by WHERE o.id = ? AND o.kind = 'personal'", [user.tenantId])
  return r && typeof r.email === 'string' && r.email.includes('@') ? { id: r.id, email: r.email } : null
}
