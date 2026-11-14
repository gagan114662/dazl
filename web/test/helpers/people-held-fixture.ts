// Fixtures for the #1037 held-lead people tests: the SHAPE of a staging run seen on 2026-11-13 (16 leads, 2 ready): its review reasons, fit grades, scores, buyer roles and title wording. Companies, people and profile URLs are invented.
// TEST-ONLY: TinyFish is stubbed, no network, no paid call.
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../../lib/scan/store.ts'
import { migrateConnectors, addEnrichment } from '../../lib/connectors/store.ts'
import { migrateTinyfish, resetTinyfishState } from '../../lib/search/tinyfish.ts'

// That run's ICP roles (scan_jobs.icp.who). The run named no place; these fixtures name a city (and every result names it), because a
// company NAME alone no longer ties a search result to a lead (lib/people/company-tie.ts).
export const HELD_WHO = ['Account Executive', 'Sales Manager', 'VP Sales', 'Head of Sales', 'Director of Sales', 'Chief Revenue Officer']
export const HELD_ICP = { summary: 'Account executives being hired at B2B software companies.', who: HELD_WHO, industries: ['B2B Software'], sizes: [], where: ['Chicago, Illinois'], signals: ['Hiring account executives'], exclude: [] }
export const env = { TINYFISH_API_KEY: 'k', TINYFISH_TENANT_DAILY: '50' }
// Search result lines in the shape the stored search:people rows came from (invented people).
export const HELD_RESULTS: Record<string, { url: string; title: string; snippet?: string }[]> = {
  Pagewake: [
    { url: 'https://www.linkedin.com/in/marta-solberg-test', title: 'Marta Solberg - Regional Sales Director - Pagewake | LinkedIn', snippet: 'Chicago, Illinois, United States · pagewake.example' },
    { url: 'https://www.linkedin.com/in/anya-braun-test', title: 'Anya Braun - Strategic Partner Sales Manager - Pagewake | LinkedIn', snippet: 'Chicago, Illinois, United States · pagewake.example' },
  ],
  Meshgate: [{ url: 'https://www.linkedin.com/in/anders-smed-test', title: 'Anders Smed - VP of Sales Development & PG - Meshgate | LinkedIn', snippet: 'Chicago, Illinois, United States · meshgate.example' }],
  Surveyhive: [{ url: 'https://www.linkedin.com/in/ewan-c-tomas-test', title: 'Ewan C. Tomas - Enterprise Account Executive - Surveyhive | LinkedIn', snippet: 'Chicago, Illinois, United States · surveyhive.example' }],
}
export type Row = [id: string, company: string, review: string | null, score: number, quarantined?: boolean, fit?: number | null]
// Every lead has a website the crawl CONFIRMED (its evidence page is on it), so a result naming that website is tied to it. { domains: false }
// leaves the leads with no confirmed website (the real staging case).
export const domainOf = (company: string) => `${company.toLowerCase().replace(/[^a-z0-9]/g, '')}.example`
export function setup(rows: Row[], icp: unknown = HELD_ICP, o: { domains?: boolean } = {}) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateTinyfish(db); resetTinyfishState()
  const job = createJob(db, 'A', { business_name: 'Seller', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify(icp), job)
  const ins = db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,review_reason,quarantined_at,fit) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  for (const [id, company, review, score, q, fit] of rows) ins.run(id, job, company, null, `${company} is hiring account executives`, `https://jobs.example.test/${id}`, `${company} is hiring account executives`, 90, score, review, q ? 1 : null, fit ?? null)
  if (o.domains !== false) for (const [id, company] of rows) confirmDomain(db, id, domainOf(company))
  return { db, job }
}
export function confirmDomain(db: Database.Database, leadId: string, domain: string) {
  db.prepare('UPDATE leads SET company_domain = ? WHERE id = ?').run(domain, leadId)
  addEnrichment(db, 'A', leadId, { connector: 'sitecrawl', kind: 'domain', value: `${domain}|evidence_own_domain`, label: 'domain-basis-v1:evidence_own_domain', confidence: null, source_url: `https://${domain}/`, source_date: '2026-11-13', retrieved_at: 1 })
}
export function stub(results: Record<string, { url: string; title: string; snippet?: string }[]> = HELD_RESULTS) {
  const companies: string[] = []
  const f = (async (u: string) => {
    const company = /"([^"]+)"/.exec(new URL(u).searchParams.get('query') ?? '')?.[1] ?? ''
    companies.push(company)
    return new Response(JSON.stringify({ results: results[company] ?? [] }))
  }) as unknown as typeof fetch
  return { f, companies }
}
