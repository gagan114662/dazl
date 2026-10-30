// Decision-makers from SEC Form D filings (US, free, public). A company that raised money under Reg D names its
// executive officers, directors and promoters in the filing's "related persons" list - often the founder/CEO that the
// company's own site never lists. Gojiberry-class tools sell this as "founder contact"; here it is read straight from
// the filing the funding signal matched to the lead. That match is only a name heuristic, so the fetched filing's own
// primaryIssuer must also agree with the expected entity (missing or contradicting issuer -> nothing stored), and its stated city/state must agree with the lead's place: two different
// companies can share a name, so a name match alone never attaches anyone.
//
// Stored (when the filer is confirmed to be the lead's company) as 'person' enrichments ("First Last, Role") with the filing URL as source and labelled with the filing date:
// the list is as of the filing, not verified as current staff. No addresses are kept (the filing carries a business
// street address per person; dazl stores name and role only), no email is derived here, and nothing is emailed from it.
// Only sec.gov filing URLs are fetched. Kill switch: SEC_OFFICERS=0.
import type Database from 'better-sqlite3'
import { addEnrichment } from '../connectors/store.ts'
import { classifyEntityMatch } from '../signals/entity-match.ts'
import { addressAgreement, contactAgreement, formatPlace } from '../scan/contact-agreement.ts'
import { domainConfirmed } from '../signals/domain-basis.ts'

export const CONNECTOR = 'signals:sec-form-d'
export const MAX_OFFICERS = 4
export const CANDIDATE_KIND = 'sec_officer_candidate'     // quarantined people: never shown or counted as a person/contact
export const CONFIRMED_KIND = 'sec_filing_confirmed'       // an identity review confirmed that this filer (CIK) is this lead's company
const TIMEOUT = 8000
const EDGAR_UA = process.env.SEC_USER_AGENT || 'dazl/1.0 (contact: support@dazl.ai)'
// Executive Officer first: it is the buyer-like role. Promoters are often outside investors/entities, so they rank last.
const ROLE_ORDER = ['Executive Officer', 'Director', 'Promoter']

export interface FilingPerson { name: string; role: string }

const tag = (xml: string, name: string): string => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(xml)
  return m ? m[1].replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim() : ''
}
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (_, a, b) => a + b.toUpperCase())

// Pull people out of a Form D primary_doc.xml. A person needs BOTH a first and last name (entity "persons" such as a
// fund carry only a last name) and at least one relationship. The company-given clarification ("CEO", "Co-Founder")
// beats the generic relationship because it is what the ICP role words (rank.ts) can actually match.
// The issuer the filing itself names; '' when absent/malformed, which callers must treat as "identity unknown".
export function filingIssuer(xml: string): string {
  const block = /<primaryIssuer>[\s\S]*?<\/primaryIssuer>/i.exec(xml)
  return block ? tag(block[0], 'entityName').slice(0, 200) : ''
}

// Where the issuer says it is (Form D primaryIssuer/issuerAddress: city + state or country code); null when absent. A registry fact, so it can agree or conflict with the lead's place.
export function filingIssuerPlace(xml: string): { place: string | null; address: string | null; unit: string | null } {
  const block = /<primaryIssuer>[\s\S]*?<\/primaryIssuer>/i.exec(xml)?.[0] ?? ''
  const addr = /<issuerAddress>[\s\S]*?<\/issuerAddress>/i.exec(block)?.[0] ?? ''
  const city = tag(addr, 'city'), state = tag(addr, 'stateOrCountry'), street = tag(addr, 'street1'), street2 = tag(addr, 'street2')
  // The unit is kept: SEC carries it in street2 ("Suite 100"), or trailing street1. Two companies in one building are told apart by it.
  const unit = unitsIn(`${street2} ${street}`)[0] ?? null
  return { place: city && state ? formatPlace(city, state, null) : null, address: street && city ? [street, street2, city, state].filter(Boolean).join(', ').slice(0, 200) : null, unit }
}
// Normalised unit designators in a text: "Suite 100", "Ste. 100", "#100", "Unit 4B", "Floor 3" -> '100', '100', '100', '4b', 'floor 3'.
export function unitsIn(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/\b(?:suite|ste|unit|apt|apartment|room|rm)\.?\s*#?\s*([A-Za-z0-9-]{1,8})\b|#\s*([A-Za-z0-9-]{1,8})\b/gi)) out.add((m[1] ?? m[2]).toLowerCase())
  for (const m of text.matchAll(/\b(\d{1,3})(?:st|nd|rd|th)?\s+(?:floor|fl)\b|\b(?:floor|fl)\.?\s*(\d{1,3})\b/gi)) out.add(`floor ${m[1] ?? m[2]}`)
  return [...out]
}

export function parseRelatedPersons(xml: string): FilingPerson[] {
  const out: FilingPerson[] = []
  const seen = new Set<string>()
  for (const block of xml.match(/<relatedPersonInfo>[\s\S]*?<\/relatedPersonInfo>/gi) ?? []) {
    const first = tag(block, 'firstName'), last = tag(block, 'lastName')
    if (!first || !last || !/^[\p{L}][\p{L} .'’-]{0,39}$/u.test(first) || !/^[\p{L}][\p{L} .'’-]{0,39}$/u.test(last)) continue
    const rels = [...block.matchAll(/<relationship>([\s\S]*?)<\/relationship>/gi)].map(m => m[1].trim())
    if (rels.length === 0) continue
    const clar = tag(block, 'relationshipClarification')
    const best = ROLE_ORDER.find(r => rels.some(x => x.toLowerCase() === r.toLowerCase())) ?? rels[0]
    const role = clar && clar.length <= 60 ? clar : best
    const name = `${/^[A-Z]+$/.test(first) ? titleCase(first) : first} ${/^[A-Z]+$/.test(last) ? titleCase(last) : last}`
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name, role: `${role}${clar && clar !== best ? ` (${best})` : ''}`.slice(0, 80) })
  }
  const rank = (p: FilingPerson) => { const i = ROLE_ORDER.findIndex(r => p.role.includes(r)); return i === -1 ? 0 : i } // clarified titles sort first
  return out.sort((a, b) => rank(a) - rank(b)).slice(0, MAX_OFFICERS)
}

const isFilingUrl = (u: string) => /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d{18}\/[\w.-]+\.xml$/.test(u)

// What the lead is, for the identity check: its scan's geography, its own evidence text and its domain. null when the lead is not this tenant's.
function leadContext(db: Database.Database, tenantId: string, leadId: string): { company_domain: string | null; where: string[]; evidence: string } | null {
  try {
    const r = db.prepare('SELECT l.company_domain, l.evidence_excerpt, l.signal, j.icp FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(leadId, tenantId) as { company_domain: string | null; evidence_excerpt: string | null; signal: string | null; icp: string | null } | undefined
    if (!r) return null
    let where: string[] = []; try { const w = r.icp ? (JSON.parse(r.icp) as { where?: unknown }).where : null; if (Array.isArray(w)) where = w.filter((x): x is string => typeof x === 'string') } catch { where = [] }
    return { company_domain: r.company_domain, where, evidence: `${r.evidence_excerpt ?? ''} ${r.signal ?? ''}` }
  } catch { return null }
}

// Fetch the filing and attach its people to the lead ONLY on a confirmed identity binding (see below); otherwise quarantine them. Never throws; returns how many were ATTACHED.
export async function storeFilingOfficers(db: Database.Database, tenantId: string, leadId: string, filing: { url: string; date: string; entity: string }, deps: { fetchImpl?: typeof fetch; now?: number; env?: Record<string, string | undefined> } = {}): Promise<number> {
  try {
    if ((deps.env ?? process.env).SEC_OFFICERS === '0' || !isFilingUrl(filing.url)) return 0
    const res = await (deps.fetchImpl ?? fetch)(filing.url, { headers: { 'user-agent': EDGAR_UA, accept: 'application/xml, text/xml' }, signal: AbortSignal.timeout(TIMEOUT) })
    if (!res.ok) return 0
    const xml = (await res.text()).slice(0, 400_000)
    // Bind the people to the issuer the document names: a wrong URL or a same-name collision must not attach another
    // company's executives. Still a name heuristic (token-identical after suffix stripping), so labels stay "as of filing".
    const issuer = filingIssuer(xml)
    if (!issuer || classifyEntityMatch(filing.entity, issuer) !== 'heuristic') return 0
    // A name match - even with the same city, even with the same street - is not identity: two companies can share a name, a city and a building. People are ATTACHED only when an
    // identity review confirmed this filer (CIK) as this lead's company (confirmFilingIdentity). A matching street is CORROBORATION, not identity. A known DIFFERENT street address is a
    // known different entity: nothing is stored. Everything else that agrees on place is QUARANTINED - unattached, unranked candidates (kind sec_officer_candidate) with the reason: a unit
    // that DIFFERS (same building, different suite), a shared building with no unit to compare, a street match, or only the name and city.
    const ctx = leadContext(db, tenantId, leadId)
    if (!ctx) return 0
    const at = filingIssuerPlace(xml)
    const agree = contactAgreement({ company_domain: ctx.company_domain, where: ctx.where, evidence: ctx.evidence }, { place: at.place, address: at.address })
    if (!agree.ok || (agree.via !== 'location' && agree.via !== 'address' && agree.via !== 'domain')) return 0
    const street = addressAgreement(at.address, ctx.evidence)
    if (street === 'conflict') return 0
    const leadUnits = unitsIn(ctx.evidence)
    const note = street === 'agrees'
      ? (at.unit && leadUnits.length && !leadUnits.includes(at.unit) ? `same building, different unit (filing ${at.unit} vs lead ${leadUnits.join('/')})` : !at.unit || !leadUnits.length ? 'same street, unit not stated on both sides (shared-building ambiguity)' : 'street and unit match (corroboration only)')
      : 'same name and city only'
    const bound = filingConfirmed(db, tenantId, leadId, filing.url)
    const now = Math.floor((deps.now ?? Date.now()) / 1000)
    let n = 0
    for (const p of parseRelatedPersons(xml)) {
      if (bound) { addEnrichment(db, tenantId, leadId, { connector: CONNECTOR, kind: 'person', value: `${p.name}, ${p.role}`.slice(0, 120), label: `named in SEC Form D filed ${filing.date} (as of filing, not verified as current)`.slice(0, 200), confidence: 60, source_url: filing.url, source_date: filing.date, retrieved_at: now }); n++ }
      else addEnrichment(db, tenantId, leadId, { connector: CONNECTOR, kind: CANDIDATE_KIND, value: `${p.name}, ${p.role}`.slice(0, 120), label: `quarantined: ${note}; not confirmed as this company - needs identity review (SEC Form D filed ${filing.date})`.slice(0, 200), confidence: null, source_url: filing.url, source_date: filing.date, retrieved_at: now })
    }
    return n
  } catch { return 0 }
}

const cikOf = (url: string) => /\/edgar\/data\/(\d+)\//.exec(url)?.[1] ?? null
function filingConfirmed(db: Database.Database, tenantId: string, leadId: string, url: string): boolean {
  const cik = cikOf(url); if (!cik) return false
  try { return !!db.prepare("SELECT 1 FROM lead_enrichments WHERE tenant_id = ? AND lead_id = ? AND kind = ? AND value = ?").get(tenantId, leadId, CONFIRMED_KIND, cik) } catch { return false }
}
// The identity-review action: the reviewer confirmed that the filer with this CIK IS this lead's company. Records the confirmation (tenant- and lead-scoped) and promotes this filer's
// quarantined candidates to people. Returns how many were promoted. Without this nothing quarantined ever becomes a person.
export function confirmFilingIdentity(db: Database.Database, tenantId: string, leadId: string, cik: string, o: { domain?: string; now?: number } = {}): number {
  const now = o.now ?? Math.floor(Date.now() / 1000)
  if (!/^\d{1,10}$/.test(cik)) return 0
  const owned = db.prepare('SELECT l.company_domain FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(leadId, tenantId) as { company_domain: string | null } | undefined
  if (!owned) return 0
  // A reviewer may bind the filer by the lead's CONFIRMED company domain as well as by the CIK: the domain they name must be the lead's own and confirmed, or nothing is recorded.
  if (o.domain !== undefined) {
    const d = o.domain.trim().toLowerCase().replace(/^www\./, '')
    if (!d || (owned.company_domain ?? '').trim().toLowerCase().replace(/^www\./, '') !== d || !domainConfirmed(db, tenantId, leadId, d)) return 0
  }
  addEnrichment(db, tenantId, leadId, { connector: 'user', kind: CONFIRMED_KIND, value: cik, label: (o.domain ? 'identity review: this SEC filer is this company (bound by CIK and the lead\'s confirmed domain)' : 'identity review: this SEC filer is this company (bound by CIK)'), confidence: null, source_url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`, source_date: new Date(now * 1000).toISOString().slice(0, 10), retrieved_at: now })
  const rows = db.prepare("SELECT value, source_url, source_date FROM lead_enrichments WHERE tenant_id = ? AND lead_id = ? AND connector = ? AND kind = ?").all(tenantId, leadId, CONNECTOR, CANDIDATE_KIND) as { value: string; source_url: string; source_date: string }[]
  let n = 0
  for (const r of rows) {
    if (cikOf(r.source_url) !== cik) continue
    addEnrichment(db, tenantId, leadId, { connector: CONNECTOR, kind: 'person', value: r.value, label: `named in SEC Form D filed ${r.source_date} (as of filing, not verified as current; identity confirmed by review)`.slice(0, 200), confidence: 60, source_url: r.source_url, source_date: r.source_date, retrieved_at: now })
    db.prepare("DELETE FROM lead_enrichments WHERE tenant_id = ? AND lead_id = ? AND connector = ? AND kind = ? AND value = ? AND source_url = ?").run(tenantId, leadId, CONNECTOR, CANDIDATE_KIND, r.value, r.source_url)
    n++
  }
  return n
}
