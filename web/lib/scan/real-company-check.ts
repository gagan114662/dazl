import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { fixtureAvailable, FixtureError } from '../outreach/test-fixture.ts'
import { isStaging } from '../staging.ts'
import { crawlJob, type Get } from '../connectors/sitecrawl.ts'
import { migrateWorkEmail } from '../people/work-email.ts'
import { migrateEmailGuess } from '../people/email-pattern.ts'

// STAGING-ONLY live-check enabler for #1036 (LIVE-FIRST rule A2: make the criterion triggerable on staging with REAL input).
// Find work email needs a lead on a settled company website that names a buyer; staging gets such a lead only from a paid scan whose
// results nobody controls. This takes ONE real company (name + website + the buyer roles a seller would target), adds it as a lead on
// the designated test tenant and runs the REAL site crawl on it (no model call, no provider call, $0). Everything after that - the
// site settling, the people read from the page, the published address, the Find work email click - is the production code on the
// company's real pages.
//
// Gated: the designated test tenant (fixtureAvailable) AND DAZL_ENV=staging; everything else is FixtureError. The play and lead say
// what they are ("staging check", not a scan finding). Never drafted: autopilot and launch calibration skip source_kind 'staging_check'
// (the crawl may record a role inbox on the real site). The crawl has a 60 s deadline; a crawl that read nothing is a reported failure.

export const REAL_CHECK_JOB = 'dazl real-company Find work email check (staging test)'
export const REAL_CHECK_SIGNAL = 'Staging check: a real company entered by the tester to check Find work email. Not a scan finding; dazl claims no buying signal.'
export const REAL_CHECK_SOURCE = 'staging_check'

export interface RealCheckInput { company: string; url: string; who: string }
export interface RealCheckResult { jobId: string; leadId: string; site: string | null; people: string[] }
// The crawl read nothing usable: the site could not be settled or names nobody. `reason`: the crawler's own last audit status.
export class RealCheckNotRead extends Error { readonly reason: string; readonly jobId: string; constructor(reason: string, jobId: string) { super('site_not_read'); this.reason = reason; this.jobId = jobId } }

// Validated input or null: a company name, an http(s) website on a host name (never an IP or a port), and 1-4 buyer roles.
export function parseRealCheckInput(raw: unknown): RealCheckInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const company = typeof r.company === 'string' ? r.company.replace(/\s+/g, ' ').trim() : ''
  const who = typeof r.who === 'string' ? r.who.split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean) : []
  if (company.length < 2 || company.length > 80 || who.length < 1 || who.length > 4 || who.some(w => w.length > 40)) return null
  let u: URL
  try { u = new URL(typeof r.url === 'string' ? r.url.trim() : '') } catch { return null }
  if (u.protocol === 'http:') u.protocol = 'https:' // the crawler reads https only (sitecrawl.ts rawGet)
  if (u.protocol !== 'https:' || u.port || u.username || u.password || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) || u.href.length > 300) return null
  return { company, url: u.href, who: who.join('; ') }
}

export function realCheckAvailable(db: Database.Database, tenantId: string, env: Record<string, string | undefined> = process.env): boolean {
  return typeof tenantId === 'string' && !!tenantId && isStaging(env) && fixtureAvailable(db, tenantId)
}

export async function runRealCompanyCheck(db: Database.Database, tenantId: string, input: RealCheckInput, deps: { env?: Record<string, string | undefined>; get?: Get; gapMs?: number; now?: number; timeoutMs?: number } = {}): Promise<RealCheckResult> {
  const env = deps.env ?? process.env
  if (!fixtureAvailable(db, tenantId)) throw new FixtureError('test_tenant_only')
  if (!isStaging(env)) throw new FixtureError('staging_only')
  // Inserted already 'running' in one statement: a scan worker never sees it 'pending' and so never claims it (no paid scan).
  const jobId = randomBytes(12).toString('hex')
  const icp = { summary: `Find work email check for ${input.company}`, who: input.who.split('; '), industries: [], sizes: [], where: [], signals: [], exclude: [] }
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, icp) VALUES (?, ?, ?, 'staging check', 'staging check', 'running', ?)").run(jobId, tenantId, REAL_CHECK_JOB, JSON.stringify(icp))
  const leadId = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence, score, source_kind, created_at) VALUES (?, ?, '', ?, NULL, ?, ?, ?, 90, 80, ?, ?)")
    .run(leadId, jobId, input.company, REAL_CHECK_SIGNAL, input.url, input.company, REAL_CHECK_SOURCE, Math.floor((deps.now ?? Date.now()) / 1000))
  try { await crawlJob(db, tenantId, jobId, { env, signal: AbortSignal.timeout(deps.timeoutMs ?? 60_000), ...(deps.get ? { get: deps.get } : {}), ...(deps.gapMs !== undefined ? { gapMs: deps.gapMs } : {}), ...(deps.now !== undefined ? { now: deps.now } : {}) }) }
  finally { db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ? AND status = 'running'").run(jobId) }
  const rows = db.prepare("SELECT kind, value FROM lead_enrichments WHERE tenant_id = ? AND lead_id = ? AND connector = 'sitecrawl' AND kind IN ('domain','person')").all(tenantId, leadId) as { kind: string; value: string }[]
  const result = { jobId, leadId, site: rows.find(r => r.kind === 'domain')?.value.split('|')[0] ?? null, people: rows.filter(r => r.kind === 'person').map(r => r.value) }
  if (!result.site || !result.people.length) {
    let last = ''
    try { last = (db.prepare("SELECT status FROM connector_audit WHERE tenant_id = ? AND job_id = ? AND connector = 'sitecrawl' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(tenantId, jobId) as { status: string } | undefined)?.status ?? '' } catch { last = '' }
    throw new RealCheckNotRead((result.site ? `the site was read but names no one with these buyer roles` : last || 'the company website could not be read or settled').slice(0, 200), jobId)
  }
  return result
}

// Removes every staging check play of this tenant with its leads and the rows hung on them. Test tenant only.
export function deleteRealCompanyChecks(db: Database.Database, tenantId: string): { deleted: number } {
  if (!fixtureAvailable(db, tenantId)) throw new FixtureError('test_tenant_only')
  migrateWorkEmail(db); migrateEmailGuess(db)
  const jobs = db.prepare("SELECT id, status FROM scan_jobs WHERE user_id = ? AND business_name = ? AND industry = 'staging check'").all(tenantId, REAL_CHECK_JOB) as { id: string; status: string }[]
  // A crawl still running, or a Find work email lookup in flight on one of these leads, would finish against deleted rows.
  const fresh = Math.floor(Date.now() / 1000) - 120
  if (jobs.some(j => j.status === 'running') || jobs.some(j => db.prepare("SELECT 1 FROM work_email_lookups w JOIN leads l ON l.id = w.lead_id WHERE l.scan_job_id = ? AND w.tenant_id = ? AND ((w.status = 'pending' AND w.updated_at >= ?) OR (w.mailbox_check = 'pending' AND COALESCE(w.mailbox_checked_at, 0) >= ?)) LIMIT 1").get(j.id, tenantId, fresh, fresh))) throw new FixtureError('check_in_flight')
  db.transaction(() => {
    for (const j of jobs) {
      const leads = db.prepare('SELECT id FROM leads WHERE scan_job_id = ? AND source_kind = ?').all(j.id, REAL_CHECK_SOURCE) as { id: string }[]
      for (const l of leads) {
        for (const t of ['work_email_lookups', 'email_candidates', 'email_patterns', 'lead_enrichments']) db.prepare(`DELETE FROM ${t} WHERE tenant_id = ? AND lead_id = ?`).run(tenantId, l.id)
        db.prepare('DELETE FROM lead_sources WHERE lead_id = ?').run(l.id)
        db.prepare('DELETE FROM leads WHERE id = ?').run(l.id)
      }
      db.prepare('DELETE FROM scan_source_runs WHERE job_id = ?').run(j.id)
      db.prepare('DELETE FROM scan_jobs WHERE id = ? AND user_id = ?').run(j.id, tenantId)
    }
  })()
  return { deleted: jobs.length }
}
