// BYOK contact/firmographic enrichment in the scan waterfall. Runs only with the
// tenant's own Apollo or PDL key (Settings > Enrichment). Apollo first, PDL as the
// alternative when only a PDL key exists. Every call is audit-rowed with its credit
// cost; every failure is silent like the other signals (a bonus, never the bar).
import type Database from 'better-sqlite3'
import { addEnrichment, audit, getEnabledCredential } from '../connectors/store.ts'
import { apolloOrgEnrich, apolloPeopleSearch, EnrichError } from './apollo.ts'
import { pdlPeopleSearch } from './pdl.ts'
import { getMasterKey } from '../secrets.ts'

export const ENRICH_APOLLO = 'enrich:apollo'
export const ENRICH_PDL = 'enrich:pdl'
const MAX_LEADS = 5 // credit discipline: at most 5 org enrich calls (1 credit each) per scan
const MAX_CONTACTS = 5 // people search is 0-credit on Apollo; PDL charges per profile

interface LeadRow { id: string; company: string; company_domain: string | null }

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

  for (const lead of leads.slice(0, MAX_LEADS)) {
    const src = lead.company_domain ? `https://${lead.company_domain}` : `https://www.linkedin.com/company/${encodeURIComponent(lead.company.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}`
    if (apolloKey) {
      let org: Awaited<ReturnType<typeof apolloOrgEnrich>> = null
      try {
        org = await apolloOrgEnrich(apolloKey, { domain: lead.company_domain, name: lead.company }, fetchImpl)
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
        const people = await apolloPeopleSearch(apolloKey, { domain: orgDomain, name: lead.company }, fetchImpl, MAX_CONTACTS)
        for (const p of people) addEnrichment(db, tenantId, lead.id, { connector: ENRICH_APOLLO, kind: 'contact', value: `${p.name}${p.title ? ` - ${p.title}` : ''}`.slice(0, 254), label: 'Apollo', confidence: 70, source_url: p.linkedin ?? src, source_date: today, retrieved_at: now })
        audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: `people ${lead.company}`, status: people.length ? 'ok' : 'empty', results: people.length })
      } catch (e) {
        audit(db, { tenantId, connector: ENRICH_APOLLO, jobId, lookup: `people ${lead.company}`, status: e instanceof EnrichError ? e.code : 'error', results: 0 })
        if (e instanceof EnrichError && e.code === 'auth') return
      }
    } else if (pdlKey) {
      try {
        const people = await pdlPeopleSearch(pdlKey, lead.company, fetchImpl, MAX_CONTACTS)
        for (const p of people) addEnrichment(db, tenantId, lead.id, { connector: ENRICH_PDL, kind: 'contact', value: `${p.name}${p.title ? ` - ${p.title}` : ''}`.slice(0, 254), label: 'People Data Labs', confidence: 70, source_url: p.linkedin ?? src, source_date: today, retrieved_at: now })
        audit(db, { tenantId, connector: ENRICH_PDL, jobId, lookup: `people ${lead.company}`, status: people.length ? 'ok' : 'empty', results: people.length })
      } catch (e) {
        audit(db, { tenantId, connector: ENRICH_PDL, jobId, lookup: `people ${lead.company}`, status: e instanceof EnrichError ? e.code : 'error', results: 0 })
        if (e instanceof EnrichError && e.code === 'auth') return
      }
    }
  }
}
