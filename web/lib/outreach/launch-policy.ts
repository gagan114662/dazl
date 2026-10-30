// Calibrated launch (#405): an alternative to approving the first WARMUP_SENDS emails by hand. The tenant writes one
// explicit launch policy - who sends, to whom, what is excluded, how much, what the copy may claim, when to stop - and
// the machine runs a preflight against it. Only a policy the tenant accepted at the current version, with every check
// passing, replaces the hand-approval warmup; the warmup stays the default and nothing here changes existing consent.
// Every other autopilot guard (reply, opt-out and bounce stops, uncertain-send pause, daily and per-domain caps,
// suppression) still applies on top, and the first days of a calibrated launch run under a stricter rollout cap.
import type Database from 'better-sqlite3'
import { MAX_DAILY } from './autopilot.ts'

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
  testInbox: string                     // owned inbox for the integration check: the sender itself or its own domain
}

export type PolicyProblem =
  | 'version_not_current' | 'sender_missing' | 'audience_empty' | 'daily_cap_invalid' | 'spend_cap_invalid'
  | 'bounce_stop_invalid' | 'test_inbox_not_owned' | 'benchmark_not_https'

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
  if (!(p.spendCapUsd > 0)) out.push('spend_cap_invalid')
  if (!(p.stops.maxBounceRate > 0 && p.stops.maxBounceRate <= 0.1)) out.push('bounce_stop_invalid')
  const inbox = p.testInbox.trim().toLowerCase()
  if (!senderDomain || !(inbox === p.sender.trim().toLowerCase() || domainOf(inbox) === senderDomain)) out.push('test_inbox_not_owned')
  if (p.claims.benchmarkUrls.some(u => !/^https:\/\/\S+$/.test(u))) out.push('benchmark_not_https')
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

export type PreflightFailure = PolicyProblem | 'policy_not_accepted' | 'mailbox_mismatch' | 'test_inbox_failed' | 'too_few_samples'
  | 'sample_evidence' | 'sample_date' | 'sample_contact' | 'sample_claims' | 'sample_excluded' | 'stop_not_enforced'

export interface PreflightResult { ok: boolean; failures: PreflightFailure[]; heldLeads: string[] }

// Any failure holds the launch; failing samples are named so they are held or skipped, never sent. A failed preflight
// leaves the tenant on the hand-approval warmup.
export function preflight(input: PreflightInput): PreflightResult {
  const { policy } = input
  const failures = new Set<PreflightFailure>(policyProblems(policy))
  if (input.acceptedVersion !== LAUNCH_POLICY_VERSION || policy.version !== LAUNCH_POLICY_VERSION) failures.add('policy_not_accepted')
  if (!input.connectedMailbox || input.connectedMailbox.trim().toLowerCase() !== policy.sender.trim().toLowerCase()) failures.add('mailbox_mismatch')
  if (!input.testInboxDelivered) failures.add('test_inbox_failed')
  if (input.samples.length < MIN_SAMPLE_DRAFTS) failures.add('too_few_samples')
  const excludedDomains = new Set(policy.exclusions.domains.map(d => d.trim().toLowerCase()))
  const excludedEmails = new Set(policy.exclusions.emails.map(e => e.trim().toLowerCase()))
  const held = new Set<string>()
  for (const s of input.samples) {
    const to = s.to.trim().toLowerCase()
    const bad: PreflightFailure[] = []
    if (!s.evidenceOk) bad.push('sample_evidence')
    if (!s.dateOk) bad.push('sample_date')
    if (!s.contactOk) bad.push('sample_contact')
    if (s.claimIssues.length) bad.push('sample_claims')
    if (excludedEmails.has(to) || excludedDomains.has(domainOf(to) ?? '')) bad.push('sample_excluded')
    if (bad.length) { held.add(s.leadId); bad.forEach(b => failures.add(b)) }
  }
  if (!Object.values(input.stopsEnforced).every(Boolean)) failures.add('stop_not_enforced')
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
// it. A new acceptance clears the launch, so changed authority always needs a new passing preflight.
export function migrateLaunchPolicy(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS autopilot_launch_policy (
    tenant_id TEXT PRIMARY KEY,
    version TEXT NOT NULL CHECK (length(version) <= 20),
    policy TEXT NOT NULL CHECK (length(policy) <= 8000),
    accepted_at INTEGER NOT NULL,
    launched_at INTEGER,
    preflight TEXT CHECK (preflight IS NULL OR length(preflight) <= 4000)
  )`)
}

const strs = (v: unknown, max: number) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean).slice(0, max) : []
// A policy from untrusted input, with every field typed; anything missing becomes a problem policyProblems reports.
export function parsePolicy(v: unknown): LaunchPolicy {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    version: typeof o.version === 'string' ? o.version : '',
    sender: typeof o.sender === 'string' ? o.sender.trim().toLowerCase() : '',
    audience: { playIds: strs(o.audience?.playIds, 50) },
    exclusions: { domains: strs(o.exclusions?.domains, 500).map(d => d.toLowerCase()), emails: strs(o.exclusions?.emails, 500).map(e => e.toLowerCase()) },
    dailyCap: Number(o.dailyCap), spendCapUsd: Number(o.spendCapUsd),
    claims: { mayStatePrice: o.claims?.mayStatePrice === true, benchmarkUrls: strs(o.claims?.benchmarkUrls, 20) },
    stops: { pauseOnAnyReply: o.stops?.pauseOnAnyReply !== false, maxBounceRate: Number(o.stops?.maxBounceRate) },
    testInbox: typeof o.testInbox === 'string' ? o.testInbox.trim().toLowerCase() : '',
  }
}

export function acceptLaunchPolicy(db: Database.Database, tenantId: string, input: unknown, nowS: number): { ok: true } | { ok: false; problems: PolicyProblem[] } {
  const policy = parsePolicy(input)
  const problems = policyProblems(policy)
  if (problems.length) return { ok: false, problems }
  db.prepare(`INSERT INTO autopilot_launch_policy (tenant_id, version, policy, accepted_at, launched_at, preflight) VALUES (?, ?, ?, ?, NULL, NULL)
    ON CONFLICT (tenant_id) DO UPDATE SET version = excluded.version, policy = excluded.policy, accepted_at = excluded.accepted_at, launched_at = NULL, preflight = NULL`)
    .run(tenantId, policy.version, JSON.stringify(policy), nowS)
  return { ok: true }
}

export interface StoredPolicy { policy: LaunchPolicy; version: string; acceptedAt: number; launchedAt: number | null }
export function readLaunchPolicy(db: Database.Database, tenantId: string): StoredPolicy | null {
  const r = db.prepare('SELECT version, policy, accepted_at, launched_at FROM autopilot_launch_policy WHERE tenant_id = ?').get(tenantId) as { version: string; policy: string; accepted_at: number; launched_at: number | null } | undefined
  return r ? { policy: parsePolicy(JSON.parse(r.policy)), version: r.version, acceptedAt: r.accepted_at, launchedAt: r.launched_at } : null
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

// Runs the preflight against the stored, accepted policy and records the result; only a passing run launches. The caller
// supplies what the server observed (the connected mailbox, whether the owned test inbox got the integration message,
// the sample drafts and the stops the autopilot enforces).
export function recordPreflight(db: Database.Database, tenantId: string, observed: Omit<PreflightInput, 'policy' | 'acceptedVersion'>, nowS: number): PreflightResult {
  const s = readLaunchPolicy(db, tenantId)
  if (!s) return { ok: false, failures: ['policy_not_accepted'], heldLeads: [] }
  const r = preflight({ ...observed, policy: s.policy, acceptedVersion: s.version })
  db.prepare('UPDATE autopilot_launch_policy SET preflight = ?, launched_at = CASE WHEN ? THEN COALESCE(launched_at, ?) ELSE NULL END WHERE tenant_id = ?')
    .run(JSON.stringify({ at: nowS, ...r }).slice(0, 4000), r.ok ? 1 : 0, nowS, tenantId)
  return r
}

// What autopilot reads before each send. Calibrated only while the accepted policy is the current version, still valid,
// launched by a passing preflight, and the connected mailbox is the policy's sender; otherwise the hand-approval warmup
// applies exactly as before.
export type LaunchGate = { calibrated: false } | { calibrated: true; policy: LaunchPolicy; cap: number; launchedAt: number }
export function launchGate(db: Database.Database, tenantId: string, connectedMailbox: string | null, nowS: number): LaunchGate {
  let s: StoredPolicy | null = null
  try { s = readLaunchPolicy(db, tenantId) } catch { return { calibrated: false } }
  if (!s || s.launchedAt === null || s.version !== LAUNCH_POLICY_VERSION || policyProblems(s.policy).length) return { calibrated: false }
  if (!connectedMailbox || connectedMailbox.trim().toLowerCase() !== s.policy.sender) return { calibrated: false }
  return { calibrated: true, policy: s.policy, cap: calibratedDailyCap(s.policy, s.launchedAt, nowS), launchedAt: s.launchedAt }
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
// since launch above the policy's limit. A store that cannot be read stops the launch (fail closed).
export function calibratedStop(db: Database.Database, tenantId: string, gate: Extract<LaunchGate, { calibrated: true }>): 'reply_received' | 'bounce_rate' | 'stop_check_unavailable' | null {
  try {
    if (gate.policy.stops.pauseOnAnyReply && db.prepare('SELECT 1 FROM inbound_messages WHERE tenant_id = ? AND received_at >= ? LIMIT 1').get(tenantId, gate.launchedAt)) return 'reply_received'
    const n = (action: string) => (db.prepare('SELECT count(*) AS n FROM autopilot_audit WHERE tenant_id = ? AND action = ? AND created_at >= ?').get(tenantId, action, gate.launchedAt) as { n: number }).n
    const sent = n('sent'), bounced = n('bounce')
    if (bounced > 0 && bounced / Math.max(sent, 1) > gate.policy.stops.maxBounceRate) return 'bounce_rate'
    return null
  } catch { return 'stop_check_unavailable' }
}
