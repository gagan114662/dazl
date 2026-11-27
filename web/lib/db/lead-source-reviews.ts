import type { Db } from './client.ts'
import type { ContactContext } from '../outreach/contact-context.ts'
import type { SourceCheck } from '../scan/source-review.ts'

interface SourceReviewRow {
  lead_id: string
  input_json: string
  fetch_status: string
  quote_match: number
  company_named: number
  contact_match: number
  checked_at: number
}

function readContactContext(input: string): ContactContext | null {
  try {
    const c = JSON.parse(input)?.contact_context
    return c && typeof c.excerpt === 'string' && typeof c.source_url === 'string' ? c : null
  } catch {
    return null
  }
}

export async function latestLeadSourceReviews(db: Db, tenantId: string, jobId: string, leadIds: readonly string[]) {
  const ids = [...new Set(leadIds)]
  const reviews = new Map<string, { check: SourceCheck; contactContext: ContactContext | null }>()
  // Stay below SQLite's parameter limit even if a caller supplies more than one page.
  for (let offset = 0; offset < ids.length; offset += 400) {
    const selected = ids.slice(offset, offset + 400)
    const rows = await db.all<SourceReviewRow>(`
      SELECT lead_id, input_json, fetch_status, quote_match, company_named, contact_match, checked_at
      FROM (
        SELECT r.lead_id, r.input_json, r.fetch_status, r.quote_match, r.company_named, r.contact_match, r.checked_at,
          ROW_NUMBER() OVER (PARTITION BY r.lead_id ORDER BY r.checked_at DESC, r.id DESC) AS review_rank
        FROM source_reviews r
        JOIN leads l ON l.id = r.lead_id AND l.scan_job_id = r.job_id
        JOIN scan_jobs j ON j.id = l.scan_job_id
        WHERE r.tenant_id = ? AND j.user_id = ? AND j.id = ?
          AND r.lead_id IN (${selected.map(() => '?').join(', ')})
      ) AS ranked
      WHERE review_rank = 1`, [tenantId, tenantId, jobId, ...selected])

    for (const row of rows) {
      reviews.set(row.lead_id, {
        check: {
          fetch_status: row.fetch_status,
          quote_match: Boolean(row.quote_match),
          company_named: Boolean(row.company_named),
          contact_match: Boolean(row.contact_match),
          checked_at: row.checked_at,
        },
        contactContext: readContactContext(row.input_json),
      })
    }
  }
  return reviews
}
