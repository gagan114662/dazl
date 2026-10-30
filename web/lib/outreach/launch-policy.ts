// Calibrated launch (#405): an alternative to approving the first WARMUP_SENDS emails by hand. The tenant writes one
// explicit launch policy - who sends, to whom, what is excluded, how much, what the copy may claim, when to stop - and
// the machine runs a preflight against it. Only a policy the tenant accepted at the current version, with every check
// passing, replaces the hand-approval warmup; the warmup stays the default and nothing here changes existing consent.
// Every other autopilot guard (reply, opt-out and bounce stops, uncertain-send pause, daily and per-domain caps,
// suppression) still applies on top, and the first days of a calibrated launch run under a stricter rollout cap.
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
