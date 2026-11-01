// BYOK contact/firmographic enrichment in the scan waterfall. Runs only with the tenant's own keys
// (Settings > Enrichment). Each configured provider is loaded independently and tried in order (Apollo, then PDL):
// the next provider is tried when the previous one finds nothing usable (empty, rejected as a different company,
// rate-limited, timed out, upstream error or a bad key). Per-pass circuit breaker per provider, per-tenant call budget
// (an exhausted budget is a visible audit row, never a silent skip), no repeat charge for a lookup this job already made.
// Every call is audit-rowed; a failure never ends the whole pass (a bonus, never the bar).
import type Database from 'better-sqlite3'
import { addEnrichment, audit, auditSettle, auditTryReserve, enrichFallbackEnabled, getEnabledCredential } from '../connectors/store.ts'
import { apolloOrgEnrich, apolloPeopleSearch, EnrichError } from './apollo.ts'
import { pdlPeopleSearch } from './pdl.ts'
import { getMasterKey } from '../secrets.ts'
import { domainRelationship } from '../signals/domain-basis.ts'
import { contactAgreement, organizationContradicts, recordContactRejection } from '../scan/contact-agreement.ts'

export const ENRICH_APOLLO = 'enrich:apollo'
export const ENRICH_PDL = 'enrich:pdl'
const MAX_LEADS = 5 // credit discipline: at most 5 org enrich calls (1 credit each) per scan
const MAX_CONTACTS = 5 // people search is 0-credit on Apollo; PDL charges per profile

interface LeadRow { id: string; company: string; company_domain: string | null }

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
  deps: { fetchImpl?: typeof fetch; master?: Buffer; budget?: Partial<Record<Prov, number>> } = {},
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
  // Durable replay identity: tenant + job + provider + the company's DOMAIN when known, else the lead's own id.
  // A bare company name is not an identity: two same-name leads with no domain must never share one memo (one
  // would silence the other), and a replayed job must never pay for the same lead's lookup twice.
  const lookupKey = (kind: 'org' | 'people', lead: LeadRow) => `${kind} ${lead.company} (${lead.company_domain ? lead.company_domain : `lead:${lead.id}`})`.slice(0, 200)
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
    const ctx = { db, tenantId, jobId, lead, where, evidence, established, src, today, now, fetchImpl, lookupKey }
    for (const prov of ['apollo', 'pdl'] as Prov[]) {
      if (!keys[prov]) continue
      if (open[prov]) { skip(prov, 'circuit_open', lead); continue }
      if (used[prov] >= budget[prov]) { skip(prov, 'budget_exhausted', lead); continue }
      // ATOMIC durable reservation (#382): one guarded insert claims this lookup for the job BEFORE any paid call.
      // A replayed or double-run job (stale-lease reap, resume, concurrent caller) loses the race and reads the
      // winner's outcome instead of paying again; a stale 'reserved' row proves a possible charge and fails CLOSED.
      // The single row covers the provider's WHOLE attempt (Apollo's org + people calls), so a crash anywhere in
      // the attempt - including mid-org-call - is replay-safe.
      const gate = auditTryReserve(db, { tenantId, connector: connector[prov], jobId, lookup: lookupKey('people', lead), status: 'reserved', results: 0 })
      if ('prior' in gate) {
        if (gate.prior === 'ok') { skip(prov, 'replayed', lead); break }            // already found for this lead in this job
        if (gate.prior === 'empty' || gate.prior === 'rejected') { skip(prov, 'replayed', lead); continue } // known empty/terminally rejected: do not pay again, try the next provider
        skip(prov, 'uncertain', lead); break                                       // a crashed pass may have paid: fail closed, never pay twice
      }
      let n = 0
      try {
        if (prov === 'apollo') { used.apollo += 2; n = await runApollo({ ...ctx, reservationId: gate.id }, keys.apollo!) } // an attempt costs up to 2 calls (org 1 credit + people 0-credit); reserve the budget before spending it
        else { const charged = { n: 0 }; n = await runPdl({ ...ctx, reservationId: gate.id }, keys.pdl!, Math.min(MAX_CONTACTS, budget.pdl - used.pdl), charged); used.pdl += charged.n }
      } catch (e) { failed(prov, e); continue }
      summary.byProvider[prov] += n; summary.attached += n
      if (n > 0) break      // a verified candidate: the next provider is not needed (and is not charged)
    }
  }
  return summary
}

interface Ctx { db: Database.Database; tenantId: string; jobId: string; lead: LeadRow; where: string[]; evidence: string; established: boolean; src: string; today: string; now: number; fetchImpl: typeof fetch; lookupKey: (kind: 'org' | 'people', lead: LeadRow) => string; reservationId: string }

// One provider's attempt for one lead. Returns how many contacts were ATTACHED (after the company/place/domain agreement checks); throws on a provider failure so the waterfall can count it.
async function runApollo(c: Ctx, key: string): Promise<number> {
  const { db, tenantId, jobId, lead, where, evidence, established, src, today, now, fetchImpl, lookupKey, reservationId } = c
  let org: Awaited<ReturnType<typeof apolloOrgEnrich>> = null
  let orgFailure: unknown = null
  const orgKey = lookupKey('org', lead), peopleKey = lookupKey('people', lead)
  // c.reservationId is the atomically-claimed gate row for this lead's whole Apollo attempt: every terminal
  // outcome settles THAT row, so a crash anywhere (mid-org-call included) replays fail-closed with zero new calls.
  try {
    org = await apolloOrgEnrich(key, { domain: lead.company_domain, name: lead.company }, fetchImpl)
    // A same-name company elsewhere (Pico Rivera, CA for a New York lead) is not attached: the record must agree on the domain or the place.
    const agree = org ? contactAgreement({ company_domain: lead.company_domain, where, evidence, domainEstablished: established }, { domain: domainOf(org.website), place: org.place, address: org.address, keyedOnLeadDomain: !!lead.company_domain }) : null
    if (org && agree && !agree.ok) { auditSettle(db, reservationId, agree.reason, 0); recordContactRejection(db, tenantId, lead.id, { connector: ENRICH_APOLLO, reason: agree.reason, sourceUrl: org.website ?? src }); return 0 }
    if (org && (org.employees || org.industry)) {
      const bits = [org.employees ? `${org.employees} employees` : null, org.industry, org.founded ? `founded ${org.founded}` : null].filter(Boolean).join(' · ')
      addEnrichment(db, tenantId, lead.id, { connector: ENRICH_APOLLO, kind: 'firmographic', value: bits.slice(0, 254), label: org.name, confidence: 75, source_url: org.linkedin ?? org.website ?? src, source_date: today, retrieved_at: now })
    }
    audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: orgKey, status: org ? 'ok' : 'empty', results: org ? 1 : 0 }) // org observability row; the gate row carries the replay contract
  } catch (e) {
    const code = e instanceof EnrichError ? e.code : 'error'
    if (e instanceof EnrichError && e.code === 'auth') { auditSettle(db, reservationId, code, 0); throw e } // the key is bad: no point asking Apollo for people
    audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: orgKey, status: code, results: 0 })
    orgFailure = e    // any other org failure: still try the people search below (the domain may already be known); if it cannot run, this failure is the provider's
  }
  // The org lookup above often discovers the domain even when the lead had none - search people by that domain (much more reliable than a raw company name).
  const orgDomain = lead.company_domain ?? (/^[a-z]+:\/\/([^/?#]+)/i.exec(org?.website ?? '')?.[1]?.replace(/^www\./, '') || null)
  if (!orgDomain) { auditSettle(db, reservationId, 'contact rejected: no domain to confirm the company', 0); recordContactRejection(db, tenantId, lead.id, { connector: ENRICH_APOLLO, reason: 'contact rejected: no domain to confirm the company', sourceUrl: src }); if (orgFailure) throw orgFailure; return 0 }
  let found: Awaited<ReturnType<typeof apolloPeopleSearch>>
  try { found = await apolloPeopleSearch(key, { domain: orgDomain, name: lead.company }, fetchImpl, MAX_CONTACTS) }
  catch (e) { auditSettle(db, reservationId, e instanceof EnrichError ? e.code : 'error', 0); throw e }
  // A person whose own organization contradicts the requested company (another name, another domain) is not attached.
  const people = []
  for (const p of found) {
    const why = organizationContradicts(lead.company, orgDomain, p.organization)
    if (!why) { people.push(p); continue }
    audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: peopleKey, status: why, results: 0 })
    recordContactRejection(db, tenantId, lead.id, { connector: ENRICH_APOLLO, reason: why, sourceUrl: src })
  }
  for (const p of people) addEnrichment(db, tenantId, lead.id, { connector: ENRICH_APOLLO, kind: 'contact', value: `${p.name}${p.title ? ` - ${p.title}` : ''}`.slice(0, 254), label: 'Apollo', confidence: 70, source_url: p.linkedin ?? src, source_date: today, retrieved_at: now })
  auditSettle(db, reservationId, people.length ? 'ok' : (found.length ? 'contact rejected: every candidate contradicted the company' : 'empty'), people.length)
  return people.length
}

// maxProfiles caps the request size to the scan's remaining PDL profile budget: PDL charges 1 credit per profile
// RETURNED (adapter contract), so the size cap is the credit cap. Returns profiles ATTACHED; c.charged gets the
// number of profiles returned (the credits actually spent, including profiles the agreement check then rejects).
async function runPdl(c: Ctx, key: string, maxProfiles: number, charged: { n: number }): Promise<number> {
  const { db, tenantId, jobId, lead, where, evidence, established, src, today, now, fetchImpl, lookupKey, reservationId } = c
  const peopleKey = lookupKey('people', lead)
  let found: Awaited<ReturnType<typeof pdlPeopleSearch>>
  try { found = await pdlPeopleSearch(key, lead.company, fetchImpl, Math.max(1, maxProfiles)) }
  catch (e) { auditSettle(db, reservationId, e instanceof EnrichError ? e.code : 'error', 0); throw e }
  charged.n += found.length
  // PDL matches on the company NAME only: each person's company must agree with the lead on its domain or place.
  const people = []
  for (const p of found) {
    const a = contactAgreement({ company_domain: lead.company_domain, where, evidence, domainEstablished: established }, { domain: p.domain, place: p.place, address: p.address })
    if (a.ok) people.push(p); else { audit(db, { tenantId, connector: ENRICH_PDL, jobId, lookup: peopleKey, status: a.reason, results: 0 }); recordContactRejection(db, tenantId, lead.id, { connector: ENRICH_PDL, reason: a.reason, sourceUrl: src }) }
  }
  for (const p of people) addEnrichment(db, tenantId, lead.id, { connector: ENRICH_PDL, kind: 'contact', value: `${p.name}${p.title ? ` - ${p.title}` : ''}`.slice(0, 254), label: 'People Data Labs', confidence: 70, source_url: p.linkedin ?? src, source_date: today, retrieved_at: now })
  auditSettle(db, reservationId, people.length ? 'ok' : (found.length ? 'contact rejected: every candidate contradicted the company' : 'empty'), people.length)
  return people.length
}
