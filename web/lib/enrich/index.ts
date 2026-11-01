// BYOK contact/firmographic enrichment in the scan waterfall. Runs only with the tenant's own keys
// (Settings > Enrichment). Each configured provider is loaded independently and tried in order (Apollo, then PDL):
// the next provider is tried when the previous one finds nothing usable (empty, rejected as a different company,
// rate-limited, timed out, upstream error or a bad key). Per-pass circuit breaker per provider, per-tenant call budget
// (an exhausted budget is a visible audit row, never a silent skip), no repeat charge for a lookup this job already made.
// Every call is audit-rowed; a failure never ends the whole pass (a bonus, never the bar).
import type Database from 'better-sqlite3'
import { addEnrichment, audit, auditSettleClaim, auditTryReserve, enrichFallbackEnabled, getEnabledCredential, latestAuditStatus, readOutcome, releaseHeldClaim } from '../connectors/store.ts'
import { apolloOrgEnrich, apolloPeopleSearch, EnrichError } from './apollo.ts'
import { pdlPeopleSearch } from './pdl.ts'
import { getMasterKey } from '../secrets.ts'
import { domainRelationship } from '../signals/domain-basis.ts'
import { contactAgreement, organizationContradicts, recordContactRejection } from '../scan/contact-agreement.ts'

export const ENRICH_APOLLO = 'enrich:apollo'
export const ENRICH_PDL = 'enrich:pdl'
const MAX_LEADS = 5 // credit discipline: at most 5 org enrich calls (1 credit each) per scan
const MAX_CONTACTS = 5 // people search is 0-credit on Apollo; PDL charges per profile

export interface LeadRow { id: string; company: string; company_domain: string | null }

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
const lookupKey = (kind: 'org' | 'people', lead: LeadRow) => `${kind} ${lead.company} (${lead.company_domain ? lead.company_domain : `lead:${lead.id}`})`.slice(0, 200)
// STEP format ('step:org/people ...'): per-step claims. The step: prefix can never collide with a legacy key.
const stepKey = (kind: 'org' | 'people', lead: LeadRow) => `step:${kind} ${lead.company} (${normDomain(lead.company_domain) ?? `lead:${lead.id}`})`.slice(0, 200)
export const claimKeysFor = (lead: LeadRow): { legacyPeople: string; stepOrg: string; stepPeople: string } =>
  ({ legacyPeople: lookupKey('people', lead), stepOrg: stepKey('org', lead), stepPeople: stepKey('people', lead) })

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
export interface EnrichSummary { attached: number; byProvider: Record<Prov, number>; skipped: { provider: Prov; why: 'circuit_open' | 'budget_exhausted' | 'replayed' | 'uncertain' | 'not_configured' | 'unresolved' }[] }

export async function enrichLeadContacts(
  db: Database.Database,
  tenantId: string,
  jobId: string,
  leads: LeadRow[],
  deps: { fetchImpl?: typeof fetch; master?: Buffer; budget?: Partial<Record<Prov, number>>; only?: Prov } = {},
): Promise<EnrichSummary> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const summary: EnrichSummary = { attached: 0, byProvider: { apollo: 0, pdl: 0 }, skipped: [] }
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
  try {
    if (keys.apollo && !enrichFallbackEnabled(db, tenantId)) keys.pdl = null
    if (!keys.apollo && !keys.pdl) return summary
    where = scanWhere(db, jobId) // an agreement basis: unreadable = the pass refuses rather than agrees on a guess
  } catch (e) { return setupFailed(e) }
  const now = Math.floor(Date.now() / 1000)
  const today = new Date().toISOString().slice(0, 10)
  const budget: Record<Prov, number> = { apollo: deps.budget?.apollo ?? APOLLO_CALLS, pdl: deps.budget?.pdl ?? PDL_CALLS }
  const used: Record<Prov, number> = { apollo: 0, pdl: 0 }, fails: Record<Prov, number> = { apollo: 0, pdl: 0 }, open: Record<Prov, boolean> = { apollo: false, pdl: false }
  const told = new Set<string>()
  const skip = (prov: Prov, why: EnrichSummary['skipped'][number]['why'], lead: LeadRow) => {
    summary.skipped.push({ provider: prov, why })
    // visible once per provider and reason per pass
    const k = `${prov}:${why}`; if (!told.has(k) && why !== 'replayed') { told.add(k); audit(db, { tenantId, connector: connector[prov], jobId, lookup: `people ${lead.company}`.slice(0, 200), status: why, results: 0 }) }
  }
  const failed = (prov: Prov, e: unknown) => {
    const code = e instanceof EnrichError ? e.code : 'error'
    if (code === 'auth') open[prov] = true                    // a bad key stops THAT provider for the pass, not the pass
    else if (++fails[prov] >= MAX_FAILS) open[prov] = true    // repeated transient failures open the circuit
  }

  for (const lead of leads.slice(0, MAX_LEADS)) {
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
      continue
    }
    const src = lead.company_domain ? `https://${lead.company_domain}` : `https://www.linkedin.com/company/${encodeURIComponent(lead.company.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}`
    const ctx: Ctx = { db, tenantId, jobId, lead, where, evidence, established, src, today, now, fetchImpl }
    for (const prov of ['apollo', 'pdl'] as Prov[]) {
      if (deps.only && prov !== deps.only) continue // an owner retry runs exactly the provider whose cost they saw
      if (!keys[prov]) continue
      if (open[prov]) { skip(prov, 'circuit_open', lead); continue }
      if (used[prov] >= budget[prov]) { skip(prov, 'budget_exhausted', lead); continue }
      if (prov === 'pdl') {
        // PDL stays ONE whole-attempt claim (its search is itself the paid step): held = owner resolution only.
        // ATOMIC durable reservation (#382): one guarded insert claims this lookup for the job BEFORE any paid
        // call; a replayed or double-run job loses the race and reads the winner's outcome instead of paying again.
        const gate = auditTryReserve(db, { tenantId, connector: connector[prov], jobId, lookup: lookupKey('people', lead), status: 'reserved', results: 0 })
        if ('prior' in gate) {
          if (gate.prior === 'ok') { skip(prov, 'replayed', lead); break }            // already found for this lead in this job
          if (gate.prior === 'empty' || gate.prior === 'rejected') { skip(prov, 'replayed', lead); continue } // known empty/terminally rejected: do not pay again, try the next provider
          skip(prov, 'uncertain', lead); break                                       // a crashed pass may have paid: fail closed, never pay twice
        }
        let n = 0
        try { const charged = { n: 0 }; n = await runPdl(ctx, gate.id, keys.pdl!, Math.min(MAX_CONTACTS, budget.pdl - used.pdl), charged); used.pdl += charged.n }
        catch (e) { failed(prov, e); continue }
        summary.byProvider[prov] += n; summary.attached += n
        if (n > 0) break      // a verified candidate: the next provider is not needed (and is not charged)
        continue
      }
      // Apollo: honor a legacy whole-attempt outcome READ-ONLY (a legacy terminal replays free; a legacy HELD
      // claim stays held - the old row cannot prove whether its org call was charged, so resolution is the
      // owner's explicit, disclosure-audited retry). A fresh attempt never writes the legacy key again; it runs
      // per-step claims: the org claim (paid, settles with a memo) and the people claim (0-credit endpoint).
      const legacy = readOutcome(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: lookupKey('people', lead) })
      if (legacy) {
        if (legacy.prior === 'ok') { skip(prov, 'replayed', lead); break }
        if (legacy.prior === 'empty' || legacy.prior === 'rejected') { skip(prov, 'replayed', lead); continue }
        skip(prov, 'uncertain', lead); break
      }
      let out: AttemptOutcome
      try { out = await runApollo(ctx, keys.apollo!, { used, budget }) }
      catch (e) { failed(prov, e); continue }
      if (out.kind === 'replayed-ok') { skip(prov, 'replayed', lead); break }
      if (out.kind === 'replayed-terminal') { skip(prov, 'replayed', lead); continue }
      if (out.kind === 'uncertain') { skip(prov, 'uncertain', lead); break }
      if (out.kind === 'budget') { skip(prov, 'budget_exhausted', lead); continue }
      summary.byProvider.apollo += out.n; summary.attached += out.n
      if (out.n > 0) break
    }
  }
  return summary
}

interface Ctx { db: Database.Database; tenantId: string; jobId: string; lead: LeadRow; where: string[]; evidence: string; established: boolean; src: string; today: string; now: number; fetchImpl: typeof fetch }

type AttemptOutcome =
  | { kind: 'ran'; n: number }     // the attempt ran this pass; n contacts attached
  | { kind: 'replayed-ok' }        // contacts already attached for this lead+job: replay free, stop the waterfall
  | { kind: 'replayed-terminal' }  // known empty / terminally rejected: do not pay again, try the next provider
  | { kind: 'uncertain' }          // a held claim MAY have been charged: fail closed - owner resolution only
  | { kind: 'budget' }             // the next step would exceed the per-scan call budget

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
  const peoplePrior0 = readOutcome(db, peopleClaim, { legacyAudit: false })
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
  const orgPrior = readOutcome(db, orgClaim, { legacyAudit: false })
  if (orgPrior?.prior === 'uncertain') return { kind: 'uncertain' } // the org call may have been charged: owner resolution only
  if (orgPrior?.prior === 'ok') { memo = parseMemo(orgPrior.memo); orgRan = true }
  if (orgPrior?.prior === 'empty' || orgPrior?.prior === 'rejected') orgRan = true // terminal: never pay for it again
  if (!orgRan) {
    if (spend.used.apollo >= spend.budget.apollo) return { kind: 'budget' }
    spend.used.apollo += 1 // reserve the budget before spending it
    const gate = auditTryReserve(db, orgClaim)
    if ('prior' in gate) {
      if (gate.prior === 'uncertain') return { kind: 'uncertain' }
      if (gate.prior === 'ok') memo = parseMemo(readOutcome(db, orgClaim, { legacyAudit: false })?.memo ?? null)
    } else {
      try {
        org = await apolloOrgEnrich(key, { domain: normDomain(lead.company_domain), name: lead.company }, fetchImpl)
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
          return { kind: 'ran', n: 0 }
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
        const code = e instanceof EnrichError ? e.code : 'error'
        auditSettleClaim(db, { ...orgClaim, status: code, results: 0 }, gate.id, code, 0)
        if (e instanceof EnrichError && e.code === 'auth') throw e // a bad key stops the provider for the pass (the claim's audit row carries the auth); the held org claim fails the replay CLOSED
        orgAudit(code, 0)
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
    return { kind: 'ran', n: 0 }
  }
  if (spend.used.apollo >= spend.budget.apollo) return { kind: 'budget' }
  spend.used.apollo += 1
  const pgate = auditTryReserve(db, peopleClaim)
  if ('prior' in pgate) {
    if (pgate.prior === 'ok') return { kind: 'replayed-ok' }
    if (pgate.prior === 'empty' || pgate.prior === 'rejected') { if (pgate.prior === 'rejected') repairRejectionCard(c, peopleKey); return { kind: 'replayed-terminal' } }
    return { kind: 'uncertain' }
  }
  let found: Awaited<ReturnType<typeof apolloPeopleSearch>>
  try { found = await apolloPeopleSearch(key, { domain: orgDomain, name: lead.company }, fetchImpl, MAX_CONTACTS) }
  catch (e) { const code = e instanceof EnrichError ? e.code : 'error'; auditSettleClaim(db, { ...peopleClaim, status: code, results: 0 }, pgate.id, code, 0); throw e }
  // A person whose own organization contradicts the requested company (another name, another domain) is not attached.
  const people = []
  for (const p of found) {
    const why = organizationContradicts(lead.company, orgDomain, p.organization)
    if (!why) { people.push(p); continue }
    audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: peopleKey, status: why, results: 0 })
    recordContactRejection(db, tenantId, lead.id, { connector: ENRICH_APOLLO, reason: why, sourceUrl: src })
  }
  for (const p of people) addEnrichment(db, tenantId, lead.id, { connector: ENRICH_APOLLO, kind: 'contact', value: `${p.name}${p.title ? ` - ${p.title}` : ''}`.slice(0, 254), label: 'Apollo', confidence: 70, source_url: p.linkedin ?? src, source_date: today, retrieved_at: now })
  const out = people.length ? 'ok' : (found.length ? 'contact rejected: every candidate contradicted the company' : 'empty')
  auditSettleClaim(db, { ...peopleClaim, status: out, results: people.length }, pgate.id, out, people.length)
  return { kind: 'ran', n: people.length }
}

// maxProfiles caps the request size to the scan's remaining PDL profile budget: PDL charges 1 credit per profile
// RETURNED (adapter contract), so the size cap is the credit cap. Returns profiles ATTACHED; c.charged gets the
// number of profiles returned (the credits actually spent, including profiles the agreement check then rejects).
async function runPdl(c: Ctx, reservationId: string, key: string, maxProfiles: number, charged: { n: number }): Promise<number> {
  const { db, tenantId, jobId, lead, where, evidence, established, src, today, now, fetchImpl } = c
  const peopleKey = lookupKey('people', lead)
  let found: Awaited<ReturnType<typeof pdlPeopleSearch>>
  try { found = await pdlPeopleSearch(key, lead.company, fetchImpl, Math.max(1, maxProfiles)) }
  catch (e) { auditSettleClaim(db, { tenantId, connector: ENRICH_PDL, jobId, lookup: peopleKey, status: e instanceof EnrichError ? e.code : 'error', results: 0 }, reservationId, e instanceof EnrichError ? e.code : 'error', 0); throw e }
  charged.n += found.length
  // PDL matches on the company NAME only: each person's company must agree with the lead on its domain or place.
  const people = []
  for (const p of found) {
    const a = contactAgreement({ company_domain: lead.company_domain, where, evidence, domainEstablished: established }, { domain: p.domain, place: p.place, address: p.address })
    if (a.ok) people.push(p); else { audit(db, { tenantId, connector: ENRICH_PDL, jobId, lookup: peopleKey, status: a.reason, results: 0 }); recordContactRejection(db, tenantId, lead.id, { connector: ENRICH_PDL, reason: a.reason, sourceUrl: src }) }
  }
  for (const p of people) addEnrichment(db, tenantId, lead.id, { connector: ENRICH_PDL, kind: 'contact', value: `${p.name}${p.title ? ` - ${p.title}` : ''}`.slice(0, 254), label: 'People Data Labs', confidence: 70, source_url: p.linkedin ?? src, source_date: today, retrieved_at: now })
  auditSettleClaim(db, { tenantId, connector: ENRICH_PDL, jobId, lookup: peopleKey, status: people.length ? 'ok' : (found.length ? 'contact rejected: every candidate contradicted the company' : 'empty'), results: people.length }, reservationId, people.length ? 'ok' : (found.length ? 'contact rejected: every candidate contradicted the company' : 'empty'), people.length)
  return people.length
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
      const k = claimKeysFor(lead)
      const step = r.lookup === k.stepOrg ? 'org' : r.lookup === k.stepPeople ? 'people' : r.lookup === k.legacyPeople ? 'legacy' : null
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
export async function retryHeldEnrichment(db: Database.Database, tenantId: string, leadId: string, selector: { provider: Prov; step: HeldEnrichment['step'] }, deps: { fetchImpl?: typeof fetch; master?: Buffer } = {}): Promise<{ status: 'not_found' | 'nothing_held' | 'cost_unverified' } | { status: 'retried'; attached: number; releases: string[] }> {
  const lead = db.prepare('SELECT l.id, l.company, l.company_domain, l.scan_job_id FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(leadId, tenantId) as (LeadRow & { scan_job_id: string }) | undefined
  if (!lead) return { status: 'not_found' }
  const h = heldEnrichments(db, tenantId).find(h => h.leadId === leadId && h.provider === selector.provider && h.step === selector.step)
  if (!h) return { status: 'nothing_held' }
  if (!retryCostVerified(h.provider)) return { status: 'cost_unverified' } // checked BEFORE the claim is released: nothing moves
  const disclosure = h.provider === 'apollo' && h.step === 'people'
    ? 'owner retry: people search resumed on the saved org memo; Apollo documents this endpoint as 0 credits (cost confirmed by the operator for this account)'
    : 'owner retry: the earlier attempt could not prove its outcome; the lookup may be charged again'
  if (!releaseHeldClaim(db, { tenantId, connector: h.provider === 'apollo' ? ENRICH_APOLLO : ENRICH_PDL, jobId: h.jobId, lookup: h.lookup }, disclosure)) return { status: 'nothing_held' }
  const r = await enrichLeadContacts(db, tenantId, lead.scan_job_id, [{ id: lead.id, company: lead.company, company_domain: lead.company_domain }], { ...deps, only: h.provider })
  return { status: 'retried', attached: r.attached, releases: [`${h.provider} ${h.step}`] }
}
