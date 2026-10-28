import type Database from 'better-sqlite3'

// Everything the one-campaign page shows, for ONE scan of ONE tenant, read in full: the job, every lead of the scan and
// every email drafted from those leads. Plain SELECTs only - unlike the scan status read (getJob reaps stale jobs) and
// the Outreach list (newest 200 across the account), nothing here writes or truncates, so an old campaign's history is
// complete. Returns null for a scan that does not exist or is not this tenant's (the route answers both as 404).
export interface CampaignDetail {
  job: { id: string; query: string | null; status: string; error: string | null; created_at: number }
  leads: { id: string; company: string | null; name: string | null; evidence_excerpt: string | null; confidence: number | null; human_confirmed_at: number | null; review_reason: string | null; quarantined_at: number | null; quarantine_reason: string | null }[]
  messages: { id: string; lead_id: string; to_email: string; subject: string; status: string; created_at: number; sent_at: number | null }[]
}

export function campaignDetail(db: Database.Database, tenantId: string, jobId: string): CampaignDetail | null {
  const job = db.prepare('SELECT id, query, status, error, created_at FROM scan_jobs WHERE id = ? AND user_id = ?').get(jobId, tenantId) as CampaignDetail['job'] | undefined
  if (!job) return null
  const leads = db.prepare(`SELECT id, company, name, evidence_excerpt, confidence, human_confirmed_at, review_reason, quarantined_at, quarantine_reason
    FROM leads WHERE scan_job_id = ? ORDER BY rowid`).all(job.id) as CampaignDetail['leads']
  // Newest first, so the first message per lead is its latest.
  const messages = db.prepare(`SELECT m.id, m.lead_id, m.to_email, m.subject, m.status, m.created_at, m.sent_at
    FROM outreach_messages m JOIN leads l ON l.id = m.lead_id
    WHERE m.tenant_id = ? AND l.scan_job_id = ? ORDER BY m.created_at DESC, m.rowid DESC`).all(tenantId, job.id) as CampaignDetail['messages']
  return { job, leads, messages }
}
