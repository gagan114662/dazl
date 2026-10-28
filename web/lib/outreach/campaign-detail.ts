import type { Db } from '../db/client.ts'

// Everything the one-campaign page shows, for ONE scan of ONE tenant, read in full: the job, every lead of the scan and
// every email drafted from those leads. Plain SELECTs only - unlike the scan status read (getJob reaps stale jobs) and
// the Outreach list (newest 200 across the account), nothing here writes or truncates, so an old campaign's history is
// complete. Returns null for a scan that does not exist or is not this tenant's (the route answers both as 404).
export interface CampaignDetail {
  job: { id: string; query: string | null; status: string; error: string | null; funded_by: 'trial' | null; created_at: number; candidates: number | null; verified: number | null; needs_review: number | null; dropped: number | null; enrich_started_at: number | null; enrich_finished_at: number | null }
  leads: { id: string; company: string | null; name: string | null; evidence_excerpt: string | null; confidence: number | null; human_confirmed_at: number | null; review_reason: string | null; quarantined_at: number | null; quarantine_reason: string | null }[]
  messages: { id: string; lead_id: string; to_email: string; subject: string; status: string; created_at: number; sent_at: number | null }[]
}

// On the Db layer (SQLite or Postgres). Leads list in insertion order and messages newest first with insertion order
// breaking same-second ties, as the raw queries did with rowid (insert_seq: lib/db/insertion-order.ts).
export async function campaignDetail(db: Db, tenantId: string, jobId: string): Promise<CampaignDetail | null> {
  const job = await db.get<CampaignDetail['job']>("SELECT id, query, status, error, CASE WHEN funded_by = 'trial' THEN 'trial' END AS funded_by, created_at, candidates, verified, needs_review, dropped, enrich_started_at, enrich_finished_at FROM scan_jobs WHERE id = ? AND user_id = ?", [jobId, tenantId])
  if (!job) return null
  const leads = await db.all<CampaignDetail['leads'][number]>(`SELECT id, company, name, evidence_excerpt, confidence, human_confirmed_at, review_reason, quarantined_at, quarantine_reason
    FROM leads WHERE scan_job_id = ? ORDER BY insert_seq`, [job.id])
  // Newest first, so the first message per lead is its latest.
  const messages = await db.all<CampaignDetail['messages'][number]>(`SELECT m.id, m.lead_id, m.to_email, m.subject, m.status, m.created_at, m.sent_at
    FROM outreach_messages m JOIN leads l ON l.id = m.lead_id
    WHERE m.tenant_id = ? AND l.scan_job_id = ? ORDER BY m.created_at DESC, m.insert_seq DESC`, [tenantId, job.id])
  return { job, leads, messages }
}
