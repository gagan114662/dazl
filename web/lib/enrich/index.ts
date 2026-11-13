// BYOK contact/firmographic enrichment in the scan waterfall. Runs only with the tenant's own keys
// (Settings > Enrichment). Each configured provider is loaded independently and tried in order (Apollo, then PDL):
// the next provider is tried when the previous one finds nothing usable (empty, rejected as a different company,
// rate-limited, timed out, upstream error or a bad key). Per-pass circuit breaker per provider, per-tenant call budget
// (an exhausted budget is a visible audit row, never a silent skip), no repeat charge for a lookup this job already made.
// Every call is audit-rowed; a failure never ends the whole pass (a bonus, never the bar). The summary records each
// provider's outcome per lead in waterfall order, and failures/skips reach the scan view (lib/scan/provider-issues.ts).
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { addEnrichment, audit, auditReleaseUnsent, auditSettleClaim, auditTryReserve, enrichFallbackEnabled, getEnabledCredential, latestAuditStatus, readOutcome, releaseHeldClaim } from '../connectors/store.ts'
import { apolloOrgEnrich, apolloPeopleSearch, EnrichError } from './apollo.ts'
import { pdlPeopleSearch } from './pdl.ts'
import { refundCredits, reserveCredits, settleCredits, CreditRefused, refusalLookup, type CreditHold, type CreditRefusal } from './credit-pool.ts'
import { runWithJobSpend } from '../scan/spend-cap.ts'
import { SpendRefused } from '../llm/spend-guard.ts'
import { getMasterKey } from '../secrets.ts'
import { domainRelationship } from '../signals/domain-basis.ts'
import { contactAgreement, organizationContradicts, recordContactRejection } from '../scan/contact-agreement.ts'
import { roleContradicted } from '../people/rank.ts'
import { providerContactLabel } from '../people/currency.ts'
import { siteKey, RECALL_LIMIT } from '../scan/intelligence.ts'
import { SPEND_REFUSAL_PREFIX } from '../scan/provider-issue-text.ts'
import { norm } from '../scan/evidence.ts'
import { selectOffer, rebindOfferId } from '../scan/offer-identity.ts'

export const ENRICH_APOLLO = 'enrich:apollo'
export const ENRICH_PDL = 'enrich:pdl'
const MAX_LEADS = 5 // credit discipline: at most 5 org enrich calls (1 credit each) per scan
const MAX_CONTACTS = 5 // people search is 0-credit on Apollo; PDL charges per profile

export interface LeadRow { id: string; company: string; company_domain: string | null; score?: number | null }

// The one domain normalizer for the org REQUEST and every claim key built from a domain: the domain sent to the
// provider and the domain inside the claim key are the same string, so a claim always names the call it paid for.
export const normDomain = (d: string | null | undefined): string | null => {
  const s = (d ?? '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '')
  return s || null
}
// Durable replay identity: tenant + job + provider + the company's DOMAIN when known, else the lead's own id.
// A bare company name is not an identity: two same-name leads with no domain must never share one memo (one
// would silence the other), and a replayed job must never pay for the same lead's lookup twice.
// LEGACY format ('people X (domain)'): the pre-recovery whole-attempt claim. Read-only now - a legacy terminal
// outcome still replays free and a legacy held claim stays held; fresh attempts never write it again.
const rawLookup = (kind: 'org' | 'people', lead: LeadRow) => `${kind} ${lead.company} (${lead.company_domain ? lead.company_domain : `lead:${lead.id}`})`
const lookupKey = (kind: 'org' | 'people', lead: LeadRow) => boundKey(rawLookup(kind, lead))
// STEP format ('step:org/people ...'): per-step claims. The step: prefix can never collide with a legacy key.
const rawStep = (kind: 'org' | 'people', lead: LeadRow) => `step:${kind} ${lead.company} (${normDomain(lead.company_domain) ?? `lead:${lead.id}`})`
const stepKey = (kind: 'org' | 'people', lead: LeadRow) => boundKey(rawStep(kind, lead))
export const claimKeysFor = (lead: LeadRow): { legacyPeople: string; stepOrg: string; stepPeople: string } =>
  ({ legacyPeople: lookupKey('people', lead), stepOrg: stepKey('org', lead), stepPeople: stepKey('people', lead) })

// #922: the readable key is an audit LABEL; identity is the whole string. Keys that fit (<= 200) are unchanged, so
// every existing valid claim keeps replaying. A longer key used to be cut at 200 chars, which could cut away the
// domain/lead id and make two different companies share one claim. Now it keeps a readable prefix and ends with a
// hash of the FULL identity ('#h:' + 32 hex); a fitting key always ends with ')', so the two forms never meet.
const KEY_MAX = 200
function boundKey(raw: string): string {
  if (raw.length <= KEY_MAX) return raw
  const h = createHash('sha256').update(raw).digest('hex').slice(0, 32)
  return `${raw.slice(0, KEY_MAX - 35)}#h:${h}`
}
// The pre-#922 truncated key for a long identity (null when the identity always fit and nothing changed).
const truncatedKey = (raw: string): string | null => raw.length > KEY_MAX ? raw.slice(0, KEY_MAX) : null
export const legacyTruncatedKeysFor = (lead: LeadRow): { legacyPeople: string | null; stepOrg: string | null; stepPeople: string | null } =>
  ({ legacyPeople: truncatedKey(rawLookup('people', lead)), stepOrg: truncatedKey(rawStep('org', lead)), stepPeople: truncatedKey(rawStep('people', lead)) })

// Read a claim under its current key; when none exists and the identity is long, honor a pre-#922 truncated row
// READ-ONLY. If only this lead's identity in the job maps to that truncated key, the row is its own (replay /
// held exactly as before). If two distinct identities share it, the row cannot be attributed: fail closed as
// uncertain - never replay it as ours, never release it, never pay on an assumed identity.
function readClaimCompat(db: Database.Database, a: { tenantId: string; connector: string; jobId: string; lookup: string }, lead: LeadRow, raw: (l: LeadRow) => string, opts: { legacyAudit?: boolean } = {}): ReturnType<typeof readOutcome> {
  const cur = readOutcome(db, a, opts)
  if (cur) return cur
  const full = raw(lead), trunc = truncatedKey(full)
  if (!trunc) return null
  const old = readOutcome(db, { ...a, lookup: trunc }, opts)
  if (!old) return null
  const jobLeads = db.prepare('SELECT id, company, company_domain FROM leads WHERE scan_job_id = ?').all(a.jobId) as LeadRow[]
  return unambiguousTruncatedIdentity(jobLeads, full, raw) ? old : { prior: 'uncertain', status: old.status, memo: null }
}

// A truncated label is attributable only when every matching lead has the same full identity.
// Use this same decision for replay and owner recovery; recovery must not delete another identity's hold.
function unambiguousTruncatedIdentity(leads: LeadRow[], full: string, raw: (l: LeadRow) => string): boolean {
  const trunc = truncatedKey(full)
  if (!trunc) return true
  const sharers = new Set(leads.map(raw).filter(r => truncatedKey(r) === trunc))
  sharers.add(full)
  return sharers.size === 1
}

// The scan's geography (ICP "where"): what a candidate record must agree with when the company's domain does not settle it.
function scanWhere(db: Database.Database, jobId: string): string[] {
  const r = db.prepare('SELECT icp FROM scan_jobs WHERE id = ?').get(jobId) as { icp: string | null } | undefined
  const w = r?.icp ? (JSON.parse(r.icp) as { where?: unknown }).where : null
  return Array.isArray(w) ? w.filter((x): x is string => typeof x === 'string') : []
}
const domainOf = (u: string | null | undefined) => /^[a-z]+:\/\/([^/?#]+)/i.exec(u ?? '')?.[1]?.replace(/^www\./, '') || null

export const MAX_FAILS = 3          // transient failures that open a provider's circuit for the rest of the pass
export const APOLLO_CALLS = MAX_LEADS * 2   // org + people lookups per scan
export const PDL_CALLS = MAX_LEADS          // PDL PROFILES per scan: PDL charges 1 credit per profile RETURNED (adapter contract), so the budget caps profiles and each search's size is capped by what remains - the scan can never be charged for more than this many PDL profiles
type Prov = 'apollo' | 'pdl'
// 'key_rejected': the provider rejected its saved key once (auth), so it is not used for the rest of the pass (#382: never
// called "repeated failures"). 'spend_refused': the scan's own spend gate (lib/scan/spend-cap.ts) refused the lookup BEFORE
// any request was sent, so the provider was NOT tried (never recorded as a provider failure); its reason is on the audit row.
type SkipWhy = 'circuit_open' | 'key_rejected' | 'spend_refused' | 'budget_exhausted' | 'credit_cap' | 'credit_unsaved' | 'replayed' | 'uncertain' | 'not_configured' | 'unresolved' | 'fallback_off'
// A provider failure code: the EnrichError code, 'timeout' for an aborted/timed-out request (the adapters' 15s
// abort), else 'error'. Non-terminal like the others: a timed-out lookup may have been billed, so its claim holds.
export type FailCode = 'auth' | 'rate_limited' | 'upstream' | 'timeout' | 'error'
export function failCode(e: unknown): FailCode {
  if (e instanceof EnrichError) return e.code
  const name = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : null
  return name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'error'
}
// Per-lead, per-provider outcome in waterfall order (#382): what each provider did for each lead this pass -
// attached a verified contact, came back empty, every candidate rejected, failed (by code), or was skipped (why).
export interface ProviderOutcome { leadId: string; provider: Prov; outcome: 'attached' | 'empty' | 'rejected' | FailCode | SkipWhy; attached: number }
export interface EnrichSummary { attached: number; byProvider: Record<Prov, number>; skipped: { provider: Prov; why: SkipWhy }[]; outcomes: ProviderOutcome[] }

export async function enrichLeadContacts(
  db: Database.Database,
  tenantId: string,
  jobId: string,
  leads: LeadRow[],
  deps: { fetchImpl?: typeof fetch; master?: Buffer; budget?: Partial<Record<Prov, number>>; only?: Prov; env?: Record<string, string | undefined>; keepUnsentHeld?: boolean } = {},
): Promise<EnrichSummary> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const summary: EnrichSummary = { attached: 0, byProvider: { apollo: 0, pdl: 0 }, skipped: [], outcomes: [] }
  const connector: Record<Prov, string> = { apollo: ENRICH_APOLLO, pdl: ENRICH_PDL }
  // Setup failures are NEVER silent (the old blanket catch made master/decrypt/DB failures vanish with zero
  // record): refuse explicitly - an audit row when the database allows it, a sanitized log line always.
  const setupFailed = (e: unknown): EnrichSummary => {
    const why = `setup failed: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}`
    try { audit(db, { tenantId, connector: 'enrich', jobId, lookup: 'pass setup', status: why, results: 0 }) }
    catch (ae) { console.error('[enrich] setup audit unavailable:', ae instanceof Error ? ae.message.slice(0, 120) : 'error') }
    console.error('[enrich]', why)
    return summary
  }
  let master: Buffer
  try { master = deps.master ?? getMasterKey() } catch (e) { return setupFailed(e) }
  // Independent per-provider loads: one provider's unreadable key refuses THAT provider (audited), never the other.
  // PDL runs when it is the only saved provider, or as the fallback ONLY with the tenant's explicit opt-in
  // (#382): a PDL key saved under the original wording ("used only when no Apollo key is saved") is not consent
  // to paid fallback credits. Off by default - without it, a tenant with both keys gets exactly the old
  // Apollo-only behavior the settings page describes.
  const loadKey = (prov: Prov): string | null => {
    try { return getEnabledCredential(db, tenantId, connector[prov], master) }
    catch {
      try { audit(db, { tenantId, connector: connector[prov], jobId, lookup: 'key load', status: `setup unreadable: ${prov} key could not be read`, results: 0 }) } catch { /* db down: the log line still carries it */ }
      console.error(`[enrich] setup unreadable: ${prov} key could not be read`)
      return null
    }
  }
  const keys: Record<Prov, string | null> = { apollo: loadKey('apollo'), pdl: loadKey('pdl') }
  let where: string[]
  // A saved PDL key the fallback opt-in does not cover: never called, but a lead Apollo leaves without a contact
  // records a visible 'fallback_off' notice instead of a silent zero result.
  let fallbackOff = false
  try {
    if (keys.apollo && !enrichFallbackEnabled(db, tenantId)) { fallbackOff = !!keys.pdl; keys.pdl = null }
    if (!keys.apollo && !keys.pdl) return summary
    where = scanWhere(db, jobId) // an agreement basis: unreadable = the pass refuses rather than agrees on a guess
  } catch (e) { return setupFailed(e) }
  const now = Math.floor(Date.now() / 1000)
  const today = new Date().toISOString().slice(0, 10)
  const budget: Record<Prov, number> = { apollo: deps.budget?.apollo ?? APOLLO_CALLS, pdl: deps.budget?.pdl ?? PDL_CALLS }
  const used: Record<Prov, number> = { apollo: 0, pdl: 0 }, fails: Record<Prov, number> = { apollo: 0, pdl: 0 }, open: Record<Prov, 'key_rejected' | 'circuit_open' | null> = { apollo: null, pdl: null }
  const told = new Set<string>()
  // The workspace credit pool refused this provider (its day/month cap, or the store could not save the reservation):
  // no later lead of the pass reserves for it again.
  const capped: Record<Prov, 'credit_cap' | 'credit_unsaved' | null> = { apollo: null, pdl: null }
  // The spend gate's refusal reason per provider (#382): once refused, no later lead of the pass asks again.
  const spendRefused: Record<Prov, string | null> = { apollo: null, pdl: null }
  const skip = (prov: Prov, why: SkipWhy, lead: LeadRow, refusal?: CreditRefusal) => {
    summary.skipped.push({ provider: prov, why })
    summary.outcomes.push({ leadId: lead.id, provider: prov, outcome: why, attached: 0 })
    // visible once per provider and reason per pass; a spend refusal's audit row carries its reason (lib/scan/provider-issues.ts reads it)
    const lookup = refusal ? refusalLookup(refusal) : why === 'spend_refused' ? spendRefusalLookup(spendRefused[prov] ?? 'unknown') : `people ${lead.company}`.slice(0, 200)
    const k = `${prov}:${why}`; if (!told.has(k) && why !== 'replayed') { told.add(k); audit(db, { tenantId, connector: connector[prov], jobId, lookup, status: why, results: 0 }) }
  }
  const failed = (prov: Prov, e: unknown, lead: LeadRow) => {
    // Refused by the scan's spend gate before any request: the provider was not tried, so it is neither a failure nor a
    // circuit count. The reason latches for the pass (the same gate would refuse every later lead's lookup the same way).
    if (e instanceof SpendRefused) { spendRefused[prov] = e.reason; skip(prov, 'spend_refused', lead); return }
    const code = failCode(e)
    summary.outcomes.push({ leadId: lead.id, provider: prov, outcome: code, attached: 0 })
    if (code === 'auth') open[prov] = 'key_rejected'              // a bad key stops THAT provider for the pass, not the pass
    else if (++fails[prov] >= MAX_FAILS) open[prov] = 'circuit_open' // repeated transient failures open the circuit
  }

  // Bounded enrichment goes to the highest-priority opportunities first (#383): the credit budget caps
  // how many leads get an org call, so the scan's own score order decides who is inside the cap. Stable
  // for equal/missing scores, so an unscored run keeps its previous order.
  const byPriority = [...leads].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const buyerTitles = reviewedBuyerTitles(db, jobId)
  for (const lead of byPriority.slice(0, MAX_LEADS)) {
    // the lead's OWN evidence (its quote and signal): a street address in it is an agreement basis for the record found by name
    // Setup reads gate paid calls: if the lead's own evidence or its domain relationship cannot be read, the
    // agreement basis is UNKNOWN - refuse the lead explicitly (audited once per pass), never enrich on a guess.
    let evidence: string, established: boolean
    try {
      const r = db.prepare('SELECT evidence_excerpt, signal FROM leads WHERE id = ?').get(lead.id) as { evidence_excerpt: string | null; signal: string | null } | undefined
      evidence = `${r?.evidence_excerpt ?? ''} ${r?.signal ?? ''}`
      established = domainRelationship(db, tenantId, lead.id, lead.company_domain) === 'established'
    } catch (e) {
      const why = `setup unreadable: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}`
      audit(db, { tenantId, connector: keys.apollo ? ENRICH_APOLLO : ENRICH_PDL, jobId, lookup: lookupKey('people', lead), status: why, results: 0 })
      summary.skipped.push({ provider: keys.apollo ? 'apollo' : 'pdl', why: 'unresolved' })
      summary.outcomes.push({ leadId: lead.id, provider: keys.apollo ? 'apollo' : 'pdl', outcome: 'unresolved', attached: 0 })
      continue
    }
    const src = lead.company_domain ? `https://${lead.company_domain}` : `https://www.linkedin.com/company/${encodeURIComponent(lead.company.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}`
    const ctx: Ctx = { db, tenantId, jobId, lead, where, evidence, established, src, today, now, fetchImpl, buyerTitles, env: deps.env, keepUnsentHeld: deps.keepUnsentHeld === true }
    let stopped = false // a verified/replayed result or a held (uncertain) claim ended this lead's waterfall on purpose
    for (const prov of ['apollo', 'pdl'] as Prov[]) {
      if (deps.only && prov !== deps.only) continue // an owner retry runs exactly the provider whose cost they saw
      if (!keys[prov]) continue
      const opened = open[prov]; if (opened) { skip(prov, opened, lead); continue }
      if (spendRefused[prov]) { skip(prov, 'spend_refused', lead); continue }
      const cap = capped[prov]; if (cap) { skip(prov, cap, lead); continue }
      if (used[prov] >= budget[prov]) { skip(prov, 'budget_exhausted', lead); continue }
      if (prov === 'pdl') {
        // PDL stays ONE whole-attempt claim (its search is itself the paid step): held = owner resolution only.
        // ATOMIC durable reservation (#382): one guarded insert claims this lookup for the job BEFORE any paid
        // call; a replayed or double-run job loses the race and reads the winner's outcome instead of paying again.
        // The workspace credit pool first (#363): a PDL search can charge up to its size, so that many credits are
        // reserved before the claim and the call; refused = no call.
        const size = Math.max(1, Math.min(MAX_CONTACTS, budget.pdl - used.pdl))
        // A lookup this job already has an outcome for is a replay: recognize it BEFORE reserving, so a full pool never
        // turns a known replay into a credit_cap refusal (and never latches capped.pdl for the rest of the scan).
        const known = readClaimCompat(db, { tenantId, connector: connector[prov], jobId, lookup: lookupKey('people', lead) }, lead, l => rawLookup('people', l))
        if (known) {
          if (known.prior === 'ok') { skip(prov, 'replayed', lead); stopped = true; break }
          if (known.prior === 'empty' || known.prior === 'rejected') { skip(prov, 'replayed', lead); continue }
          skip(prov, 'uncertain', lead); stopped = true; break
        }
        let hold: CreditHold
        try { hold = await reserveCredits(db, tenantId, 'pdl', size, { env: deps.env, now }) }
        catch (e) { const why = creditWhy(e); capped.pdl = why; skip(prov, why, lead, e instanceof CreditRefused ? e.detail : undefined); continue }
        const gate = auditTryReserve(db, { tenantId, connector: connector[prov], jobId, lookup: lookupKey('people', lead), status: 'reserved', results: 0 })
        if ('prior' in gate) {
          await releaseUnused(db, hold) // another pass holds this lookup: no call here, the credits go back
          if (gate.prior === 'ok') { skip(prov, 'replayed', lead); stopped = true; break } // already found for this lead in this job
          if (gate.prior === 'empty' || gate.prior === 'rejected') { skip(prov, 'replayed', lead); continue } // known empty/terminally rejected: do not pay again, try the next provider
          skip(prov, 'uncertain', lead); stopped = true; break                       // a crashed pass may have paid: fail closed, never pay twice
        }
        let res: { n: number; verdict: 'attached' | 'empty' | 'rejected' }
        try { const charged = { n: 0 }; res = await runPdl(ctx, gate.id, keys.pdl!, size, charged, hold); used.pdl += charged.n }
        catch (e) { failed(prov, e, lead); continue }
        summary.byProvider[prov] += res.n; summary.attached += res.n
        summary.outcomes.push({ leadId: lead.id, provider: prov, outcome: res.verdict, attached: res.n })
        if (res.n > 0) { stopped = true; break } // a verified candidate: the next provider is not needed (and is not charged)
        continue
      }
      // Apollo: honor a legacy whole-attempt outcome READ-ONLY (a legacy terminal replays free; a legacy HELD
      // claim stays held - the old row cannot prove whether its org call was charged, so resolution is the
      // owner's explicit, disclosure-audited retry). A fresh attempt never writes the legacy key again; it runs
      // per-step claims: the org claim (paid, settles with a memo) and the people claim (0-credit endpoint).
      const legacy = readClaimCompat(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: lookupKey('people', lead) }, lead, l => rawLookup('people', l))
      if (legacy) {
        if (legacy.prior === 'ok') { skip(prov, 'replayed', lead); stopped = true; break }
        if (legacy.prior === 'empty' || legacy.prior === 'rejected') { skip(prov, 'replayed', lead); continue }
        skip(prov, 'uncertain', lead); stopped = true; break
      }
      let out: AttemptOutcome
      try { out = await runApollo(ctx, keys.apollo!, { used, budget }) }
      catch (e) { failed(prov, e, lead); continue }
      if (out.kind === 'replayed-ok') { skip(prov, 'replayed', lead); stopped = true; break }
      if (out.kind === 'replayed-terminal') { skip(prov, 'replayed', lead); continue }
      if (out.kind === 'uncertain') { skip(prov, 'uncertain', lead); stopped = true; break }
      if (out.kind === 'budget') { skip(prov, 'budget_exhausted', lead); continue }
      if (out.kind === 'credit') { capped.apollo = out.why; skip(prov, out.why, lead, out.refusal); continue }
      summary.byProvider.apollo += out.n; summary.attached += out.n
      summary.outcomes.push({ leadId: lead.id, provider: prov, outcome: out.verdict, attached: out.n })
      if (out.n > 0) { stopped = true; break }
    }
    // Apollo left this lead without a contact and a saved PDL key sits outside the opt-in: say so (audited once
    // per pass), never a silent zero. No PDL call is made. An owner retry scoped to one provider is not a waterfall.
    if (fallbackOff && !stopped && !deps.only) skip('pdl', 'fallback_off', lead)
  }
  return summary
}

// #382: the spend-gate refusal's audit lookup (the reason, readable by lib/scan/provider-issues.ts) and the released claim's
// audit status. Neither is a provider failure status, so neither is counted as one.
const spendRefusalLookup = (reason: string) => `${SPEND_REFUSAL_PREFIX}${reason.replace(/[^a-z_0-9]/g, '').slice(0, 60) || 'unknown'}`
const unsentStatus = (e: SpendRefused) => `not sent: ${spendRefusalLookup(e.reason)}`

interface Ctx { db: Database.Database; tenantId: string; jobId: string; lead: LeadRow; where: string[]; evidence: string; established: boolean; src: string; today: string; now: number; fetchImpl: typeof fetch; buyerTitles: string[]; env?: Record<string, string | undefined>; keepUnsentHeld?: boolean }
// A lookup the spend gate refused before sending (#382). In a scan pass its claim is released (it cannot have been charged). In
// an OWNER RETRY (keepUnsentHeld) it stays held, recorded as not sent, so the owner's held item and its retry action survive a
// refusal instead of vanishing behind a "retried" that sent nothing.
const settleUnsent = (c: Ctx, claim: AuditEntryLike, id: string, e: SpendRefused) => c.keepUnsentHeld ? auditSettleClaim(c.db, claim, id, unsentStatus(e), 0) : auditReleaseUnsent(c.db, claim, id, unsentStatus(e))
type AuditEntryLike = Parameters<typeof auditReleaseUnsent>[1]

// Credit-pool helpers (lib/enrich/credit-pool.ts). A refusal names its reason; a release or settle that cannot be saved
// leaves the full reservation counted (an over-count, never an under-count), so it only logs.
const creditWhy = (e: unknown): 'credit_cap' | 'credit_unsaved' => e instanceof CreditRefused && e.reason === 'credit_cap' ? 'credit_cap' : 'credit_unsaved'
async function releaseUnused(db: Database.Database, h: CreditHold): Promise<void> {
  try { await refundCredits(db, h) } catch (e) { console.error('[enrich] credit refund not saved (reservation kept):', e instanceof Error ? e.message.slice(0, 120) : 'error') }
}
async function settleCharged(db: Database.Database, h: CreditHold, charged: number): Promise<void> {
  try { await settleCredits(db, h, charged) } catch (e) { console.error('[enrich] credit settle not saved (reservation kept):', e instanceof Error ? e.message.slice(0, 120) : 'error') }
}

// The REVIEWED buyer titles for the job (#383): only an explicit seller_decisions 'confirm' row is review
// evidence - a submitted profile (icp_inferred=0), a 'reviewed' status string or a model grade are NOT
// (lib/scan/intelligence.ts: authorship evidence is the actor's own action payload, and the route takes
// actor/tenant from requireUser(), never from the request body). The latest decision wins per hypothesis
// AND per normalized text, so a later reject supersedes an earlier confirm of the same title. Scope is the
// job's research site and its one identifiable offer - decisions never cross offer IDs.
// An UNREVIEWED persona (no confirm rows: model-inferred, request-fallback, or merely submitted) never
// narrows retrieval: with a wrong title set the filtered page fills with wrong-role people and the actual
// buyer is lost. Nothing is derived or expanded here either - an invented seniority/function would narrow the query.
export function reviewedBuyerTitles(db: Database.Database, jobId: string): string[] {
  try {
    const j = db.prepare('SELECT user_id, icp, offer FROM scan_jobs WHERE id = ?').get(jobId) as { user_id: string; icp: string | null; offer: string | null } | undefined
    const icp = j?.icp ? JSON.parse(j.icp) as { research?: { site?: unknown; offers?: { i: string; n: string }[] } } : null
    const site = typeof icp?.research?.site === 'string' ? siteKey(icp.research.site) : null
    if (!j?.user_id || !site) return []
    const offers = (Array.isArray(icp?.research?.offers) ? icp.research.offers : []).filter(o => o && typeof o.i === 'string' && typeof o.n === 'string')
    const offerName = j.offer && j.offer !== '-' ? j.offer : null
    // The same play-name -> offer contract as the reviewed draft and decision reuse (stored name; more than one candidate selects nothing).
    const named = offers.map(o => ({ id: o.i, name: o.n }))
    const sel = offerName ? selectOffer(named, offerName, (a, b) => !!norm(a) && norm(a) === norm(b)) : null
    const selected = sel ?? (!offerName && offers.length === 1 ? offers[0].i : null)
    if (!selected) return []
    const rows = db.prepare("SELECT offer_id, hypothesis_id, kind, text, action FROM seller_decisions WHERE tenant_id = ? AND site = ? AND kind = 'persona' ORDER BY created_at DESC, action DESC, id DESC LIMIT ?").all(j.user_id, site, RECALL_LIMIT + 1) as { offer_id: string; hypothesis_id: string; kind: string; text: string; action: string }[]
    // Saved rows carry only an offer id, which can change; each is rebound to the ONE current offer its id can mean, or HELD. A held confirmation is applied to no offer; a held rejection
    // blocks its text for every candidate. A row naming no current offer is not carried.
    const seen = new Set<string>(), titles: string[] = [], blocked = new Set<string>()
    for (const raw of rows.slice(0, RECALL_LIMIT)) {
      const rb = rebindOfferId(named, raw.offer_id); if (!rb) continue
      const offerId = 'offer' in rb ? rb.offer : `held:${rb.held.join(',')}`
      const hypKey = `${offerId}|id:${raw.hypothesis_id}`, textKey = `${offerId}|${raw.kind}|text:${norm(raw.text)}`
      if (seen.has(hypKey) || seen.has(textKey)) continue // superseded by a newer decision
      seen.add(hypKey); seen.add(textKey)
      if ('held' in rb) { if (raw.action === 'reject' && rb.held.includes(selected)) blocked.add(norm(raw.text)); continue }
      if (rb.offer === selected && raw.action === 'confirm' && raw.text.trim() && titles.length < 10) titles.push(raw.text.trim())
    }
    return titles.filter(t => !blocked.has(norm(t)))
  } catch { return [] }
}

// Shared post-fetch role classification (#383): no provider call, applied to whatever a search returned.
// roleContradicted's past/retired/negated/assistant patterns are persona-independent, so this is safe
// with an empty icpText; an unreviewed (inferred/fallback) persona is never passed as icpText.
export function roleRejection(title: string | null, icpText: string): string | null {
  return title && roleContradicted(title, icpText) ? `contact rejected: title contradicts the reviewed buyer role (past, retired, negated or assistant-to): ${title}`.slice(0, 200) : null
}

type AttemptOutcome =
  | { kind: 'ran'; n: number; verdict: 'attached' | 'empty' | 'rejected' } // the attempt ran this pass; n contacts attached
  | { kind: 'replayed-ok' }        // contacts already attached for this lead+job: replay free, stop the waterfall
  | { kind: 'replayed-terminal' }  // known empty / terminally rejected: do not pay again, try the next provider
  | { kind: 'uncertain' }          // a held claim MAY have been charged: fail closed - owner resolution only
  | { kind: 'budget' }             // the next step would exceed the per-scan call budget
  | { kind: 'credit'; why: 'credit_cap' | 'credit_unsaved'; refusal?: CreditRefusal } // the workspace credit pool refused the paid org lookup: no call

// The org claim's memo: everything the people step needs after the paid org lookup ran - the confirmed domain the
// people search queries and the agreement basis bits the pass decided on. Written in the SAME transaction as the
// org claim's terminal settle (store.ts); presence is authoritative: memo == "agreement passed; resume people".
interface OrgMemo { v: 1; website: string | null; domain: string | null; name: string | null; place: unknown; address: unknown; established: boolean; keyedOnLeadDomain: boolean; rejected?: string }
const parseMemo = (raw: string | null): OrgMemo | null => {
  if (!raw) return null
  try { const m = JSON.parse(raw) as OrgMemo; return m && m.v === 1 ? m : null } catch { return null }
}

// One Apollo attempt for one lead, as two independently-claimed steps:
//   STEP 1 org    (organizations/enrich = 1 credit, Apollo's current endpoint reference): claim settles with the memo.
//   STEP 2 people (mixed_people/api_search = 0 credits, same source; no email/phone): resumes on the memo alone.
// A crash between the steps leaves people UNCLAIMED (provably never called) and the replay spends nothing: it
// loads the memo and runs only the free step. A HELD claim of either step is never released automatically -
// resolution is the owner's explicit, disclosure-audited retry (retryHeldEnrichment below).
// A crash between the terminal people settle and the rejection-card write leaves the claim terminal but the card
// forever missing. The card write is idempotent (contact-agreement addEnrichment ON CONFLICT DO NOTHING), so every
// terminal-'rejected' replay re-issues it from the claim's recorded audit verdict - the card self-heals next pass.
const repairRejectionCard = (c: Ctx, peopleKey: string) => {
  const verdict = latestAuditStatus(c.db, { tenantId: c.tenantId, connector: ENRICH_APOLLO, jobId: c.jobId, lookup: peopleKey })
  if (verdict?.startsWith('contact rejected')) recordContactRejection(c.db, c.tenantId, c.lead.id, { connector: ENRICH_APOLLO, reason: verdict, sourceUrl: c.src })
}

async function runApollo(c: Ctx, key: string, spend: { used: Record<Prov, number>; budget: Record<Prov, number> }): Promise<AttemptOutcome> {
  const { db, tenantId, jobId, lead, where, evidence, established, src, today, now, fetchImpl } = c
  const orgKey = stepKey('org', lead), peopleKey = stepKey('people', lead)
  const orgClaim = { tenantId, connector: ENRICH_APOLLO, jobId, lookup: orgKey, status: 'reserved', results: 0 }
  const peopleClaim = { tenantId, connector: ENRICH_APOLLO, jobId, lookup: peopleKey, status: 'reserved', results: 0 }
  // Org observability keeps the legacy 'org X (domain)' audit series; the replay contract lives on the claim rows.
  const orgAudit = (status: string, results: number) => audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: lookupKey('org', lead), status, results })

  // The people step's own state gates EVERYTHING, before any money moves: a terminal people outcome replays free
  // and a HELD people claim stops the attempt - a possibly-charged call is never preceded by a NEW paid one.
  const peoplePrior0 = readClaimCompat(db, peopleClaim, lead, l => rawStep('people', l), { legacyAudit: false })
  if (peoplePrior0) {
    if (peoplePrior0.prior === 'ok') return { kind: 'replayed-ok' }
    if (peoplePrior0.prior === 'empty' || peoplePrior0.prior === 'rejected') { if (peoplePrior0.prior === 'rejected') repairRejectionCard(c, peopleKey); return { kind: 'replayed-terminal' } }
    return { kind: 'uncertain' } // HELD people claim: owner-only - the endpoint is 0-credit, but rate/access risk is not ours to release
  }

  // STEP 1 - the organization lookup: the attempt's only PAID Apollo call.
  let org: Awaited<ReturnType<typeof apolloOrgEnrich>> = null
  let orgFailure: unknown = null
  let memo: OrgMemo | null = null
  let orgRan = false
  const orgPrior = readClaimCompat(db, orgClaim, lead, l => rawStep('org', l), { legacyAudit: false })
  if (orgPrior?.prior === 'uncertain') return { kind: 'uncertain' } // the org call may have been charged: owner resolution only
  if (orgPrior?.prior === 'ok') { memo = parseMemo(orgPrior.memo); orgRan = true }
  if (orgPrior?.prior === 'empty' || orgPrior?.prior === 'rejected') orgRan = true // terminal: never pay for it again
  if (!orgRan) {
    if (spend.used.apollo >= spend.budget.apollo) return { kind: 'budget' }
    // The workspace credit pool (#363): the org lookup's 1 credit is reserved before the claim and the call.
    let hold: CreditHold
    try { hold = await reserveCredits(db, tenantId, 'apollo', 1, { env: c.env, now }) }
    catch (e) { return { kind: 'credit', why: creditWhy(e), refusal: e instanceof CreditRefused ? e.detail : undefined } }
    spend.used.apollo += 1 // reserve the budget before spending it
    const gate = auditTryReserve(db, orgClaim)
    if ('prior' in gate) {
      await releaseUnused(db, hold) // another pass holds this lookup: no call here
      if (gate.prior === 'uncertain') return { kind: 'uncertain' }
      if (gate.prior === 'ok') memo = parseMemo(readOutcome(db, orgClaim, { legacyAudit: false })?.memo ?? null)
    } else {
      try {
        org = await apolloOrgEnrich(key, { domain: normDomain(lead.company_domain), name: lead.company }, fetchImpl)
        // A returned organization is the charged credit. No match, or an error, keeps the reservation: whether Apollo
        // charged it is not known.
        if (org) await settleCharged(db, hold, 1)
        const agree = org ? contactAgreement({ company_domain: lead.company_domain, where, evidence, domainEstablished: established }, { domain: domainOf(org.website), place: org.place, address: org.address, keyedOnLeadDomain: !!lead.company_domain }) : null
        if (org && agree && !agree.ok) {
          // The org data returned (paid, terminal) but is NOT this company: the org claim settles 'ok' WITH a
          // rejection-verdict memo in the SAME transaction, so a crash before the people verdict can never strand
          // the lead at "org ok, no memo" - replay resumes the verdict below with zero provider calls.
          const verdict: OrgMemo = { v: 1, website: org.website ?? null, domain: normDomain(org.website), name: org.name ?? null, place: org.place ?? null, address: org.address ?? null, established, keyedOnLeadDomain: !!lead.company_domain, rejected: agree.reason }
          auditSettleClaim(db, { ...orgClaim, status: 'ok', results: 1 }, gate.id, 'ok', 1, JSON.stringify(verdict))
          orgAudit('ok', 1)
          const pg = auditTryReserve(db, peopleClaim)
          if ('id' in pg) auditSettleClaim(db, { ...peopleClaim, status: agree.reason, results: 0 }, pg.id, agree.reason, 0)
          recordContactRejection(db, tenantId, lead.id, { connector: ENRICH_APOLLO, reason: agree.reason, sourceUrl: org.website ?? src })
          return { kind: 'ran', n: 0, verdict: 'rejected' }
        }
        if (org && (org.employees || org.industry)) {
          const bits = [org.employees ? `${org.employees} employees` : null, org.industry, org.founded ? `founded ${org.founded}` : null].filter(Boolean).join(' \u00b7 ')
          addEnrichment(db, tenantId, lead.id, { connector: ENRICH_APOLLO, kind: 'firmographic', value: bits.slice(0, 254), label: org.name, confidence: 75, source_url: org.linkedin ?? org.website ?? src, source_date: today, retrieved_at: now })
        }
        // The firmographic row is written BEFORE the memo lands: a crash in between holds the claim (owner-only),
        // so memo presence also implies the visible firmographic enrichment exists.
        memo = org ? { v: 1, website: org.website ?? null, domain: normDomain(org.website), name: org.name ?? null, place: org.place ?? null, address: org.address ?? null, established, keyedOnLeadDomain: !!lead.company_domain } : null
        auditSettleClaim(db, { ...orgClaim, status: org ? 'ok' : 'empty', results: org ? 1 : 0 }, gate.id, org ? 'ok' : 'empty', org ? 1 : 0, memo ? JSON.stringify(memo) : undefined)
        orgAudit(org ? 'ok' : 'empty', org ? 1 : 0)
        if (!org) memo = null
      } catch (e) {
        // The scan's hard spend cap refused the org call before any request (lib/scan/spend-cap.ts): nothing was
        // sent, so the workspace credit goes back. Any other failure keeps it (whether Apollo charged is unknown).
        // #382: and the claim is released in the same step (never held: nothing was sent), and the attempt stops here - the
        // people step would be refused by the same gate.
        if (e instanceof SpendRefused) { await releaseUnused(db, hold); settleUnsent(c, orgClaim, gate.id, e); throw e }
        const code = failCode(e)
        auditSettleClaim(db, { ...orgClaim, status: code, results: 0 }, gate.id, code, 0)
        if (e instanceof EnrichError && e.code === 'auth') throw e // a bad key stops the provider for the pass (the claim's audit row carries the auth); the held org claim fails the replay CLOSED
        // No second 'org X' row for a failure: the claim's own audit row already carries the code, and a duplicate
        // would double the scan view's "lookups affected" count for ONE failed call (lib/scan/provider-issues.ts).
        orgFailure = e  // any other org failure: the people search below may still run on an already-known domain
        org = null
      }
    }
  }

  // A rejection-verdict memo (a crash hit between the paid org settle and the people verdict): resume the verdict
  // with ZERO calls - the people claim settles 'rejected' and the visible rejection card is repaired, both
  // idempotent, so a double replay converges to the same terminal state.
  if (memo?.rejected) {
    const pg = auditTryReserve(db, peopleClaim)
    if ('id' in pg) auditSettleClaim(db, { ...peopleClaim, status: memo.rejected, results: 0 }, pg.id, memo.rejected, 0)
    recordContactRejection(db, tenantId, lead.id, { connector: ENRICH_APOLLO, reason: memo.rejected, sourceUrl: memo.website ?? src })
    return { kind: 'replayed-terminal' }
  }

  // STEP 2 - the people search (0-credit): the org memo alone authorizes skipping the paid org call.
  const orgDomain = normDomain(lead.company_domain) ?? memo?.domain ?? normDomain(org?.website)
  if (!orgDomain) {
    const pg = auditTryReserve(db, peopleClaim)
    if ('id' in pg) auditSettleClaim(db, { ...peopleClaim, status: 'contact rejected: no domain to confirm the company', results: 0 }, pg.id, 'contact rejected: no domain to confirm the company', 0)
    recordContactRejection(db, tenantId, lead.id, { connector: ENRICH_APOLLO, reason: 'contact rejected: no domain to confirm the company', sourceUrl: src })
    if (orgFailure) throw orgFailure
    return { kind: 'ran', n: 0, verdict: 'rejected' }
  }
  if (spend.used.apollo >= spend.budget.apollo) return { kind: 'budget' }
  spend.used.apollo += 1
  const pgate = auditTryReserve(db, peopleClaim)
  if ('prior' in pgate) {
    if (pgate.prior === 'ok') return { kind: 'replayed-ok' }
    if (pgate.prior === 'empty' || pgate.prior === 'rejected') { if (pgate.prior === 'rejected') repairRejectionCard(c, peopleKey); return { kind: 'replayed-terminal' } }
    return { kind: 'uncertain' }
  }
  // The reviewed buyer role goes into the query BEFORE the page cap (#383): without it the first
  // unfiltered page can omit the buyer entirely, and no later ranking recovers a person never fetched.
  let found: Awaited<ReturnType<typeof apolloPeopleSearch>>
  try { found = await apolloPeopleSearch(key, { domain: orgDomain, name: lead.company }, fetchImpl, MAX_CONTACTS, c.buyerTitles.length ? { titles: c.buyerTitles } : undefined) }
  catch (e) {
    // Refused before sending: released, never held (#382). When the org call already failed (a 429, a timeout) that failure is
    // why the gate refused this one, so it is what the waterfall records - never the refusal it caused.
    if (e instanceof SpendRefused) { settleUnsent(c, peopleClaim, pgate.id, e); throw orgFailure ?? e }
    const code = failCode(e); auditSettleClaim(db, { ...peopleClaim, status: code, results: 0 }, pgate.id, code, 0); throw e
  }
  // No unfiltered fallback (#383 review): an extra query per lead is a NEW call shape whose cost is not
  // account-verified (Apollo pricing is plan-dependent), so it cannot ship as a free fact. The recall
  // contract instead: an unreviewed persona never filters at all (the old unfiltered query, unchanged);
  // a reviewed persona with an empty filtered page attaches nobody this pass, visibly.
  if (found.length === 0 && c.buyerTitles.length)
    audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: peopleKey, status: 'role-filtered people search empty; no unfiltered fallback: extra query cost not account-verified', results: 0 })
  // A person whose own organization contradicts the requested company (another name, another domain) is
  // not attached; neither is one whose title contradicts the reviewed buyer role - past, retired, negated
  // or assistant-to (#383: former employees and assistants-to-the-buyer are rejected at the source, not
  // merely demoted at display time).
  const icpText = c.buyerTitles.join('; ')
  const people = []
  for (const p of found) {
    const why = organizationContradicts(lead.company, orgDomain, p.organization) ?? roleRejection(p.title, icpText)
    if (!why) { people.push(p); continue }
    audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: peopleKey, status: why, results: 0 })
    recordContactRejection(db, tenantId, lead.id, { connector: ENRICH_APOLLO, reason: why, sourceUrl: src })
  }
  for (const p of people) addEnrichment(db, tenantId, lead.id, { connector: ENRICH_APOLLO, kind: 'contact', value: `${p.name}${p.title ? ` - ${p.title}` : ''}`.slice(0, 254), label: providerContactLabel('enrich:apollo', p.recordDay ?? null), confidence: 70, source_url: p.linkedin ?? src, source_date: today, retrieved_at: now })
  const out = people.length ? 'ok' : (found.length ? 'contact rejected: every candidate contradicted the company or the reviewed buyer role' : 'empty')
  auditSettleClaim(db, { ...peopleClaim, status: out, results: people.length }, pgate.id, out, people.length)
  return { kind: 'ran', n: people.length, verdict: people.length ? 'attached' : found.length ? 'rejected' : 'empty' }
}

// maxProfiles caps the request size to the scan's remaining PDL profile budget: PDL charges 1 credit per profile
// RETURNED (adapter contract), so the size cap is the credit cap. Returns profiles ATTACHED; c.charged gets the
// number of profiles returned (the credits actually spent, including profiles the agreement check then rejects).
async function runPdl(c: Ctx, reservationId: string, key: string, maxProfiles: number, charged: { n: number }, hold: CreditHold): Promise<{ n: number; verdict: 'attached' | 'empty' | 'rejected' }> {
  const { db, tenantId, jobId, lead, where, evidence, established, src, today, now, fetchImpl } = c
  const peopleKey = lookupKey('people', lead)
  let found: Awaited<ReturnType<typeof pdlPeopleSearch>>
  try { found = await pdlPeopleSearch(key, lead.company, fetchImpl, Math.max(1, maxProfiles)) }
  catch (e) {
    // A refusal by the scan's hard spend cap sent nothing: the workspace credits go back and the claim is released (#382: it
    // cannot have been charged, so it is never held for an owner retry). Any other error keeps both.
    if (e instanceof SpendRefused) { await releaseUnused(db, hold); settleUnsent(c, { tenantId, connector: ENRICH_PDL, jobId, lookup: peopleKey, status: 'reserved', results: 0 }, reservationId, e); throw e }
    const code = failCode(e); auditSettleClaim(db, { tenantId, connector: ENRICH_PDL, jobId, lookup: peopleKey, status: code, results: 0 }, reservationId, code, 0); throw e
  }
  charged.n += found.length
  // PDL charges per profile returned: the reservation moves to that count (an error above keeps all of it).
  await settleCharged(db, hold, found.length)
  // PDL matches on the company NAME only: each person's company must agree with the lead on its domain or place.
  // Post-fetch role classification is shared with the Apollo path (#383): no extra PDL query, the
  // returned profiles are simply classified before attach - past/assistant titles never attach.
  const people = []
  for (const p of found) {
    const a = contactAgreement({ company_domain: lead.company_domain, where, evidence, domainEstablished: established }, { domain: p.domain, place: p.place, address: p.address })
    const why = a.ok ? roleRejection(p.title, c.buyerTitles.join('; ')) : a.reason
    if (!why) people.push(p); else { audit(db, { tenantId, connector: ENRICH_PDL, jobId, lookup: peopleKey, status: why, results: 0 }); recordContactRejection(db, tenantId, lead.id, { connector: ENRICH_PDL, reason: why, sourceUrl: src }) }
  }
  for (const p of people) addEnrichment(db, tenantId, lead.id, { connector: ENRICH_PDL, kind: 'contact', value: `${p.name}${p.title ? ` - ${p.title}` : ''}`.slice(0, 254), label: providerContactLabel('enrich:pdl', p.recordDay ?? null), confidence: 70, source_url: p.linkedin ?? src, source_date: today, retrieved_at: now })
  auditSettleClaim(db, { tenantId, connector: ENRICH_PDL, jobId, lookup: peopleKey, status: people.length ? 'ok' : (found.length ? 'contact rejected: every candidate contradicted the company or the reviewed buyer role' : 'empty'), results: people.length }, reservationId, people.length ? 'ok' : (found.length ? 'contact rejected: every candidate contradicted the company or the reviewed buyer role' : 'empty'), people.length)
  return { n: people.length, verdict: people.length ? 'attached' : found.length ? 'rejected' : 'empty' }
}

// ---- Owner resolution for held enrichment claims (the recovery follow-up named in store.ts) ----

export interface HeldEnrichment { leadId: string; company: string; jobId: string; provider: Prov; step: 'org' | 'people' | 'legacy'; lookup: string; claimedAt: number }
// A real provider call settles in seconds: a claim 'reserved' past this age belongs to a crashed/rate-limited
// pass, not a live one. The age gate is what makes an owner release safe against a concurrent live attempt.
export const HELD_AFTER_S = 15 * 60

export function heldEnrichments(db: Database.Database, tenantId: string, nowSec = Math.floor(Date.now() / 1000)): HeldEnrichment[] {
  const rows = db.prepare("SELECT scan_job_id, connector, lookup, claimed_at FROM connector_claims WHERE tenant_id = ? AND status = 'reserved' AND connector IN ('enrich:apollo', 'enrich:pdl') AND claimed_at < ?").all(tenantId, nowSec - HELD_AFTER_S) as { scan_job_id: string; connector: string; lookup: string; claimed_at: number }[]
  const byJob = new Map<string, LeadRow[]>()
  const out: HeldEnrichment[] = []
  for (const r of rows) {
    if (!byJob.has(r.scan_job_id)) byJob.set(r.scan_job_id, db.prepare('SELECT id, company, company_domain FROM leads WHERE scan_job_id = ?').all(r.scan_job_id) as LeadRow[])
    for (const lead of byJob.get(r.scan_job_id)!) {
      const k = claimKeysFor(lead), t = legacyTruncatedKeysFor(lead) // Only attributable old rows are owner-resolvable.
      const step = r.lookup === k.stepOrg || r.lookup === t.stepOrg ? 'org' : r.lookup === k.stepPeople || r.lookup === t.stepPeople ? 'people' : r.lookup === k.legacyPeople || r.lookup === t.legacyPeople ? 'legacy' : null
      const raw = step === 'org' ? (l: LeadRow) => rawStep('org', l) : step === 'people' ? (l: LeadRow) => rawStep('people', l) : (l: LeadRow) => rawLookup('people', l)
      if (step && r.lookup !== (step === 'org' ? k.stepOrg : step === 'people' ? k.stepPeople : k.legacyPeople) && !unambiguousTruncatedIdentity(byJob.get(r.scan_job_id)!, raw(lead), raw)) continue
      if (step) { out.push({ leadId: lead.id, company: lead.company, jobId: r.scan_job_id, provider: r.connector === ENRICH_APOLLO ? 'apollo' : 'pdl', step, lookup: r.lookup, claimedAt: r.claimed_at }); break }
    }
  }
  return out
}

// Cost scope of an owner retry. Provider credit terms depend on the connected account's plan (Apollo's own pricing
// page says legacy workspaces may differ from the published endpoint costs; PDL terms are not verified here either),
// so a retry is only offered for a provider whose cost on THIS deployment's account the operator has confirmed:
// DAZL_ENRICH_RETRY_COST_VERIFIED="apollo,pdl". Default: nothing verified, every held lookup stays held.
export function retryCostVerified(provider: Prov): boolean {
  return (process.env.DAZL_ENRICH_RETRY_COST_VERIFIED ?? '').split(',').map(x => x.trim().toLowerCase()).includes(provider)
}

// The exact cost/limits wording the owner acts on. Apollo credit costs are the provider's current endpoint
// references; the retry is always the owner's explicit action, never an automatic release.
export function heldCostText(h: HeldEnrichment): string {
  const name = h.provider === 'apollo' ? 'Apollo' : 'People Data Labs'
  if (!retryCostVerified(h.provider)) return `Retry unavailable: what this lookup costs on your ${name} account has not been verified, so it stays held and no new lookup is made. Whether the earlier interrupted attempt was already billed is not known. ${h.provider === 'apollo' ? "Apollo documents contact search as 0 credits on current plans, but older plans can differ. " : ''}It can be retried once the cost on your account is confirmed.`
  if (h.provider === 'apollo' && h.step === 'people') return 'Retry the contact search: the saved company data is reused (not re-charged). Apollo documents people search as 0 credits on current plans; confirm your plan if it is older. Rate limits may apply.'
  if (h.provider === 'apollo') return 'Retry the company lookup: the earlier attempt could not prove its outcome, so this can charge 1 Apollo credit again.'
  return `Retry the contact lookup: the earlier attempt could not prove its outcome, so this can use People Data Labs credits again (1 per profile returned, up to ${MAX_CONTACTS}).`
}

// The owner retry itself: releases ONLY the one held claim the owner selected. Consent and cost scope are
// load-bearing: each retry action names the exact provider+step whose cost/limits were disclosed next to it, so
// an Apollo action never releases a PDL claim and never runs a PDL call (the re-run is scoped to that provider).
export async function retryHeldEnrichment(db: Database.Database, tenantId: string, leadId: string, selector: { provider: Prov; step: HeldEnrichment['step'] }, deps: { fetchImpl?: typeof fetch; master?: Buffer } = {}): Promise<{ status: 'not_found' | 'nothing_held' | 'cost_unverified' } | { status: 'refused'; reason: string } | { status: 'retried'; attached: number; releases: string[] }> {
  const lead = db.prepare('SELECT l.id, l.company, l.company_domain, l.scan_job_id FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(leadId, tenantId) as (LeadRow & { scan_job_id: string }) | undefined
  if (!lead) return { status: 'not_found' }
  const h = heldEnrichments(db, tenantId).find(h => h.leadId === leadId && h.provider === selector.provider && h.step === selector.step)
  if (!h) return { status: 'nothing_held' }
  if (!retryCostVerified(h.provider)) return { status: 'cost_unverified' } // checked BEFORE the claim is released: nothing moves
  const disclosure = h.provider === 'apollo' && h.step === 'people'
    ? 'owner retry: people search resumed on the saved org memo; Apollo documents this endpoint as 0 credits (cost confirmed by the operator for this account)'
    : 'owner retry: the earlier attempt could not prove its outcome; the lookup may be charged again'
  const released = db.transaction(() => {
    // Revalidate attribution next to the release under one snapshot, not a stale UI/earlier selection.
    const current = heldEnrichments(db, tenantId).find(row => row.leadId === leadId && row.provider === h.provider && row.step === h.step && row.lookup === h.lookup)
    return !!current && releaseHeldClaim(db, { tenantId, connector: h.provider === 'apollo' ? ENRICH_APOLLO : ENRICH_PDL, jobId: h.jobId, lookup: h.lookup }, disclosure)
  })()
  if (!released) return { status: 'nothing_held' }
  // The re-run draws on the scan's own hard spend cap (lib/scan/spend-cap.ts), as the scan's first pass did.
  // A refusal by that cap sends nothing: the lookup stays held (keepUnsentHeld) and the owner is told it was refused, never "retried".
  const r = await runWithJobSpend(db, tenantId, lead.scan_job_id, () => enrichLeadContacts(db, tenantId, lead.scan_job_id, [{ id: lead.id, company: lead.company, company_domain: lead.company_domain }], { ...deps, only: h.provider, keepUnsentHeld: true }))
  // 'refused' only when THE LOOKUP THE OWNER PICKED was itself not sent (a refused follow-up step after a sent, charged call is a
  // retry that ran). It stays listed as held right away: the fresh claim gets back the original claim's age (HELD_AFTER_S gate).
  const connector = h.provider === 'apollo' ? ENRICH_APOLLO : ENRICH_PDL
  const why = latestAuditStatus(db, { tenantId, connector, jobId: lead.scan_job_id, lookup: h.lookup })
  if (why?.startsWith('not sent: ')) {
    db.prepare("UPDATE connector_claims SET claimed_at = ? WHERE tenant_id = ? AND connector = ? AND scan_job_id = ? AND lookup = ? AND status = 'reserved'").run(h.claimedAt, tenantId, connector, lead.scan_job_id, h.lookup)
    return { status: 'refused', reason: why.slice('not sent: '.length) }
  }
  return { status: 'retried', attached: r.attached, releases: [`${h.provider} ${h.step}`] }
}
