import type Database from 'better-sqlite3'
import { sequenceAnalytics } from './sequences.ts'

// One row per search (a scan job is a campaign, as in the Outreach analytics): discovery -> qualification -> contact ->
// outreach -> sequence -> reply, and the single next action. Read-only and tenant-scoped: every count is limited to the
// signed-in user's own job and its leads. Counts are what is stored now; nothing here is a delivery or intent claim.

export interface Campaign {
  id: string; query: string; status: string; error: string | null; created_at: number
  discovery: { candidates: number | null; leads: number }
  qualification: { sourceChecked: number; confirmedByYou: number; needsReview: number; rejected: number }
  contact: { withContact: number }
  outreach: { drafts: number; approved: number; sent: number }
  sequence: { active: number; stopped: number }
  reply: { replied: number; interested: number; bounced: number; optOuts: number }
  next: { label: string; href: string | null }
}

export function listCampaigns(db: Database.Database, tenantId: string, limit = 10): Campaign[] {
  const jobs = db.prepare(`SELECT id, query, status, error, created_at, candidates FROM scan_jobs
    WHERE user_id = ? AND query IS NOT NULL AND query <> '' AND NOT (industry = 'test only' AND location = 'test only')
    ORDER BY created_at DESC LIMIT ?`).all(tenantId, limit) as { id: string; query: string; status: string; error: string | null; created_at: number; candidates: number | null }[]
  return jobs.map(j => {
    const n = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n
    // Leads of THIS job of THIS tenant only (scan_jobs.user_id is the tenant).
    const L = `FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = ? WHERE l.scan_job_id = ?`
    const live = 'AND l.quarantined_at IS NULL'
    const leads = n(`SELECT count(*) AS n ${L}`, tenantId, j.id)
    const sourceChecked = n(`SELECT count(*) AS n ${L} ${live} AND l.review_reason IS NULL AND l.confidence IS NOT NULL`, tenantId, j.id)
    const confirmedByYou = n(`SELECT count(*) AS n ${L} ${live} AND l.human_confirmed_at IS NOT NULL`, tenantId, j.id)
    const needsReview = n(`SELECT count(*) AS n ${L} ${live} AND l.review_reason IS NOT NULL AND l.human_confirmed_at IS NULL`, tenantId, j.id)
    const rejected = n(`SELECT count(*) AS n ${L} AND l.quarantined_at IS NOT NULL`, tenantId, j.id)
    const withContact = n(`SELECT count(*) AS n ${L} ${live} AND coalesce(trim(l.contact), '') <> ''`, tenantId, j.id)
    const msg = (status: string) => n(`SELECT count(*) AS n FROM outreach_messages m JOIN leads l ON l.id = m.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = ? WHERE m.tenant_id = ? AND l.scan_job_id = ? AND m.status = ?`, tenantId, tenantId, j.id, status)
    const drafts = msg('draft'), approved = msg('approved'), sent = msg('sent')
    const seq = (list: string) => n(`SELECT count(*) AS n FROM sequences s JOIN leads l ON l.id = s.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = ? WHERE s.tenant_id = ? AND l.scan_job_id = ? AND s.status IN (${list})`, tenantId, tenantId, j.id)
    const leadIds = (db.prepare(`SELECT l.id ${L}`).all(tenantId, j.id) as { id: string }[]).map(r => r.id)
    const a = sequenceAnalytics(db, tenantId, leadIds)
    const interested = leadIds.length ? n(`SELECT count(DISTINCT thread_id) AS n FROM inbound_messages WHERE tenant_id = ? AND classification = 'positive' AND lead_id IN (${leadIds.map(() => '?').join(',')})`, tenantId, ...leadIds) : 0
    // Usable leads (source-checked or confirmed by you) with a stored contact and no email yet.
    const undrafted = n(`SELECT count(*) AS n ${L} ${live} AND (l.human_confirmed_at IS NOT NULL OR (l.review_reason IS NULL AND l.confidence IS NOT NULL)) AND coalesce(trim(l.contact), '') <> ''
      AND NOT EXISTS (SELECT 1 FROM outreach_messages m WHERE m.tenant_id = ? AND m.lead_id = l.id)`, tenantId, j.id, tenantId)
    const c: Omit<Campaign, 'next'> = {
      id: j.id, query: j.query, status: j.status, error: j.error, created_at: j.created_at,
      discovery: { candidates: j.candidates, leads },
      qualification: { sourceChecked, confirmedByYou, needsReview, rejected },
      contact: { withContact },
      outreach: { drafts, approved, sent },
      sequence: { active: seq("'approved','active'"), stopped: seq("'replied','done','stopped'") },
      reply: { replied: a.replied, interested, bounced: a.bounced, optOuts: a.optOuts },
    }
    return { ...c, next: nextAction(c, undrafted) }
  })
}

const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`

// The one thing to do next for a campaign, in pipeline order. It never runs ahead of a gate: review comes before
// drafting, approval before sending; the link goes to the page where that existing step and its checks live.
export function nextAction(c: Omit<Campaign, 'next'>, undrafted: number): Campaign['next'] {
  const leadsHref = `/app/leads?job_id=${c.id}`
  if (c.status === 'pending' || c.status === 'running') return { label: 'Search still running', href: leadsHref }
  if (c.status === 'failed') return { label: c.error === 'cancelled' ? 'Search cancelled. Run it again if you still want it' : 'Search failed. Open it to see why', href: leadsHref }
  if (c.qualification.needsReview > 0) return { label: `Check ${plural(c.qualification.needsReview, 'lead that needs', 'leads that need')} your review`, href: leadsHref }
  if (c.outreach.drafts > 0) return { label: `Review and approve ${plural(c.outreach.drafts, 'draft', 'drafts')}`, href: '/app/outreach' }
  if (c.outreach.approved > 0) return { label: `Send ${plural(c.outreach.approved, 'approved email', 'approved emails')}`, href: '/app/outreach' }
  if (c.reply.interested > 0) return { label: `Answer ${plural(c.reply.interested, 'interested reply', 'interested replies')}`, href: '/app/inbox' }
  if (undrafted > 0) return { label: `Approve ${plural(undrafted, 'lead', 'leads')} to draft emails`, href: leadsHref }
  if (c.discovery.leads === 0) return { label: 'No leads from this search. Try a broader one', href: '/app/leads' }
  return { label: 'Nothing waiting on you', href: null }
}
