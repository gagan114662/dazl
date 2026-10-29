// Decision-makers from SEC Form D filings (US, free, public). A company that raised money under Reg D names its
// executive officers, directors and promoters in the filing's "related persons" list - often the founder/CEO that the
// company's own site never lists. Gojiberry-class tools sell this as "founder contact"; here it is read straight from
// the filing the funding signal matched to the lead. That match is only a name heuristic, so the fetched filing's own
// primaryIssuer must also agree with the expected entity (missing or contradicting issuer -> nothing stored).
//
// Stored as 'person' enrichments ("First Last, Role") with the filing URL as source and labelled with the filing date:
// the list is as of the filing, not verified as current staff. No addresses are kept (the filing carries a business
// street address per person; dazl stores name and role only), no email is derived here, and nothing is emailed from it.
// Only sec.gov filing URLs are fetched. Kill switch: SEC_OFFICERS=0.
import type Database from 'better-sqlite3'
import { addEnrichment } from '../connectors/store.ts'
import { classifyEntityMatch } from '../signals/entity-match.ts'

export const CONNECTOR = 'signals:sec-form-d'
export const MAX_OFFICERS = 4
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

// Fetch the filing and store its people on the lead. Never throws; returns how many were stored.
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
    const now = Math.floor((deps.now ?? Date.now()) / 1000)
    let n = 0
    for (const p of parseRelatedPersons(xml)) {
      addEnrichment(db, tenantId, leadId, { connector: CONNECTOR, kind: 'person', value: `${p.name}, ${p.role}`.slice(0, 120), label: `named in SEC Form D filed ${filing.date} (as of filing, not verified as current)`.slice(0, 200), confidence: null, source_url: filing.url, source_date: filing.date, retrieved_at: now })
      n++
    }
    return n
  } catch { return 0 }
}
