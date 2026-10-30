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
export function filingIssuerPlace(xml: string): { place: string | null; address: string | null } {
  const block = /<primaryIssuer>[\s\S]*?<\/primaryIssuer>/i.exec(xml)?.[0] ?? ''
  const addr = /<issuerAddress>[\s\S]*?<\/issuerAddress>/i.exec(block)?.[0] ?? ''
  const city = tag(addr, 'city'), state = tag(addr, 'stateOrCountry'), street = tag(addr, 'street1')
  return { place: city && state ? formatPlace(city, state, null) : null, address: street && city ? [street, city, state].filter(Boolean).join(', ').slice(0, 160) : null }
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
    // A name match - even with the same city - is not identity: two different companies can share a name and a city. People are ATTACHED only on a confirmed binding:
    //   (1) the issuer's stated STREET address is the lead's own known street address (a registry fact against the lead's evidence), or
    //   (2) a recorded identity review confirmed this filer's CIK for this lead (confirmFilingIdentity).
    // A known street address that DIFFERS is a known different entity: nothing is stored. A same-city name match with no binding is QUARANTINED - kept as unattached candidates
    // (kind sec_officer_candidate, never counted as contacts or people) for identity review. No stated address / no geography to compare / a conflicting place: nothing.
    const ctx = leadContext(db, tenantId, leadId)
    if (!ctx) return 0
    const at = filingIssuerPlace(xml)
    const agree = contactAgreement({ company_domain: ctx.company_domain, where: ctx.where, evidence: ctx.evidence }, { place: at.place, address: at.address })
    if (!agree.ok || (agree.via !== 'location' && agree.via !== 'address' && agree.via !== 'domain')) return 0
    if (addressAgreement(at.address, ctx.evidence) === 'conflict') return 0
    const bound = addressAgreement(at.address, ctx.evidence) === 'agrees' || filingConfirmed(db, tenantId, leadId, filing.url)
    const now = Math.floor((deps.now ?? Date.now()) / 1000)
    let n = 0
    for (const p of parseRelatedPersons(xml)) {
      if (bound) { addEnrichment(db, tenantId, leadId, { connector: CONNECTOR, kind: 'person', value: `${p.name}, ${p.role}`.slice(0, 120), label: `named in SEC Form D filed ${filing.date} (as of filing, not verified as current)`.slice(0, 200), confidence: 60, source_url: filing.url, source_date: filing.date, retrieved_at: now }); n++ }
      else addEnrichment(db, tenantId, leadId, { connector: CONNECTOR, kind: CANDIDATE_KIND, value: `${p.name}, ${p.role}`.slice(0, 120), label: `quarantined: same name, not confirmed as this company - needs identity review (SEC Form D filed ${filing.date})`.slice(0, 200), confidence: null, source_url: filing.url, source_date: filing.date, retrieved_at: now })
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
export function confirmFilingIdentity(db: Database.Database, tenantId: string, leadId: string, cik: string, now = Math.floor(Date.now() / 1000)): number {
  if (!/^\d{1,10}$/.test(cik)) return 0
  const owned = db.prepare('SELECT 1 FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(leadId, tenantId)
  if (!owned) return 0
  addEnrichment(db, tenantId, leadId, { connector: 'user', kind: CONFIRMED_KIND, value: cik, label: 'identity review: this SEC filer is this company', confidence: null, source_url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`, source_date: new Date(now * 1000).toISOString().slice(0, 10), retrieved_at: now })
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
