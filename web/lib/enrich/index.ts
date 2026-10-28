// BYOK contact/firmographic enrichment in the scan waterfall. Runs only with the
// tenant's own Apollo or PDL key (Settings > Enrichment). Apollo first, PDL as the
// alternative when only a PDL key exists. Every call is audit-rowed with its credit
// cost; every failure is silent like the other signals (a bonus, never the bar).
import type Database from 'better-sqlite3'
import { addEnrichment, audit, getEnabledCredential } from '../connectors/store.ts'
import { apolloOrgEnrich, apolloPeopleSearch, EnrichError } from './apollo.ts'
import { pdlPeopleSearch } from './pdl.ts'
import { getMasterKey } from '../secrets.ts'
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
const domainOf = (u: string | null | undefined) => /^[a-z]+:\/\/([^/?#]+)/i.exec(u ?? '')?.[1]?.replace(/^www\./, '') || null

export async function enrichLeadContacts(
  db: Database.Database,
  tenantId: string,
  jobId: string,
  leads: LeadRow[],
  deps: { fetchImpl?: typeof fetch; master?: Buffer } = {},
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const master = deps.master ?? getMasterKey()
  const apolloKey = getEnabledCredential(db, tenantId, ENRICH_APOLLO, master)
  const pdlKey = apolloKey ? null : getEnabledCredential(db, tenantId, ENRICH_PDL, master)
  if (!apolloKey && !pdlKey) return
  const now = Math.floor(Date.now() / 1000)
  const today = new Date().toISOString().slice(0, 10)
  const where = scanWhere(db, jobId)

  for (const lead of leads.slice(0, MAX_LEADS)) {
    const src = lead.company_domain ? `https://${lead.company_domain}` : `https://www.linkedin.com/company/${encodeURIComponent(lead.company.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}`
    if (apolloKey) {
      let org: Awaited<ReturnType<typeof apolloOrgEnrich>> = null
      try {
        org = await apolloOrgEnrich(apolloKey, { domain: lead.company_domain, name: lead.company }, fetchImpl)
        // A same-name company elsewhere (Pico Rivera, CA for a New York lead) is not attached: the record must agree on the domain or the place.
        const agree = org ? contactAgreement({ company_domain: lead.company_domain, where }, { domain: domainOf(org.website), place: org.place, keyedOnLeadDomain: !!lead.company_domain }) : null
        if (org && agree && !agree.ok) { audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: `org ${lead.company}`.slice(0, 200), status: agree.reason, results: 0 }); recordContactRejection(db, tenantId, lead.id, { connector: ENRICH_APOLLO, reason: agree.reason, sourceUrl: org.website ?? src }); continue }
        if (org && (org.employees || org.industry)) {
          const bits = [org.employees ? `${org.employees} employees` : null, org.industry, org.founded ? `founded ${org.founded}` : null].filter(Boolean).join(' · ')
          addEnrichment(db, tenantId, lead.id, { connector: ENRICH_APOLLO, kind: 'firmographic', value: bits.slice(0, 254), label: org.name, confidence: 75, source_url: org.linkedin ?? org.website ?? src, source_date: today, retrieved_at: now })
        }
        audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: `org ${lead.company}`, status: org ? 'ok' : 'empty', results: org ? 1 : 0 })
      } catch (e) {
        audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: `org ${lead.company}`, status: e instanceof EnrichError ? e.code : 'error', results: 0 })
        if (e instanceof EnrichError && e.code === 'auth') return // a bad key stops the whole pass, not just this lead
      }
      try {
        // The org lookup above often discovers the domain even when the lead had none -
        // search people by that domain (much more reliable than a raw company name,
        // especially noisy ones like "The Jackson Laboratory (JAX)").
        const orgDomain = lead.company_domain ?? (/^[a-z]+:\/\/([^/?#]+)/i.exec(org?.website ?? '')?.[1]?.replace(/^www\./, '') || null)
        if (!orgDomain) { audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: `people ${lead.company}`.slice(0, 200), status: 'contact rejected: no domain to confirm the company', results: 0 }); recordContactRejection(db, tenantId, lead.id, { connector: ENRICH_APOLLO, reason: 'contact rejected: no domain to confirm the company', sourceUrl: src }); continue }
        const found = await apolloPeopleSearch(apolloKey, { domain: orgDomain, name: lead.company }, fetchImpl, MAX_CONTACTS)
        // A person whose own organization contradicts the requested company (another name, another domain) is not attached.
        const people = []
        for (const p of found) {
          const why = organizationContradicts(lead.company, orgDomain, p.organization)
          if (!why) { people.push(p); continue }
          audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: `people ${lead.company}`.slice(0, 200), status: why, results: 0 })
          recordContactRejection(db, tenantId, lead.id, { connector: ENRICH_APOLLO, reason: why, sourceUrl: src })
        }
        for (const p of people) addEnrichment(db, tenantId, lead.id, { connector: ENRICH_APOLLO, kind: 'contact', value: `${p.name}${p.title ? ` - ${p.title}` : ''}`.slice(0, 254), label: 'Apollo', confidence: 70, source_url: p.linkedin ?? src, source_date: today, retrieved_at: now })
        audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: `people ${lead.company}`, status: people.length ? 'ok' : 'empty', results: people.length })
      } catch (e) {
        audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: `people ${lead.company}`, status: e instanceof EnrichError ? e.code : 'error', results: 0 })
        if (e instanceof EnrichError && e.code === 'auth') return
      }
    } else if (pdlKey) {
      try {
        const found = await pdlPeopleSearch(pdlKey, lead.company, fetchImpl, MAX_CONTACTS)
        // PDL matches on the company NAME only: each person's company must agree with the lead on its domain or place.
        const people = []
        for (const p of found) {
          const a = contactAgreement({ company_domain: lead.company_domain, where }, { domain: p.domain, place: p.place })
          if (a.ok) people.push(p); else { audit(db, { tenantId, connector: ENRICH_PDL, jobId, lookup: `people ${lead.company}`.slice(0, 200), status: a.reason, results: 0 }); recordContactRejection(db, tenantId, lead.id, { connector: ENRICH_PDL, reason: a.reason, sourceUrl: src }) }
        }
        for (const p of people) addEnrichment(db, tenantId, lead.id, { connector: ENRICH_PDL, kind: 'contact', value: `${p.name}${p.title ? ` - ${p.title}` : ''}`.slice(0, 254), label: 'People Data Labs', confidence: 70, source_url: p.linkedin ?? src, source_date: today, retrieved_at: now })
        audit(db, { tenantId, connector: ENRICH_PDL, jobId, lookup: `people ${lead.company}`, status: people.length ? 'ok' : 'empty', results: people.length })
      } catch (e) {
        audit(db, { tenantId, connector: ENRICH_PDL, jobId, lookup: `people ${lead.company}`, status: e instanceof EnrichError ? e.code : 'error', results: 0 })
        if (e instanceof EnrichError && e.code === 'auth') return
      }
    }
  }
}
