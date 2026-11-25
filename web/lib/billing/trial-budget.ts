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
//   - globally per day, Toronto time (DAZL_TRIAL_GLOBAL_DAILY_USD; #1621, see trialDay and globalDailyCapUsd): checked at admission, in one transaction every admission takes
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
// Admission (admitTrialScan) also requires a verified Google account (#1095: except a confirmed password account's first
// scan, see PASSWORD_TRIAL_SCANS), and one trial per company email domain (consumer
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
import { recordedJobCostUsd } from '../scan/job-cost.ts'
import { isStaging } from '../staging.ts'
import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { captureError } from '../ops/errors.ts'
import { asDb, type Db, type DbLike, type Tx, type TxBody } from '../db/client.ts'
import { operatorKey, TRIAL_SCANS_PER_ACCOUNT } from '../scan/trial.ts'
import { trialIdentity } from '../auth/email-identity.ts'

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
}
const positive = (v: string | undefined) => { const n = Number(v); return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null }
const nonNegative = (v: string | undefined) => { const n = Number(v); return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null }
// null unless all three money limits are set: no ceiling, no trial. #1602: a free scan runs on Claude (dazl's own Anthropic key,
// checked by trialFundable and the scan route) and needs nothing else. It used to require a second search service's key and two of its
// prices as well, so switching that service off switched free scans off for every new account.
export function trialCaps(env: Record<string, string | undefined> = process.env): TrialCaps | null {
  const reserveUsd = positive(env.DAZL_TRIAL_SCAN_RESERVE_USD), accountTotalUsd = positive(env.DAZL_TRIAL_ACCOUNT_TOTAL_USD), globalDailyUsd = positive(env.DAZL_TRIAL_GLOBAL_DAILY_USD)
  if (!reserveUsd || !accountTotalUsd || !globalDailyUsd) return null
  return { reserveUsd, accountTotalUsd, globalDailyUsd }
}
// What the older engine charges a free scan for each TinyFish search and fetched URL (0 is allowed, but both must be set). Only that
// engine reads it, and only with TinyFish switched on by name; a free scan with no price here makes no TinyFish call. Not part of
// whether a free scan is offered.
export function trialTinyfishPrices(env: Record<string, string | undefined> = process.env): { searchUsd: number; fetchUsd: number } | null {
  const searchUsd = nonNegative(env.DAZL_TRIAL_TINYFISH_SEARCH_USD), fetchUsd = nonNegative(env.DAZL_TRIAL_TINYFISH_FETCH_USD)
  return searchUsd === null || fetchUsd === null ? null : { searchUsd, fetchUsd }
}

// #409 admission isolation: the money ceilings every trial-funded admission is checked against - the account's total
// and the deployment's day. A website read needs only these (plus its own gates: lib/scan/trial-site-read.ts operator
// key, DAZL_TRIAL_SITE_READS_PER_DAY, DAZL_TRIAL_SITE_READ_ALLOWLIST); a trial scan needs ALL of trialCaps (its own
// per-scan reserve and TinyFish prices on top). So a deployment can fund one allowlisted website read with
// DAZL_TRIAL_SCAN_RESERVE_USD (or the TinyFish prices) left unset, and trial scans stay OFF for every account - before
// this, enabling a read required the full scan config, which opened trial scans to every eligible signup. Both default
// OFF: null unless both ceilings are set to a positive number.
export interface TrialWallet { accountTotalUsd: number; globalDailyUsd: number }
export function trialWalletCaps(env: Record<string, string | undefined> = process.env): TrialWallet | null {
  const accountTotalUsd = positive(env.DAZL_TRIAL_ACCOUNT_TOTAL_USD), globalDailyUsd = positive(env.DAZL_TRIAL_GLOBAL_DAILY_USD)
  return accountTotalUsd && globalDailyUsd ? { accountTotalUsd, globalDailyUsd } : null
}

// Whether a trial scan could actually be admitted right now (#668 review): the operator key alone is not enough -
// admitTrialScan also requires trialCaps() to resolve, and a deployment can have the key set with the ceilings/TinyFish
// config absent (production was in exactly that state). The one helper every "is the trial on" copy/claim must share,
// so the sign-up page, Settings and admission itself cannot drift from each other.
export const trialFundable = (env: NodeJS.ProcessEnv = process.env): boolean => !!operatorKey(env) && trialCaps(env) !== null

// Mailbox providers anyone can sign up to: the one-trial-per-domain rule would lock out everyone else on them, so these
// count per account only (a verified Google account each).
export const CONSUMER_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'web.de', 'mail.com', 'zoho.com', 'yandex.com',
  'yandex.ru', 'mail.ru', 'qq.com', '163.com', '126.com', 'naver.com', 'rediffmail.com', 'hotmail.co.uk', 'yahoo.co.uk', 'yahoo.co.in', 'outlook.in'])
export const emailDomain = (email: string) => email.trim().toLowerCase().split('@')[1] ?? ''

// #1621: the shared daily allowance starts again at midnight in Toronto (dazl's day), not at midnight UTC (which is 7pm or 8pm
// there, the middle of the evening). A day is numbered by its Toronto calendar date (days since 1970-01-01), so it is the same
// number a UTC day had, and rows written before this keep their meaning but for the few hours between the two midnights.
export const TRIAL_ZONE = 'America/Toronto'
const zoneDate = new Intl.DateTimeFormat('en-CA', { timeZone: TRIAL_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
// The Toronto calendar date at this moment, as YYYY-MM-DD.
export function trialDate(nowS: number): string {
  const p = Object.fromEntries(zoneDate.formatToParts(new Date(nowS * 1000)).map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
}
export const trialDay = (nowS: number) => Math.floor(Date.parse(`${trialDate(nowS)}T00:00:00Z`) / 86_400_000)
// The moment (unix seconds) that day starts in Toronto: 04:00 UTC in summer, 05:00 UTC in winter.
export function trialDayStart(day: number): number {
  for (const h of [4, 5]) { const s = day * 86400 + h * 3600; if (trialDay(s) === day && trialDay(s - 1) === day - 1) return s }
  return day * 86400 + 5 * 3600
}
// #1621 (owner): on launch day, Friday 2026-11-27 Toronto time, the shared daily allowance of $13.33 is $40; from midnight it is
// $13.33 again, with nothing to switch by hand. The built-in rule lifts exactly that configured amount (LAUNCH_DAY.fromUsd) and no
// other: a deployment (or a test) configured with any other DAZL_TRIAL_GLOBAL_DAILY_USD keeps its own ceiling on that date too.
// DAZL_TRIAL_GLOBAL_DAILY_BY_DATE replaces the rule with dates that apply whatever the configured amount
// ("2026-11-27=40,2026-12-04=25"; set it to "off" for no special days).
export const LAUNCH_DAY = { date: '2026-11-27', fromUsd: 13.33, toUsd: 40 } as const
export function globalDailyCapUsd(baseUsd: number, day: number, env: Record<string, string | undefined> = process.env): number {
  const date = new Date(day * 86_400_000).toISOString().slice(0, 10)
  const raw = env.DAZL_TRIAL_GLOBAL_DAILY_BY_DATE
  if (raw === undefined) return date === LAUNCH_DAY.date && Math.abs(baseUsd - LAUNCH_DAY.fromUsd) < 1e-9 ? LAUNCH_DAY.toUsd : baseUsd
  for (const part of raw.split(',')) { const [d, v] = part.split('=').map(x => x.trim()); const n = positive(v); if (d === date && /^\d{4}-\d{2}-\d{2}$/.test(d) && n) return n }
  return baseUsd
}

// The reason a free-trial scan stopped at its budget (scan_jobs.error) and why its leads are in review (leads.review_reason).
export const TRIAL_BUDGET_REASON = 'trial_budget_reached'

// Every reason a free-trial scan can be refused. The copy for each (lib/trial-copy.ts TRIAL_REFUSAL_COPY) is checked
// against this list, so a new reason cannot ship without words a customer can read (#1095).
export const TRIAL_REFUSALS = ['not_configured', 'google_required', 'domain_used', 'attempts_cap', 'account_total_cap', 'global_daily_cap'] as const
export type TrialRefusal = typeof TRIAL_REFUSALS[number]
// #402: the account setup every free-trial run (scan or website read) needs before admission, as the product truth record's
// `requires` tokens (lib/product-truth.ts). refusal() below enforces exactly this list, so the record and the gate cannot drift.
export const TRIAL_REQUIRES = ['google_account'] as const
// TEST-ONLY (#1037 item 3: check a brand-new account's first play on staging without a Google sign-in). Active ONLY when
// DAZL_ENV=staging; DAZL_STAGING_TRIAL_NO_GOOGLE names exact test addresses (comma-separated, no wildcards) that skip ONLY the Google
// prerequisite - every other trial gate (domain, attempts, account total, global daily) still applies. Inert everywhere else, so the
// product truth record's requirement stays true for every real account.
export function stagingTrialWithoutGoogle(email: string, env: Record<string, string | undefined> = process.env): boolean {
  if (!isStaging(env)) return false
  const list = (env.DAZL_STAGING_TRIAL_NO_GOOGLE ?? '').split(',').map(x => x.trim().toLowerCase()).filter(x => x && !x.includes('*'))
  return list.includes(email.trim().toLowerCase())
}
const GOOGLE_SQL = "SELECT 1 AS x FROM oauth_identities WHERE provider = 'google' AND user_id = ?"
// One check per listed prerequisite: a token added to TRIAL_REQUIRES without its check here does not typecheck, so the record can
// never advertise a prerequisite the gate does not enforce.
const TRIAL_REQUIREMENT_CHECKS: { [K in typeof TRIAL_REQUIRES[number]]: { refusal: TrialRefusal; sql: string } } = {
  google_account: { refusal: 'google_required', sql: GOOGLE_SQL },
}
export type Admission = { ok: true; reservation: string } | { ok: false; reason: TrialRefusal }

// #1095 (owner, 2026-11-23: "let password users run free scans"): an account made with a password runs its FIRST search free
// without Google. This narrows the Google guard, on purpose, and only this far:
//   - only PASSWORD_TRIAL_SCANS (1) scan, and the website reads that come before it in onboarding (2026-11-24); the second free scan,
//     and any website read after that one scan is used, still needs Google
//     (refused google_required, which the screens answer with Link Google). The first search counts toward the usual three.
//   - the address must be confirmed (users.email_verified_at): a sign-up made where dazl can send mail cannot sign in before that.
//   - one per mailbox: a +tag alias, or a Gmail address that differs only by dots or googlemail.com, of a mailbox that already drew
//     on the trial is refused; one trial per company domain (below) covers every other domain, throwaway ones included.
//   - every money ceiling (per scan, per account, per day) and the per-network daily throttle (lib/scan/trial.ts) are unchanged,
//     so the most this can cost dazl in a day is the same DAZL_TRIAL_GLOBAL_DAILY_USD as before.
// DAZL_TRIAL_PASSWORD_FIRST_SCAN=0 switches it off (every free scan needs Google again).
export const PASSWORD_TRIAL_SCANS = 1
export const passwordTrialOn = (env: Record<string, string | undefined> = process.env) => !['0', 'off', 'false', 'no'].includes((env.DAZL_TRIAL_PASSWORD_FIRST_SCAN ?? '').trim().toLowerCase())
const GMAIL = ['gmail.com', 'googlemail.com']
// The mailbox an address delivers to, as far as dazl can tell without asking the provider: lower case, no +tag, and on Gmail no dots.
// #1801: the definition lives in lib/auth/email-identity.ts (trialIdentity), shared and pinned by its own suite; this is the same function.
export const canonicalMailbox = trialIdentity
// OPERATOR SWITCH (#1579): DAZL_TRIAL_QA_EXEMPT names the acceptance tester's account(s), by exact address (comma-separated; an entry
// with a * or without an @ is ignored; unset or empty = nobody, and nothing here changes for anyone). A listed account is not stopped by
// the limits that count one account or one network, for a free scan or a free website read:
//   - here (refusal, trialScanAllowance): the Google sign-in (a confirmed address is still required, as for every password account),
//     one trial per company domain, the scan attempts, the account's dollar total, the one-scan allowance of a password account;
//   - lib/scan/trial.ts: the account's scan count and the per-network scans per day;
//   - lib/scan/trial-site-read.ts: the account's three website reads per 30 days, the per-network reads per day, and the allowlist
//     (a listed account counts as on it);
//   - app/api/scan/route.ts: the plan's monthly scan quota.
// What still binds it, unchanged: the trial must be configured (not_configured), the GLOBAL daily ceiling (the money guard: its work
// reserves and settles in the same ledger and counts toward the day like anyone's, so the day's spend can never pass
// DAZL_TRIAL_GLOBAL_DAILY_USD because of it), the per-scan reserve, the deployment's website reads per day, sign-in and confirmation.
// The address is matched exactly (trimmed, lower case), as stagingTrialWithoutGoogle does: a +tag alias or a Gmail dot variant of a
// listed address is another account and is NOT exempt.
export function trialQaExempt(email: string, env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.DAZL_TRIAL_QA_EXEMPT ?? ''
  if (!raw.trim()) return false
  const me = email.trim().toLowerCase()
  return raw.split(',').map(x => x.trim().toLowerCase()).some(x => x.includes('@') && !x.includes('*') && x === me)
}
// The same, for a caller that holds only the account's id. No query at all while the switch is unset.
export async function trialQaExemptAccount(db: Db, userId: string, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (!(env.DAZL_TRIAL_QA_EXEMPT ?? '').trim()) return false
  const u = await db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [userId])
  return !!u && trialQaExempt(String(u.email), env)
}
const VERIFIED_SQL = 'SELECT 1 AS x FROM users WHERE id = ? AND email_verified_at IS NOT NULL'
// Whether this account, which has no Google sign-in, may run a free scan on the password path: confirmed address, and no other
// account of the same mailbox has drawn on the trial. (Company domains are held to one trial by the domain rule in refusal.)
function* passwordPathOpen(t: Tx, user: { id: string; email: string }): TxBody<boolean> {
  if (!(yield* t.get(VERIFIED_SQL, [user.id]))) return false
  const domain = emailDomain(user.email)
  if (!CONSUMER_DOMAINS.has(domain)) return true
  const me = canonicalMailbox(user.email)
  for (const d of GMAIL.includes(domain) ? GMAIL : [domain]) {
    const others = yield* t.all<{ email: string }>(`SELECT DISTINCT u.email AS email FROM trial_reservations r JOIN users u ON u.id = r.tenant_id
      WHERE u.id <> ? AND lower(u.email) LIKE ?`, [user.id, `%@${d}`])
    if (others.some(o => canonicalMailbox(String(o.email)) === me)) return false
  }
  return true
}
// How many free scans the account can have as it stands, for the counter: all of them with Google (or the staging test bypass),
// the first one without. Read-only; admission decides for itself under the lock.
export async function trialScanAllowance(db: Db, userId: string, env: Record<string, string | undefined> = process.env): Promise<number> {
  if (await db.get(GOOGLE_SQL, [userId])) return TRIAL_SCANS_PER_ACCOUNT
  const u = await db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [userId])
  if (u && (stagingTrialWithoutGoogle(String(u.email), env) || trialQaExempt(String(u.email), env))) return TRIAL_SCANS_PER_ACCOUNT
  return passwordTrialOn(env) ? PASSWORD_TRIAL_SCANS : TRIAL_SCANS_PER_ACCOUNT
}

// A reservation's cost: its reserve while the scan runs (or before it exists, or if creating it failed), then, once the run
// has settled, the job's one recorded cost (lib/scan/job-cost.ts, #1517): what the providers billed for each paid call
// (the per-scan cap ledger), a call that never reported a cost at the amount reserved for it. The difference from the
// worst-case reservation goes back to the allowance, and the scan's page and job record show that same number. The trial
// run guard (spend_reserved_usd) never settles down from its worst case, so it is not the cost of a ledgered scan; it stays
// the record only for a scan from before the cap ledger. A cost that cannot be read counts as the full reserve. The rows: this account's reservations on any day, and every reservation that
// counts toward today (admitted today, or admitted earlier and still running or ended today).
// SETTLED_SQL and settled() are the same rule: the scan is finished and its current attempt's run has settled.
const SETTLED_SQL = "(j.status IN ('done', 'failed') AND r.settled_at IS NOT NULL AND r.settled_attempt = j.attempts)"
const HAS_SAVED_LEADS_SQL = 'EXISTS (SELECT 1 FROM leads l WHERE l.scan_job_id = j.id)'
const LEDGER_SQL = `SELECT r.tenant_id, r.kind, r.reserve_usd, r.spent_usd, r.day, r.created_at, r.settled_at, r.settled_attempt, j.status, j.error, j.candidates, j.attempts, j.spend_reserved_usd, j.spend_cap_reserved_usd,
  CASE WHEN j.error = 'accounting_uncertain' THEN ${HAS_SAVED_LEADS_SQL} END AS has_saved_leads
  FROM trial_reservations r LEFT JOIN scan_jobs j ON j.id = r.job_id AND j.user_id = r.tenant_id
  WHERE r.tenant_id = ? OR r.day = ? OR (r.day < ? AND ((r.kind = 'site_read' AND COALESCE(r.settled_at, r.created_at + ${READ_GRACE_S}) >= ?)
    OR (r.kind <> 'site_read' AND (NOT COALESCE(${SETTLED_SQL}, FALSE) OR r.settled_at >= ?))))`
export type LedgerRow = { tenant_id: string; kind?: string | null; reserve_usd: number; spent_usd?: number | null; day: number; created_at?: number | null; settled_at: number | null; settled_attempt: number | null; status: string | null; error?: string | null; candidates?: number | null; attempts: number | null; spend_reserved_usd: number | null; spend_cap_reserved_usd?: number | string | null; has_saved_leads?: boolean | 0 | 1 | null }
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
  : settled(r) ? Math.max(0, recordedJobCostUsd(r.spend_reserved_usd, r.spend_cap_reserved_usd) ?? Number(r.reserve_usd)) : Number(r.reserve_usd)
const countsToday = (r: LedgerRow, day: number) => Number(r.day) === day
  || (Number(r.day) < day && (isRead(r) ? readEndedAt(r) >= trialDayStart(day) : (!settled(r) || Number(r.settled_at) >= trialDayStart(day))))
// A trial attempt released before any cost: its scan failed (not cancelled: a cancelled scan may have paid for work
// already under way), recorded no spend at all, and its current attempt has settled. Every other admission keeps its
// place among the account's TRIAL_SCANS_PER_ACCOUNT attempts: running, queued for a retry, linked to no scan, or
// failed after any paid step.
// A scan that STOPPED AFTER AN INTERRUPTION (error accounting_uncertain: a paid step may already have been billed, so its results were
// discarded) also gives its place back once its run has settled: the person got nothing, and the cost screen promises free scans, not
// interrupted ones. The customer dollar allowance is restored when an interrupted scan saved no leads.
// The platform's daily cost still includes the recorded spend so provider safety limits continue to bind.
// The attempt rule is also applied by lib/scan/trial.ts TRIAL_USED_SQL (the first check and the usage counter), pinned equal
// by test/trial-interrupted-attempt.test.ts, and a reaped (dead-worker) scan is settled by lib/billing/trial-reap.ts so it is released too.
// A free scan that STOPPED AT ITS SPENDING LIMIT before it found any company (status done, error trial_budget_reached, candidates recorded as 0)
// also gives its place back once its run has settled: the person got nothing, and a free scan that cannot find anything is not a used one.
// Only the attempt COUNT: its recorded spend still counts as money (reservationCost), so the $0.30 / $1 / $10 caps are unchanged. A stop that
// kept any candidate, or whose candidate count was never recorded (null), keeps its place. Mirrored by lib/scan/trial.ts TRIAL_USED_SQL.
const stoppedEmpty = (r: LedgerRow) => r.status === 'done' && r.error === TRIAL_BUDGET_REASON && r.candidates !== null && r.candidates !== undefined && Number(r.candidates) === 0
export const releasedBeforeCost = (r: LedgerRow) => !isRead(r) && settled(r) && (stoppedEmpty(r) || (r.status === 'failed'
  && ((r.error !== 'cancelled' && Number(r.spend_reserved_usd ?? 0) === 0) || r.error === 'accounting_uncertain')))
export function ledger(rows: LedgerRow[], tenantId: string, day: number): { account: number; today: number; attempts: number } {
  let account = 0, today = 0, attempts = 0
  for (const r of rows) {
    // website reads are money in the wallet, not scan attempts
    if (r.tenant_id === tenantId && !isRead(r) && !releasedBeforeCost(r)) attempts++
    const cost = reservationCost(r)
    const restored = !isRead(r) && settled(r) && r.status === 'failed' && r.error === 'accounting_uncertain'
      && (r.has_saved_leads === false || r.has_saved_leads === 0)
    if (r.tenant_id === tenantId && !restored) account += cost
    if (countsToday(r, day)) today += cost
  }
  return { account, today, attempts }
}

// The checks, as a transaction step: the reason a trial scan would be refused for this user now, or null.
// The attempts counter is the account's trial SCANS only (ledger: a website read is money in the wallet, not an
// attempt), and it is checked for every kind: an account that used its three scan attempts gets no funded read either
// (#409 "exhausted budget"), while reads never use up a scan attempt. Pinned by test/trial-admission-isolation.test.ts.
function* refusal(t: Tx, user: { id: string; email: string }, caps: TrialWallet, day: number, reserveUsd: number, env: Record<string, string | undefined> = process.env): TxBody<TrialRefusal | null> {
  let attemptsCap = TRIAL_SCANS_PER_ACCOUNT
  // #1579: the operator's acceptance account (DAZL_TRIAL_QA_EXEMPT) skips the per-account checks below; the day's ceiling still binds it
  const exempt = trialQaExempt(user.email, env)
  for (const req of TRIAL_REQUIRES) {
    if (req === 'google_account' && stagingTrialWithoutGoogle(user.email, env)) continue
    const check = TRIAL_REQUIREMENT_CHECKS[req]
    if (yield* t.get(check.sql, [user.id])) continue
    // exempt: a confirmed address stands in for the Google sign-in; an unconfirmed one is refused below like any other
    if (exempt && req === 'google_account' && (yield* t.get(VERIFIED_SQL, [user.id]))) continue
    // #1095: without Google, a confirmed password account still runs its first scan (see PASSWORD_TRIAL_SCANS), and the website
    // read that comes before it in onboarding (owner, 2026-11-24: free website reads for every new account). Once that one scan
    // is used, the attempts check below asks for Google, for a read as for a scan.
    if (!(req === 'google_account' && passwordTrialOn(env) && (yield* passwordPathOpen(t, user)))) return check.refusal
    attemptsCap = PASSWORD_TRIAL_SCANS
  }
  const domain = emailDomain(user.email)
  if (!exempt && domain && !CONSUMER_DOMAINS.has(domain)) {
    // Another account on this company domain already drew on the trial: a scan, or a website read (#409). A read is paid
    // trial work on dazl's key for that company, so it claims the company's one trial like a scan does; the trial then
    // belongs to the account that started it (its reads and scans), not to a colleague. Flagged for the owner in #444.
    // Pinned by test/trial-site-read.test.ts ("a founder's read claims the company domain").
    const other = yield* t.get(`SELECT 1 AS x FROM trial_reservations r JOIN users u ON u.id = r.tenant_id
      WHERE u.id <> ? AND lower(u.email) LIKE ? LIMIT 1`, [user.id, `%@${domain}`])
    if (other) return 'domain_used'
  }
  const l = ledger(yield* t.all<LedgerRow>(LEDGER_SQL, [user.id, day, day, trialDayStart(day), trialDayStart(day)]), user.id, day)
  // a small tolerance for float sums (0.1 + 0.2), far below a cent
  // three admitted attempts that can cost dazl money per account, paid failures and cancellations included
  // (#1095: one without Google; past it the answer is to link Google, which opens the rest)
  if (!exempt && l.attempts >= attemptsCap) return attemptsCap < TRIAL_SCANS_PER_ACCOUNT ? 'google_required' : 'attempts_cap'
  if (!exempt && l.account + reserveUsd > caps.accountTotalUsd + 1e-9) return 'account_total_cap'
  if (l.today + reserveUsd > globalDailyCapUsd(caps.globalDailyUsd, day, env) + 1e-9) return 'global_daily_cap'
  return null
}

export async function admitTrialScan(db: Db, user: { id: string; email: string }, o: { now?: number; env?: Record<string, string | undefined> } = {}): Promise<Admission> {
  const caps = trialCaps(o.env)
  if (!caps) return { ok: false, reason: 'not_configured' }
  const now = o.now ?? Math.floor(Date.now() / 1000), day = trialDay(now)
  return db.tx(function* (t: Tx): TxBody<Admission> {
    // every admission takes this row first (created by the first admission, so a freshly migrated store stays empty), so
    // two instances cannot both admit against the same remaining budget: the upsert locks the row until this commits
    yield* t.run('INSERT INTO trial_budget_lock (id, n) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET n = trial_budget_lock.n + 1')
    const why = yield* refusal(t, user, caps, day, caps.reserveUsd, o.env ?? process.env)
    if (why) return { ok: false, reason: why }
    const id = randomBytes(12).toString('hex')
    yield* t.run('INSERT INTO trial_reservations (id, tenant_id, job_id, reserve_usd, day, created_at) VALUES (?, ?, NULL, ?, ?, ?)', [id, user.id, caps.reserveUsd, day, now])
    return { ok: true, reservation: id }
  })
}

// #409: admit one trial-funded website read: the same checks and lock as a scan, against the read's own reserve, and a
// 'site_read' reservation of that reserve in the wallet. Settle it with settleTrialSiteRead once its call has ended.
// Gated by the wallet's money ceilings only (trialWalletCaps), never by the scan config: see trialWalletCaps.
export async function admitTrialSiteReadBudget(db: Db, user: { id: string; email: string }, o: { now?: number; env?: Record<string, string | undefined> } = {}): Promise<Admission> {
  const caps = trialWalletCaps(o.env)
  if (!caps) return { ok: false, reason: 'not_configured' }
  const now = o.now ?? Math.floor(Date.now() / 1000), day = trialDay(now)
  return db.tx(function* (t: Tx): TxBody<Admission> {
    yield* t.run('INSERT INTO trial_budget_lock (id, n) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET n = trial_budget_lock.n + 1')
    const why = yield* refusal(t, user, caps, day, TRIAL_SITE_READ_RESERVE_USD, o.env ?? process.env)
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
// kind 'site_read' asks the same for a website read instead: the wallet's ceilings only (trialWalletCaps), against the
// read's reserve, so it agrees with admitTrialSiteReadBudget. reserveUsd overrides the amount checked.
export async function trialRefusal(db: Db, user: { id: string; email: string }, o: { now?: number; env?: Record<string, string | undefined>; reserveUsd?: number; kind?: 'scan' | 'site_read' } = {}): Promise<TrialRefusal | null> {
  const read = o.kind === 'site_read'
  const caps = read ? trialWalletCaps(o.env) : trialCaps(o.env)
  if (!caps) return 'not_configured'
  const day = trialDay(o.now ?? Math.floor(Date.now() / 1000))
  const reserveUsd = o.reserveUsd ?? (read ? TRIAL_SITE_READ_RESERVE_USD : (caps as TrialCaps).reserveUsd)
  return db.tx(t => refusal(t, user, caps, day, reserveUsd, o.env ?? process.env))
}

// What is left of the account's trial dollar allowance, for the cost screen (read-only; admission and the caps are untouched): the account total
// minus what this account's trial work counts as now (the same ledger the admission check uses: settled scans and reads at what they recorded,
// running or unsettled ones at their full reserve, website reads included). null when the trial is not configured or the ledger cannot be read:
// the screen then shows no line, never a guessed one. Clamped to 0..total.
export async function trialAllowanceLeft(db: Db, tenantId: string, o: { now?: number; env?: Record<string, string | undefined> } = {}): Promise<{ left_usd: number; total_usd: number } | null> {
  const caps = trialWalletCaps(o.env)
  if (!caps) return null
  const day = trialDay(o.now ?? Math.floor(Date.now() / 1000))
  try {
    // #1579: the account total does not bind the operator's acceptance account, so there is no "left" to show: no line
    if (await trialQaExemptAccount(db, tenantId, o.env ?? process.env)) return null
    const l = ledger(await db.all<LedgerRow>(LEDGER_SQL, [tenantId, day, day, trialDayStart(day), trialDayStart(day)]), tenantId, day)
    if (!Number.isFinite(l.account)) return null
    return { left_usd: Math.min(caps.accountTotalUsd, Math.max(0, caps.accountTotalUsd - l.account)), total_usd: caps.accountTotalUsd }
  } catch { return null }
}

// The customer-facing outcome must only promise a refund if the current trial attempt settled without saved leads.
export async function interruptedTrialAllowanceRestored(db: Db, tenantId: string, jobId: string): Promise<boolean> {
  const row = await db.get(`SELECT 1 FROM trial_reservations r JOIN scan_jobs j ON j.id = r.job_id AND j.user_id = r.tenant_id
    WHERE r.tenant_id = ? AND r.job_id = ? AND r.kind = 'scan'
      AND j.status = 'failed' AND j.error = 'accounting_uncertain' AND ${SETTLED_SQL} AND NOT ${HAS_SAVED_LEADS_SQL}`,
    [tenantId, jobId]).catch(() => undefined)
  return row != null
}

// Called by the runner as the very last step of a trial scan's run (lib/scan/runner.ts), after the scan, its enrichment
// and every guarded paid call: the reservation may now count as what the scan recorded instead of its full reserve.
// Best effort: if this write fails, the reservation keeps counting in full (never less than it could spend).
export async function settleTrialReservation(db: DbLike, jobId: string, attempt: number, nowS = Math.floor(Date.now() / 1000)): Promise<void> {
  try { await asDb(db).run('UPDATE trial_reservations SET settled_at = ?, settled_attempt = ? WHERE job_id = ?', [nowS, attempt, jobId]) }
  catch (e) { captureError(e, { source: 'process', where: 'trial-budget:settleTrialReservation' }) } // stays at its full reserve; recorded (was silent on main)
}

// A locally pinned run has no next attempt. Its launcher also calls this after an early return or crash before the
// runner's normal finalizer. Don't rewrite a completed settlement or reduce the reserve while any call is unsettled.
export async function settlePinnedTrialReservation(db: DbLike, tenantId: string, jobId: string, attempt: number, nowS = Math.floor(Date.now() / 1000)): Promise<void> {
  try {
    await asDb(db).run(`UPDATE trial_reservations SET settled_at = ?, settled_attempt = ?
      WHERE tenant_id = ? AND job_id = ? AND kind = 'scan' AND settled_at IS NULL
        AND EXISTS (SELECT 1 FROM scan_jobs j WHERE j.id = ? AND j.user_id = ? AND j.attempts = ?
          AND (j.status = 'failed' OR (j.status = 'done' AND (j.enrich_started_at IS NULL OR j.enrich_finished_at IS NOT NULL))))
        AND NOT EXISTS (SELECT 1 FROM scan_spend_calls c WHERE c.scan_job_id = ? AND c.status = 'reserved')`,
    [nowS, attempt, tenantId, jobId, jobId, tenantId, attempt, jobId])
  } catch (e) {
    captureError(e, { source: 'process', where: 'trial-budget:settlePinnedTrialReservation' }) // uncertain or unreadable: hold in full
  }
}

// The scan the reservation paid for, once it exists. Until then (or if creating it failed) the reservation counts as
// its full reserve for the day.
export async function linkTrialReservation(db: Db, tenantId: string, reservation: string, jobId: string): Promise<void> {
  await db.run('UPDATE trial_reservations SET job_id = ? WHERE id = ? AND tenant_id = ? AND job_id IS NULL', [jobId, reservation, tenantId])
}

// An admission that ends with no scan (anything after the reservation threw before the job existed) is released: the attempt and the reserved budget are given back. Only a reservation
// of this tenant that was never linked to a job, or that was pre-linked to `neverCreatedJobId` - the id of a job whose creation was rolled back (the caller confirms it does not exist).
// A reservation linked to a real scan is never touched here, and neither is one that has settled (a website read whose
// call ended and recorded its cost, #409): a settled row is money spent, never released. Returns whether a row went.
export async function releaseTrialReservation(db: Db, tenantId: string, reservation: string, neverCreatedJobId?: string): Promise<boolean> {
  if (neverCreatedJobId) {
    const exists = await db.get('SELECT 1 AS x FROM scan_jobs WHERE id = ?', [neverCreatedJobId])
    if (exists) return false
    return (await db.run('DELETE FROM trial_reservations WHERE id = ? AND tenant_id = ? AND settled_at IS NULL AND (job_id IS NULL OR job_id = ?)', [reservation, tenantId, neverCreatedJobId])).changes > 0
  }
  return (await db.run('DELETE FROM trial_reservations WHERE id = ? AND tenant_id = ? AND settled_at IS NULL AND job_id IS NULL', [reservation, tenantId])).changes > 0
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
