// BYOK contact/firmographic enrichment in the scan waterfall. Runs only with the tenant's own keys
// (Settings > Enrichment). Each configured provider is loaded independently and tried in order (Apollo, then PDL):
// the next provider is tried when the previous one finds nothing usable (empty, rejected as a different company,
// rate-limited, timed out, upstream error or a bad key). Per-pass circuit breaker per provider, per-tenant call budget
// (an exhausted budget is a visible audit row, never a silent skip), no repeat charge for a lookup this job already made.
// Every call is audit-rowed; a failure never ends the whole pass (a bonus, never the bar).
import type Database from 'better-sqlite3'
import { addEnrichment, audit, getEnabledCredential } from '../connectors/store.ts'
import { apolloOrgEnrich, apolloPeopleSearch, EnrichError } from './apollo.ts'
import { pdlPeopleSearch } from './pdl.ts'
import { getMasterKey } from '../secrets.ts'
import { domainRelationship } from '../signals/domain-basis.ts'
import { buyerRoleQuery, classifyPerson, roleLabel } from './buyer-role.ts'
import { contactAgreement, organizationContradicts, recordContactRejection } from '../scan/contact-agreement.ts'

export const ENRICH_APOLLO = 'enrich:apollo'
export const ENRICH_PDL = 'enrich:pdl'
const MAX_LEADS = 5 // credit discipline: at most 5 org enrich calls (1 credit each) per scan
const MAX_CONTACTS = 5 // people search is 0-credit on Apollo; PDL charges per profile

interface LeadRow { id: string; company: string; company_domain: string | null }

// The scan's geography (ICP "where"): what a candidate record must agree with when the company's domain does not settle it.
function scanWhere(db: Database.Database, jobId: string): string[] {
  try { const r = db.prepare('SELECT icp FROM scan_jobs WHERE id = ?').get(jobId) as { icp: string | null } | undefined; const w = r?.icp ? (JSON.parse(r.icp) as { where?: unknown }).where : null; return Array.isArray(w) ? w.filter((x): x is string => typeof x === 'string') : [] } catch { return [] }
}
function scanWho(db: Database.Database, jobId: string): string[] {
  try { const r = db.prepare('SELECT icp FROM scan_jobs WHERE id = ?').get(jobId) as { icp: string | null } | undefined; const w = r?.icp ? (JSON.parse(r.icp) as { who?: unknown }).who : null; return Array.isArray(w) ? w.filter((x): x is string => typeof x === 'string') : [] } catch { return [] }
}
const domainOf = (u: string | null | undefined) => /^[a-z]+:\/\/([^/?#]+)/i.exec(u ?? '')?.[1]?.replace(/^www\./, '') || null

export const MAX_FAILS = 3          // transient failures that open a provider's circuit for the rest of the pass
export const APOLLO_CALLS = MAX_LEADS * 2   // org + people lookups per scan
export const PDL_CALLS = MAX_LEADS          // people lookups per scan (PDL charges per profile)
type Prov = 'apollo' | 'pdl'
export interface EnrichSummary { attached: number; byProvider: Record<Prov, number>; skipped: { provider: Prov; why: 'circuit_open' | 'budget_exhausted' | 'replayed' | 'not_configured' }[] }

export async function enrichLeadContacts(
  db: Database.Database,
  tenantId: string,
  jobId: string,
  leads: LeadRow[],
  deps: { fetchImpl?: typeof fetch; master?: Buffer; budget?: Partial<Record<Prov, number>> } = {},
): Promise<EnrichSummary> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const master = deps.master ?? getMasterKey()
  // Independent loads: a missing or failing Apollo key never hides a configured PDL key.
  const keys: Record<Prov, string | null> = { apollo: getEnabledCredential(db, tenantId, ENRICH_APOLLO, master), pdl: getEnabledCredential(db, tenantId, ENRICH_PDL, master) }
  const summary: EnrichSummary = { attached: 0, byProvider: { apollo: 0, pdl: 0 }, skipped: [] }
  if (!keys.apollo && !keys.pdl) return summary
  const now = Math.floor(Date.now() / 1000)
  const today = new Date().toISOString().slice(0, 10)
  const where = scanWhere(db, jobId)
  const who = scanWho(db, jobId)
  const connector: Record<Prov, string> = { apollo: ENRICH_APOLLO, pdl: ENRICH_PDL }
  const budget: Record<Prov, number> = { apollo: deps.budget?.apollo ?? APOLLO_CALLS, pdl: deps.budget?.pdl ?? PDL_CALLS }
  const used: Record<Prov, number> = { apollo: 0, pdl: 0 }, fails: Record<Prov, number> = { apollo: 0, pdl: 0 }, open: Record<Prov, boolean> = { apollo: false, pdl: false }
  const told = new Set<string>()
  const skip = (prov: Prov, why: EnrichSummary['skipped'][number]['why'], lead: LeadRow) => {
    summary.skipped.push({ provider: prov, why })
    // visible once per provider and reason per pass
    const k = `${prov}:${why}`; if (!told.has(k) && why !== 'replayed') { told.add(k); audit(db, { tenantId, connector: connector[prov], jobId, lookup: `people ${lead.company}`.slice(0, 200), status: why, results: 0 }) }
  }
  // A lookup this job already made (a replayed or resumed job) is not paid for again: its audit row says what it found.
  const priorLookup = (prov: Prov, lead: LeadRow): 'ok' | 'empty' | null => {
    try { const r = db.prepare("SELECT status FROM connector_audit WHERE tenant_id = ? AND connector = ? AND scan_job_id = ? AND lookup = ? AND status IN ('ok','empty') ORDER BY created_at DESC LIMIT 1").get(tenantId, connector[prov], jobId, `people ${lead.company}`.slice(0, 200)) as { status: 'ok' | 'empty' } | undefined; return r?.status ?? null } catch { return null }
  }
  const failed = (prov: Prov, e: unknown) => {
    const code = e instanceof EnrichError ? e.code : 'error'
    if (code === 'auth') open[prov] = true                    // a bad key stops THAT provider for the pass, not the pass
    else if (++fails[prov] >= MAX_FAILS) open[prov] = true    // repeated transient failures open the circuit
  }

  // The bounded credits go to the highest-priority leads (verified confidence, then intent), not to whichever came first.
  const priority = (l: LeadRow) => { try { const r = db.prepare('SELECT confidence, intent FROM leads WHERE id = ?').get(l.id) as { confidence: number | null; intent: number | null } | undefined; return (r?.confidence ?? 0) * 1000 + (r?.intent ?? 0) } catch { return 0 } }
  const ordered = leads.map((l, i) => ({ l, i, p: priority(l) })).sort((a, b) => b.p - a.p || a.i - b.i).map(x => x.l)
  for (const lead of ordered.slice(0, MAX_LEADS)) {
    // the lead's OWN evidence (its quote and signal): a street address in it is an agreement basis for the record found by name
    const evidence = (() => { try { const r = db.prepare('SELECT evidence_excerpt, signal FROM leads WHERE id = ?').get(lead.id) as { evidence_excerpt: string | null; signal: string | null } | undefined; return `${r?.evidence_excerpt ?? ''} ${r?.signal ?? ''}` } catch { return '' } })()
    // Only a domain the cited page is hosted on, or one the user confirmed, stands over a conflicting place; a guessed or legacy domain does not.
    let established = false
    try { established = domainRelationship(db, tenantId, lead.id, lead.company_domain) === 'established' } catch { established = false }
    const src = lead.company_domain ? `https://${lead.company_domain}` : `https://www.linkedin.com/company/${encodeURIComponent(lead.company.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}`
    const ctx = { db, tenantId, jobId, lead, where, who, evidence, established, src, today, now, fetchImpl }
    for (const prov of ['apollo', 'pdl'] as Prov[]) {
      if (!keys[prov]) continue
      if (open[prov]) { skip(prov, 'circuit_open', lead); continue }
      const prior = priorLookup(prov, lead)
      if (prior === 'ok') { skip(prov, 'replayed', lead); break }       // already found for this lead in this job
      if (prior === 'empty') { skip(prov, 'replayed', lead); continue } // already known empty: do not pay again, try the next provider
      if (used[prov] >= budget[prov]) { skip(prov, 'budget_exhausted', lead); continue }
      used[prov]++
      let n = 0
      try { n = prov === 'apollo' ? await runApollo(ctx, keys.apollo!) : await runPdl(ctx, keys.pdl!) } catch (e) { failed(prov, e); continue }
      summary.byProvider[prov] += n; summary.attached += n
      if (n > 0) break      // a verified candidate: the next provider is not needed (and is not charged)
    }
  }
  return summary
}

interface Ctx { db: Database.Database; tenantId: string; jobId: string; lead: LeadRow; where: string[]; who: string[]; evidence: string; established: boolean; src: string; today: string; now: number; fetchImpl: typeof fetch }

const roleQ = (who: string[]) => { const q = buyerRoleQuery(who); return q.titles.length ? q : undefined }
// With a reviewed persona, each returned person is classified: the buyer-role match and an owner-level alternate are attached (labelled as a title match, not as
// decision authority, and as provider-reported-current or search-result-only); a former employee, an assistant-to, a nameless/generic entry is recorded as rejected.
// Without a persona nothing is classified and behaviour is unchanged.
function attachByRole(c: Ctx, connector: string, label: string, people: { name: string; title: string | null; linkedin?: string | null; organization?: { name: string | null; domain: string | null } | null }[]): number {
  const { db, tenantId, jobId, lead, who, src, today, now } = c
  let n = 0
  for (const p of people) {
    let tag = label
    if (who.length) {
      const v = classifyPerson(p, who)
      if (v.match === 'rejected') { audit(db, { tenantId, connector, jobId, lookup: `people ${lead.company}`.slice(0, 200), status: `contact rejected: ${v.reason}`.slice(0, 200), results: 0 }); recordContactRejection(db, tenantId, lead.id, { connector, reason: `contact rejected: ${v.reason}`, sourceUrl: src }); continue }
      tag = roleLabel(label, v)
    }
    addEnrichment(db, tenantId, lead.id, { connector, kind: 'contact', value: `${p.name}${p.title ? ` - ${p.title}` : ''}`.slice(0, 254), label: tag.slice(0, 200), confidence: 70, source_url: p.linkedin ?? src, source_date: today, retrieved_at: now })
    n++
  }
  return n
}

// One provider's attempt for one lead. Returns how many contacts were ATTACHED (after the company/place/domain agreement checks); throws on a provider failure so the waterfall can count it.
async function runApollo(c: Ctx, key: string): Promise<number> {
  const { db, tenantId, jobId, lead, where, who, evidence, established, src, today, now, fetchImpl } = c
  let org: Awaited<ReturnType<typeof apolloOrgEnrich>> = null
  let orgFailure: unknown = null
  try {
    org = await apolloOrgEnrich(key, { domain: lead.company_domain, name: lead.company }, fetchImpl)
    // A same-name company elsewhere (Pico Rivera, CA for a New York lead) is not attached: the record must agree on the domain or the place.
    const agree = org ? contactAgreement({ company_domain: lead.company_domain, where, evidence, domainEstablished: established }, { domain: domainOf(org.website), place: org.place, address: org.address, keyedOnLeadDomain: !!lead.company_domain }) : null
    if (org && agree && !agree.ok) { audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: `org ${lead.company}`.slice(0, 200), status: agree.reason, results: 0 }); recordContactRejection(db, tenantId, lead.id, { connector: ENRICH_APOLLO, reason: agree.reason, sourceUrl: org.website ?? src }); return 0 }
    if (org && (org.employees || org.industry)) {
      const bits = [org.employees ? `${org.employees} employees` : null, org.industry, org.founded ? `founded ${org.founded}` : null].filter(Boolean).join(' · ')
      addEnrichment(db, tenantId, lead.id, { connector: ENRICH_APOLLO, kind: 'firmographic', value: bits.slice(0, 254), label: org.name, confidence: 75, source_url: org.linkedin ?? org.website ?? src, source_date: today, retrieved_at: now })
    }
    audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: `org ${lead.company}`, status: org ? 'ok' : 'empty', results: org ? 1 : 0 })
  } catch (e) {
    audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: `org ${lead.company}`, status: e instanceof EnrichError ? e.code : 'error', results: 0 })
    if (e instanceof EnrichError && e.code === 'auth') throw e    // the key is bad: no point asking Apollo for people
    orgFailure = e    // any other org failure: still try the people search below (the domain may already be known); if it cannot run, this failure is the provider's
  }
  try {
    // The org lookup above often discovers the domain even when the lead had none - search people by that domain (much more reliable than a raw company name).
    const orgDomain = lead.company_domain ?? (/^[a-z]+:\/\/([^/?#]+)/i.exec(org?.website ?? '')?.[1]?.replace(/^www\./, '') || null)
    if (!orgDomain) { audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: `people ${lead.company}`.slice(0, 200), status: 'contact rejected: no domain to confirm the company', results: 0 }); recordContactRejection(db, tenantId, lead.id, { connector: ENRICH_APOLLO, reason: 'contact rejected: no domain to confirm the company', sourceUrl: src }); if (orgFailure) throw orgFailure; return 0 }
    const found = await apolloPeopleSearch(key, { domain: orgDomain, name: lead.company }, fetchImpl, MAX_CONTACTS, roleQ(who))
    // A person whose own organization contradicts the requested company (another name, another domain) is not attached.
    const people = []
    for (const p of found) {
      const why = organizationContradicts(lead.company, orgDomain, p.organization)
      if (!why) { people.push(p); continue }
      audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: `people ${lead.company}`.slice(0, 200), status: why, results: 0 })
      recordContactRejection(db, tenantId, lead.id, { connector: ENRICH_APOLLO, reason: why, sourceUrl: src })
    }
    const kept = attachByRole(c, ENRICH_APOLLO, 'Apollo', people)
    audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: `people ${lead.company}`, status: kept ? 'ok' : 'empty', results: kept })
    return kept
  } catch (e) {
    audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: `people ${lead.company}`, status: e instanceof EnrichError ? e.code : 'error', results: 0 })
    throw e
  }
}

async function runPdl(c: Ctx, key: string): Promise<number> {
  const { db, tenantId, jobId, lead, where, who, evidence, established, src, today, now, fetchImpl } = c
  try {
    const found = await pdlPeopleSearch(key, lead.company, fetchImpl, MAX_CONTACTS, roleQ(who))
    // PDL matches on the company NAME only: each person's company must agree with the lead on its domain or place.
    const people = []
    for (const p of found) {
      const a = contactAgreement({ company_domain: lead.company_domain, where, evidence, domainEstablished: established }, { domain: p.domain, place: p.place, address: p.address })
      if (a.ok) people.push(p); else { audit(db, { tenantId, connector: ENRICH_PDL, jobId, lookup: `people ${lead.company}`.slice(0, 200), status: a.reason, results: 0 }); recordContactRejection(db, tenantId, lead.id, { connector: ENRICH_PDL, reason: a.reason, sourceUrl: src }) }
    }
    const kept = attachByRole(c, ENRICH_PDL, 'People Data Labs', people)
    audit(db, { tenantId, connector: ENRICH_PDL, jobId, lookup: `people ${lead.company}`, status: kept ? 'ok' : 'empty', results: kept })
    return kept
  } catch (e) {
    audit(db, { tenantId, connector: ENRICH_PDL, jobId, lookup: `people ${lead.company}`, status: e instanceof EnrichError ? e.code : 'error', results: 0 })
    throw e
  }
}
