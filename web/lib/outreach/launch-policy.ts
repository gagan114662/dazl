// Calibrated launch (#405): an alternative to approving the first WARMUP_SENDS emails by hand. The tenant writes one
// explicit launch policy - who sends, to whom, what is excluded, how much, what the copy may claim, when to stop - and
// the machine runs a preflight against it. Only a policy the tenant accepted at the current version, with every check
// passing, replaces the hand-approval warmup. The warmup is the default for a tenant with no policy; once a policy is
// accepted it is the tenant's last word: until a preflight passes (or the tenant withdraws the policy) autopilot pauses
// (launch_not_calibrated) rather than sending under the warmup's wider rules. Nothing here changes existing consent.
// Every other autopilot guard (reply, opt-out and bounce stops, uncertain-send pause, daily and per-domain caps,
// suppression) still applies on top, and the first days of a calibrated launch run under a stricter rollout cap.
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { MAX_DAILY } from './autopilot.ts'
import type { Provider } from '../llm/provider.ts'
import { callCostUsd, PRICES_USD_PER_M, SpendRefused } from '../llm/spend-guard.ts'
import type { DetailedCompletion } from '../llm/provider.ts'

export const LAUNCH_POLICY_VERSION = '2026-10-30'
export const ROLLOUT_DAYS = 7           // strict caps for the first week of a calibrated launch
export const ROLLOUT_DAILY_CAP = 5      // sends per day during rollout, whatever the policy says
export const MIN_SAMPLE_DRAFTS = 3      // drafts the preflight validates before launch

export interface LaunchPolicy {
  version: string
  sender: string                        // the mailbox autopilot may send from
  audience: { playIds: string[] }       // only leads from these plays
  exclusions: { domains: string[]; emails: string[] }
  dailyCap: number
  spendCapUsd: number                   // model and enrichment spend ceiling for the launch
  claims: { mayStatePrice: boolean; benchmarkUrls: string[] }
  stops: { pauseOnAnyReply: boolean; maxBounceRate: number }
  testInbox: string                     // inbox for the integration check: exactly the authenticated sender (a shared domain proves nothing)
}

export type PolicyProblem =
  | 'version_not_current' | 'sender_missing' | 'audience_empty' | 'daily_cap_invalid' | 'spend_cap_invalid'
  | 'bounce_stop_invalid' | 'test_inbox_not_owned' | 'benchmark_not_https' | 'policy_too_large'
  | 'audience_too_many' | 'exclusions_too_many' | 'benchmarks_too_many'
// List limits: refused by name, never truncated. The store's size cap (MAX_POLICY_JSON, 8000 chars) binds first for long
// entries: about 350 short domains, fewer emails; both problems are reported when both apply. The count limits are the
// ceiling for the shortest entries, so a tenant is never told "too many" for a list the store would have held.
export const MAX_AUDIENCE_PLAYS = 50, MAX_EXCLUSIONS = 500, MAX_BENCHMARKS = 20
export const MAX_POLICY_JSON = 8000     // the store's CHECK on the policy column; refused by name before any write
export const MAX_LAUNCH_SPEND_USD = 500 // model and enrichment spend ceiling any one launch may set

const EMAIL = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/
const domainOf = (email: string) => EMAIL.exec(email.trim().toLowerCase())?.[1] ?? null

// The policy itself, before any check runs: complete, inside the product's hard limits, and testable without
// emailing anyone the tenant does not own.
export function policyProblems(p: LaunchPolicy): PolicyProblem[] {
  const out: PolicyProblem[] = []
  if (p.version !== LAUNCH_POLICY_VERSION) out.push('version_not_current')
  const senderDomain = domainOf(p.sender)
  if (!senderDomain) out.push('sender_missing')
  if (!p.audience.playIds.filter(s => s.trim()).length) out.push('audience_empty')
  if (!Number.isInteger(p.dailyCap) || p.dailyCap < 1 || p.dailyCap > MAX_DAILY) out.push('daily_cap_invalid')
  if (!(p.spendCapUsd > 0 && p.spendCapUsd <= MAX_LAUNCH_SPEND_USD)) out.push('spend_cap_invalid')
  if (!(p.stops.maxBounceRate > 0 && p.stops.maxBounceRate <= 0.1)) out.push('bounce_stop_invalid')
  // The only inbox the tenant has proved it owns is the authenticated sender itself: a shared domain (gmail.com, a
  // company domain with other people on it) is no proof of owning another mailbox, so no other address is accepted.
  const inbox = p.testInbox.trim().toLowerCase()
  if (!senderDomain || inbox !== p.sender.trim().toLowerCase()) out.push('test_inbox_not_owned')
  if (p.claims.benchmarkUrls.some(u => !/^https:\/\/\S+$/.test(u))) out.push('benchmark_not_https')
  // over-long lists are refused, never cut: a truncated exclusion list would send to the addresses that fell off it
  if (p.audience.playIds.length > MAX_AUDIENCE_PLAYS) out.push('audience_too_many')
  if (p.exclusions.domains.length > MAX_EXCLUSIONS || p.exclusions.emails.length > MAX_EXCLUSIONS) out.push('exclusions_too_many')
  if (p.claims.benchmarkUrls.length > MAX_BENCHMARKS) out.push('benchmarks_too_many')
  if (JSON.stringify(p).length > MAX_POLICY_JSON) out.push('policy_too_large')
  return out
}

export interface SampleDraft { leadId: string; to: string; body: string; evidenceOk: boolean; dateOk: boolean; contactOk: boolean; claimIssues: string[] }
export interface PreflightInput {
  policy: LaunchPolicy
  acceptedVersion: string | null        // the policy version the tenant explicitly accepted
  connectedMailbox: string | null       // the mailbox actually connected now
  testInboxDelivered: boolean           // the integration check reached the owned test inbox
  samples: SampleDraft[]
  stopsEnforced: { reply: boolean; optOut: boolean; bounce: boolean; uncertainPause: boolean; domainCap: boolean }
}

export type PreflightFailure = PolicyProblem | 'policy_not_accepted' | 'mailbox_mismatch' | 'test_inbox_failed' | 'too_few_samples' | 'autopilot_off' | 'consent_required'
  | 'sample_evidence' | 'sample_date' | 'sample_contact' | 'sample_claims' | 'sample_excluded' | 'sample_invalid' | 'stop_not_enforced' | 'policy_changed'

export const REQUIRED_STOPS = ['reply', 'optOut', 'bounce', 'uncertainPause', 'domainCap'] as const
const validSample = (s: SampleDraft) => !!s && typeof s === 'object' && typeof s.leadId === 'string' && s.leadId.trim() !== ''
  && typeof s.to === 'string' && !!domainOf(s.to) && typeof s.body === 'string' && s.body.trim() !== ''
  && typeof s.evidenceOk === 'boolean' && typeof s.dateOk === 'boolean' && typeof s.contactOk === 'boolean' && Array.isArray(s.claimIssues)

export interface PreflightResult { ok: boolean; failures: PreflightFailure[]; heldLeads: string[] }

// Any failure holds the launch; failing samples are named so they are held or skipped, never sent. A failed preflight
// leaves the policy accepted and not launched: autopilot stays paused (launch_not_calibrated) until a preflight passes
// or the tenant withdraws the policy (withdrawLaunchPolicy), which puts them back on the hand-approval warmup.
export function preflight(input: PreflightInput): PreflightResult {
  const { policy } = input
  const failures = new Set<PreflightFailure>(policyProblems(policy))
  if (input.acceptedVersion !== LAUNCH_POLICY_VERSION || policy.version !== LAUNCH_POLICY_VERSION) failures.add('policy_not_accepted')
  if (!input.connectedMailbox || input.connectedMailbox.trim().toLowerCase() !== policy.sender.trim().toLowerCase()) failures.add('mailbox_mismatch')
  if (!input.testInboxDelivered) failures.add('test_inbox_failed')
  // distinct leads only, each with every field present and typed: a repeated or malformed sample is not a sample
  const valid = input.samples.filter(validSample)
  if (valid.length !== input.samples.length) failures.add('sample_invalid')
  if (new Set(valid.map(s => s.leadId)).size < MIN_SAMPLE_DRAFTS) failures.add('too_few_samples')
  const excludedDomains = new Set(policy.exclusions.domains.map(d => d.trim().toLowerCase()))
  const excludedEmails = new Set(policy.exclusions.emails.map(e => e.trim().toLowerCase()))
  const held = new Set<string>()
  for (const s of input.samples) {
    if (!valid.includes(s)) { if (typeof s?.leadId === 'string' && s.leadId) held.add(s.leadId); continue }
    const to = s.to.trim().toLowerCase()
    const bad: PreflightFailure[] = []
    if (!s.evidenceOk) bad.push('sample_evidence')
    if (!s.dateOk) bad.push('sample_date')
    if (!s.contactOk) bad.push('sample_contact')
    if (s.claimIssues.length) bad.push('sample_claims')
    if (excludedEmails.has(to) || excludedDomains.has(domainOf(to) ?? '')) bad.push('sample_excluded')
    if (bad.length) { held.add(s.leadId); bad.forEach(b => failures.add(b)) }
  }
  // every required stop, by name, must be exactly true: a missing, extra-only or empty object fails closed
  const stops = (input.stopsEnforced ?? {}) as Record<string, unknown>
  if (!REQUIRED_STOPS.every(k => stops[k] === true)) failures.add('stop_not_enforced')
  return { ok: failures.size === 0, failures: [...failures], heldLeads: [...held] }
}

// The daily cap a calibrated launch may use: the stricter rollout cap for its first week, then the policy's own cap,
// never above the product ceiling. The caller still applies the tenant's autopilot daily cap on top.
export function calibratedDailyCap(policy: LaunchPolicy, launchedAtS: number, nowS: number): number {
  const cap = Math.min(policy.dailyCap, MAX_DAILY)
  return nowS - launchedAtS < ROLLOUT_DAYS * 86400 ? Math.min(cap, ROLLOUT_DAILY_CAP) : cap
}

// ---------- stored acceptance, calibration run, and the gate autopilot reads (#405) ----------
// One row per tenant: the policy they accepted, at which version and when, and when a calibration preflight passed for
// it. A new acceptance clears the launch, so changed authority always needs a new passing preflight. acceptance_id
// identifies one acceptance: a calibration started for it can only record its result against that same acceptance.
export function migrateLaunchPolicy(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS autopilot_launch_policy (
    tenant_id TEXT PRIMARY KEY,
    acceptance_id TEXT NOT NULL CHECK (length(acceptance_id) = 16),
    version TEXT NOT NULL CHECK (length(version) <= 20),
    policy TEXT NOT NULL CHECK (length(policy) <= 8000),
    accepted_at INTEGER NOT NULL,
    launched_at INTEGER,
    preflight TEXT CHECK (preflight IS NULL OR length(preflight) <= 4000)
  )`)
}

// Every real entry (a non-blank string, trimmed) up to one past the list's limit: the limits are policyProblems' to
// refuse (MAX_*), never this parser's to cut silently. Blanks and non-strings are dropped from the WHOLE array first, so
// a pasted list with blank lines keeps every real entry; only then is the list capped at max + 1, enough for the refusal
// to fire. The full pass over an oversize array is linear and bounded by the request body the route accepts. An
// accepted list is always complete.
const strs = (v: unknown, max: number) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean).slice(0, max + 1) : []
const num = (v: unknown) => typeof v === 'number' ? v : NaN // a number is a number: no coercion (true is not a cap of 1)
// A policy from untrusted input, with every field typed; anything missing becomes a problem policyProblems reports.
export function parsePolicy(v: unknown): LaunchPolicy {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    version: typeof o.version === 'string' ? o.version : '',
    sender: typeof o.sender === 'string' ? o.sender.trim().toLowerCase() : '',
    audience: { playIds: strs(o.audience?.playIds, MAX_AUDIENCE_PLAYS) },
    exclusions: { domains: strs(o.exclusions?.domains, MAX_EXCLUSIONS).map(d => d.toLowerCase()), emails: strs(o.exclusions?.emails, MAX_EXCLUSIONS).map(e => e.toLowerCase()) },
    dailyCap: num(o.dailyCap), spendCapUsd: num(o.spendCapUsd),
    claims: { mayStatePrice: o.claims?.mayStatePrice === true, benchmarkUrls: strs(o.claims?.benchmarkUrls, MAX_BENCHMARKS) },
    stops: { pauseOnAnyReply: o.stops?.pauseOnAnyReply !== false, maxBounceRate: num(o.stops?.maxBounceRate) },
    testInbox: typeof o.testInbox === 'string' ? o.testInbox.trim().toLowerCase() : '',
  }
}

export function acceptLaunchPolicy(db: Database.Database, tenantId: string, input: unknown, nowS: number): { ok: true } | { ok: false; problems: PolicyProblem[] } {
  const policy = parsePolicy(input)
  const problems = policyProblems(policy)
  if (problems.length) return { ok: false, problems }
  db.prepare(`INSERT INTO autopilot_launch_policy (tenant_id, acceptance_id, version, policy, accepted_at, launched_at, preflight) VALUES (?, ?, ?, ?, ?, NULL, NULL)
    ON CONFLICT (tenant_id) DO UPDATE SET acceptance_id = excluded.acceptance_id, version = excluded.version, policy = excluded.policy, accepted_at = excluded.accepted_at, launched_at = NULL, preflight = NULL`)
    .run(tenantId, randomBytes(8).toString('hex'), policy.version, JSON.stringify(policy), nowS)
  return { ok: true }
}

// The tenant withdraws the policy: the row goes, and with it the launch; they are back on the hand-approval warmup. The
// caller (autopilot.withdrawLaunch) lifts the launch_not_calibrated pause and audits it.
export function withdrawLaunchPolicy(db: Database.Database, tenantId: string): boolean {
  return db.prepare('DELETE FROM autopilot_launch_policy WHERE tenant_id = ?').run(tenantId).changes === 1
}
export interface StoredPolicy { acceptanceId: string; policy: LaunchPolicy; version: string; acceptedAt: number; launchedAt: number | null }
export function readLaunchPolicy(db: Database.Database, tenantId: string): StoredPolicy | null {
  const r = db.prepare('SELECT acceptance_id, version, policy, accepted_at, launched_at FROM autopilot_launch_policy WHERE tenant_id = ?').get(tenantId) as { acceptance_id: string; version: string; policy: string; accepted_at: number; launched_at: number | null } | undefined
  return r ? { acceptanceId: r.acceptance_id, policy: parsePolicy(JSON.parse(r.policy)), version: r.version, acceptedAt: r.accepted_at, launchedAt: r.launched_at } : null
}
// What the settings page shows: the accepted policy, or that the stored row cannot be read (it is not a launch either:
// launchGate throws on the same failure and autopilot stops). The page never fails because one row is corrupt.
export function launchPolicyView(db: Database.Database, tenantId: string): { accepted: StoredPolicy | null; problem?: 'policy_unreadable' } {
  try { return { accepted: readLaunchPolicy(db, tenantId) } } catch { return { accepted: null, problem: 'policy_unreadable' } }
}

// What the copy may claim under the policy: no price unless allowed; links only to https benchmarks it lists, the
// sender's own domain, or the lead's own evidence source (the page the email cites as why it is writing).
export function claimIssuesFor(policy: LaunchPolicy, body: string, evidenceUrls: string[] = []): string[] {
  const out: string[] = []
  if (!policy.claims.mayStatePrice && /(?:[$€£]\s?\d|\d\s?(?:usd|eur|gbp)\b|per month|\/mo\b)/i.test(body)) out.push('price_not_allowed')
  const own = domainOf(policy.sender)
  for (const u of body.match(/https?:\/\/[^\s)>"']+/gi) ?? []) {
    let host = ''
    try { host = new URL(u).hostname.toLowerCase() } catch { /* not a URL */ }
    const allowed = policy.claims.benchmarkUrls.includes(u) || evidenceUrls.includes(u) || (u.startsWith('https://') && !!own && (host === own || host.endsWith(`.${own}`)))
    if (!allowed) out.push('link_not_allowed')
  }
  return out
}

// Runs the preflight against the acceptance the calibration was started for (`accepted`, read when it started) and
// records the result only if that same acceptance is still the current one (compare-and-set on acceptance_id). Only a
// passing run launches. A stale run (the tenant accepted another policy meanwhile) neither launches nor touches the newer
// acceptance's state: it returns policy_changed. The caller supplies what the server observed for THAT policy.
export function recordPreflight(db: Database.Database, tenantId: string, accepted: StoredPolicy, observed: Omit<PreflightInput, 'policy' | 'acceptedVersion'>, nowS: number): PreflightResult {
  const r = preflight({ ...observed, policy: accepted.policy, acceptedVersion: accepted.version })
  const w = db.prepare('UPDATE autopilot_launch_policy SET preflight = ?, launched_at = CASE WHEN ? THEN COALESCE(launched_at, ?) ELSE NULL END WHERE tenant_id = ? AND acceptance_id = ?')
    .run(JSON.stringify({ at: nowS, ...r }).slice(0, 4000), r.ok ? 1 : 0, nowS, tenantId, accepted.acceptanceId)
  return w.changes === 1 ? r : { ok: false, failures: ['policy_changed'], heldLeads: [] }
}

// What autopilot reads before each send. Calibrated only while the accepted policy is the current version, still valid,
// launched by a passing preflight, and the connected mailbox is the policy's sender.
// accepted: a launch policy row exists for the tenant (accepted, stale, re-accepted, invalid) but is not a launch right now.
// Autopilot must then STOP, not run the warmup: past the warmup's first sends the warmup is unrestricted, and the tenant's
// last word was a policy. Only a tenant with no row at all is on the warmup.
export type LaunchGate = { calibrated: false; accepted: boolean } | { calibrated: true; policy: LaunchPolicy; cap: number; launchedAt: number; acceptanceId: string }
// Throws when the launch store cannot be read: the caller must treat that as a stop (autopilot: stop_check_unavailable),
// never as "no launch", which would send under the warmup's wider rules while the policy is unknown.
export function launchGate(db: Database.Database, tenantId: string, connectedMailbox: string | null, nowS: number): LaunchGate {
  const s = readLaunchPolicy(db, tenantId)
  if (!s) return { calibrated: false, accepted: false }
  if (s.launchedAt === null || s.version !== LAUNCH_POLICY_VERSION || policyProblems(s.policy).length) return { calibrated: false, accepted: true }
  if (!connectedMailbox || connectedMailbox.trim().toLowerCase() !== s.policy.sender) return { calibrated: false, accepted: true }
  return { calibrated: true, policy: s.policy, cap: calibratedDailyCap(s.policy, s.launchedAt, nowS), launchedAt: s.launchedAt, acceptanceId: s.acceptanceId }
}

// A send under a calibrated launch must be inside the policy: the lead's play is in the audience, the recipient is not
// excluded.
export function outsidePolicy(policy: LaunchPolicy, playId: string, to: string): 'not_in_audience' | 'excluded' | null {
  if (!policy.audience.playIds.includes(playId)) return 'not_in_audience'
  const e = to.trim().toLowerCase()
  if (policy.exclusions.emails.includes(e) || policy.exclusions.domains.includes(domainOf(e) ?? '')) return 'excluded'
  return null
}

// The policy's own stops, on top of autopilot's: any reply since launch (when the policy says so), or a bounce rate
// since launch above the policy's limit. A store that cannot be read stops the launch (fail closed). The reply sync
// (replies.ts) logs bounces and auto-replies in inbound_messages as well; those are not replies, so they are left to
// the bounce-rate rule and never pause the launch under the wrong name.
const NOT_A_REPLY = ['bounce', 'soft_bounce', 'auto'] as const
export function calibratedStop(db: Database.Database, tenantId: string, gate: Extract<LaunchGate, { calibrated: true }>): 'reply_received' | 'bounce_rate' | 'stop_check_unavailable' | null {
  try {
    if (gate.policy.stops.pauseOnAnyReply && db.prepare(`SELECT 1 FROM inbound_messages WHERE tenant_id = ? AND received_at >= ? AND classification NOT IN (${NOT_A_REPLY.map(() => '?').join(', ')}) LIMIT 1`).get(tenantId, gate.launchedAt, ...NOT_A_REPLY)) return 'reply_received'
    // bounces: every bounce recorded for this tenant since launch (recordBounce, from any thread, hand-sent included)
    // over autopilot's own sends since launch. Deliberately conservative: a mailbox bouncing anywhere is a reason to
    // stop a calibrated launch early, never a reason to keep going; the tenant resumes after looking.
    const n = (action: string) => (db.prepare('SELECT count(*) AS n FROM autopilot_audit WHERE tenant_id = ? AND action = ? AND created_at >= ?').get(tenantId, action, gate.launchedAt) as { n: number }).n
    const sent = n('sent'), bounced = n('bounce')
    if (bounced > 0 && bounced / Math.max(sent, 1) > gate.policy.stops.maxBounceRate) return 'bounce_rate'
    return null
  } catch { return 'stop_check_unavailable' }
}

// The launch's spend cap, enforced on every model call a calibrated launch makes. Before the call it reserves that call's
// worst case with the repo's own bound (callCostUsd: input bounded by the prompt's byte length plus a margin, output by
// the call's max_tokens, only models with a listed price; an unpriced model refuses). After the call it settles to the
// cost the provider reported, overrun above the estimate included; when no cost was reported the worst case stays
// reserved. Reservations live in the shared tenant_spend_pools table under the launch's own period ('l:<launchedAt>'),
// raised only WHERE they still fit under the cap, so concurrent runs cannot pass it together. A store that cannot record
// a reservation refuses the call (fail closed).
const launchPeriod = (launchedAt: number) => `l:${launchedAt}`.slice(0, 12)
export function reserveLaunchSpend(db: Database.Database, tenantId: string, launchedAt: number, capUsd: number, usd: number, nowS: number): 'ok' | 'over_cap' | 'unavailable' {
  if (!(Number.isFinite(capUsd) && capUsd > 0 && Number.isFinite(usd) && usd >= 0)) return 'unavailable'
  const period = launchPeriod(launchedAt)
  try {
    return db.transaction(() => {
      db.prepare('INSERT INTO tenant_spend_pools (tenant_id, period, reserved_usd, reported_usd, calls, updated_at) VALUES (?, ?, 0, 0, 0, ?) ON CONFLICT (tenant_id, period) DO NOTHING').run(tenantId, period, nowS)
      const r = db.prepare('UPDATE tenant_spend_pools SET reserved_usd = reserved_usd + ?, calls = calls + 1, updated_at = ? WHERE tenant_id = ? AND period = ? AND reserved_usd + ? <= ?')
        .run(usd, nowS, tenantId, period, usd, capUsd + 1e-9)
      return r.changes === 1 ? 'ok' as const : 'over_cap' as const
    }).immediate()
  } catch { return 'unavailable' }
}
// Moves a reservation to what the provider reported: down when it cost less, UP past the cap when it cost more (money
// already spent is recorded, and later reservations are then refused). True only when exactly the launch's row was
// updated; a store error, a missing row or a zero-row update is false, and the caller stops (fail closed).
export function settleLaunchSpend(db: Database.Database, tenantId: string, launchedAt: number, deltaUsd: number, reportedUsd: number, nowS: number): boolean {
  try {
    return db.prepare('UPDATE tenant_spend_pools SET reserved_usd = CASE WHEN reserved_usd + ? < 0 THEN 0 ELSE reserved_usd + ? END, reported_usd = reported_usd + ?, updated_at = ? WHERE tenant_id = ? AND period = ?')
      .run(deltaUsd, deltaUsd, reportedUsd, nowS, tenantId, launchPeriod(launchedAt)).changes === 1
  } catch { return false }
}

// What a completion cost, from the usage the provider reported, cache tokens counted as input (cache writes at 1.25x, the
// listed premium); null when it reported none or the model has no listed price (then the ceiling stays reserved).
export function reportedCostUsd(d: DetailedCompletion, configured: string | undefined): number | null {
  const p = PRICES_USD_PER_M[d.model ?? configured ?? '']
  const u = d.usage
  if (!p || !u || typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') return null
  const input = u.input_tokens + (u.cache_read_input_tokens ?? 0) + 1.25 * (u.cache_creation_input_tokens ?? 0)
  return (input * p.in + u.output_tokens * p.out) / 1e6
}

export type SpendStop = 'launch_spend_cap' | 'spend_check_unavailable' | 'model_unpriced'
// The providers a calibrated launch hands to drafting: every completion reserves its ceiling first and settles after.
// onRefuse records why a call was refused, so the run stops instead of carrying on.
export function launchProviders(base: Record<string, Provider>, db: Database.Database, tenantId: string, launchedAt: number, capUsd: number, nowS: number, onRefuse: (why: SpendStop) => void): Record<string, Provider> {
  const wrap = (p: Provider): Provider => {
    const model = () => { try { return p.configuredModel?.() } catch { return undefined } }
    const before = (prompt: string, max: number): number => {
      let ceiling: number
      try { ceiling = callCostUsd(model(), Buffer.byteLength(prompt), max) } catch { onRefuse('model_unpriced'); throw new SpendRefused('model_unpriced') }
      const r = reserveLaunchSpend(db, tenantId, launchedAt, capUsd, ceiling, nowS)
      if (r !== 'ok') { const why = r === 'over_cap' ? 'launch_spend_cap' : 'spend_check_unavailable'; onRefuse(why); throw new SpendRefused(why) }
      return ceiling
    }
    const out: Provider = { research: async () => { throw new SpendRefused('research_unbounded') }, ...(p.configuredModel ? { configuredModel: () => p.configuredModel!() } : {}) }
    if (p.complete) out.complete = async (k, prompt, f, max = 10) => { before(prompt, max); return p.complete!(k, prompt, f, max) } // no usage reported: the ceiling stays reserved
    if (p.completeDetailed) out.completeDetailed = async (k, prompt, f, max = 10) => {
      const ceiling = before(prompt, max)
      const d = await p.completeDetailed!(k, prompt, f, max)
      const actual = reportedCostUsd(d, model())
      // the reported cost must be recorded before anything else happens: if it cannot be (the actual cost may be above
      // the estimate), no further call or send is allowed
      if (actual !== null && !settleLaunchSpend(db, tenantId, launchedAt, actual - ceiling, actual, nowS)) { onRefuse('spend_check_unavailable'); throw new SpendRefused('settle_failed') }
      return d
    }
    return out
  }
  return Object.fromEntries(Object.entries(base).map(([k, p]) => [k, wrap(p)]))
}
