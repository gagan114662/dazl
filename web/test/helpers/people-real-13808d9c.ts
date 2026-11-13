// Real staging rows of job 13808d9c6e6e7a792f625d58 ("B2B software companies hiring account executives"), read through the ops door
// on 2026-11-13, for the #1037 held-lead people tests. TEST-ONLY: TinyFish is stubbed, no network, no paid call.
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../../lib/scan/store.ts'
import { migrateConnectors } from '../../lib/connectors/store.ts'
import { migrateTinyfish, resetTinyfishState } from '../../lib/search/tinyfish.ts'

// The job's own ICP roles (scan_jobs.icp.who) and no place (where: []).
export const REAL_WHO = ['Account Executive', 'Sales Manager', 'VP Sales', 'Head of Sales', 'Director of Sales', 'Chief Revenue Officer']
export const REAL_ICP = { summary: 'Account executives being hired at B2B software companies.', who: REAL_WHO, industries: ['B2B Software'], sizes: [], where: [], signals: ['Hiring account executives'], exclude: [] }
export const env = { TINYFISH_API_KEY: 'k', TINYFISH_TENANT_DAILY: '50' }
// Stored search:people rows of that job (value, source_url), as search result lines.
export const REAL_RESULTS: Record<string, { url: string; title: string }[]> = {
  PagerDuty: [
    { url: 'https://www.linkedin.com/in/marksarman', title: 'Mark Sarman - Regional Sales Director - PagerDuty | LinkedIn' },
    { url: 'https://www.linkedin.com/in/annacbrown', title: 'Anna Brown - Strategic Partner Sales Manager - PagerDuty | LinkedIn' },
  ],
  Kong: [{ url: 'https://www.linkedin.com/in/andysmit', title: 'Andy Smit - VP of Sales Development & PG - Kong | LinkedIn' }],
  Qualtrics: [{ url: 'https://www.linkedin.com/in/evancthomas', title: 'Evan C. Thomas - Enterprise Account Executive - Qualtrics | LinkedIn' }],
}
export type Row = [id: string, company: string, review: string | null, score: number, quarantined?: boolean, fit?: number | null]
export function setup(rows: Row[], icp: unknown = REAL_ICP) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateTinyfish(db); resetTinyfishState()
  const job = createJob(db, 'A', { business_name: 'Seller', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify(icp), job)
  const ins = db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,review_reason,quarantined_at,fit) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  for (const [id, company, review, score, q, fit] of rows) ins.run(id, job, company, null, `${company} is hiring account executives`, `https://jobs.example.test/${id}`, `${company} is hiring account executives`, 90, score, review, q ? 1 : null, fit ?? null)
  return { db, job }
}
export function stub(results: Record<string, { url: string; title: string; snippet?: string }[]> = REAL_RESULTS) {
  const companies: string[] = []
  const f = (async (u: string) => {
    const company = /"([^"]+)"/.exec(new URL(u).searchParams.get('query') ?? '')?.[1] ?? ''
    companies.push(company)
    return new Response(JSON.stringify({ results: results[company] ?? [] }))
  }) as unknown as typeof fetch
  return { f, companies }
}
