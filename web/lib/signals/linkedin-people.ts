// LinkedIn person-level signals (owner decision 2026-10-26, docs/DECISIONS.md): the people Gojiberry-class tools find.
//   engagers:<competitor>  people who commented on or reacted to recent LinkedIn posts about a competitor
//   people:<roles place>   people whose profile matches the ICP's buyer role and place
// Runs through the session worker with the tenant's own LinkedIn session, behind the same gates as every LinkedIn
// call: ADVANCED_LINKEDIN flag, the tenant's LinkedIn consent, and the per-tenant hourly LinkedIn budget (shared with
// the post search, audited under adv:linkedin). Items are login_walled: dazl cannot re-read a LinkedIn page without a
// session, so these leads stay in the review lane (login_required), labelled, and are never emailed automatically.
import type Database from 'better-sqlite3'
import type { Evidence } from '../sources/types.ts'
import { audit, getEnabledCredential } from '../connectors/store.ts'
import { advFlags, connectorId, maxCallsPerHour, platformAllowed, scopeFor } from '../advanced/config.ts'
import { hasConsent, httpWorker, type WorkerFetch } from '../advanced/index.ts'
import { listCompetitors } from './competitor-reddit.ts'

const ID = connectorId('linkedin')
export type LinkedInItem = Evidence & { login_walled: boolean }

export function linkedinQueries(icp: { who: string[]; where: string[]; industries: string[] }, competitors: string[], budget: number): string[] {
  const qs: string[] = []
  const role = icp.who[0]?.trim(); const place = icp.where[0]?.trim()
  // One people search first (any business has buyers to find), then competitor engagement with what is left.
  if (role) qs.push(`people:${[role, place].filter(Boolean).join(' ')}`.slice(0, 200))
  for (const c of competitors) qs.push(`engagers:${c}`.slice(0, 200))
  return qs.slice(0, Math.max(0, budget))
}

function callsLastHour(db: Database.Database, tenantId: string): number {
  return (db.prepare("SELECT count(*) AS n FROM connector_audit WHERE tenant_id = ? AND connector = ? AND status IN ('ok','empty','worker_error') AND created_at >= CAST(strftime('%s','now') AS INTEGER) - 3600").get(tenantId, ID) as { n: number }).n
}

export async function collectLinkedInPeople(db: Database.Database, tenantId: string, jobId: string, icp: { who: string[]; where: string[]; industries: string[] }, deps: { worker?: WorkerFetch; master?: Buffer; env?: Record<string, string | undefined> } = {}): Promise<LinkedInItem[]> {
  const env = deps.env ?? process.env
  const skip = (status: string) => { audit(db, { tenantId, connector: 'adv:linkedin-people', jobId, lookup: 'linkedin people', status, results: 0 }); return [] }
  if (!platformAllowed('linkedin', advFlags(env))) return skip('disabled')
  if (!hasConsent(db, tenantId, scopeFor('linkedin'))) return skip('no_consent')
  const session = getEnabledCredential(db, tenantId, ID, deps.master)
  if (!session) return skip('no_session') // a person-level LinkedIn read always needs the tenant's own session
  const queries = linkedinQueries(icp, listCompetitors(db, tenantId), maxCallsPerHour('linkedin', env) - callsLastHour(db, tenantId))
  if (queries.length === 0) return skip('rate_limited')
  const worker = deps.worker ?? httpWorker(env)
  const out: LinkedInItem[] = []
  for (const q of queries) {
    const items = await worker({ platform: 'linkedin', query: q, session }).catch(() => null)
    if (items === null) { audit(db, { tenantId, connector: ID, jobId, lookup: q, status: 'worker_error', results: 0 }); continue }
    audit(db, { tenantId, connector: ID, jobId, lookup: q, status: items.length ? 'ok' : 'empty', results: items.length })
    for (const it of items) if (/^https:\/\/www\.linkedin\.com\/in\//.test(it.url)) out.push({ source: ID, url: it.url, title: it.title, quote: it.quote, date: it.date, login_walled: true })
  }
  return out
}
