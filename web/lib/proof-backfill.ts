import type { Db } from './db/client.ts'
import { discoverContact, NO_BUYER_NAMED } from './discover/card.ts'
import { pageIsGone } from './discover/check.ts'
import { fetchPublicHtml } from './net/public-fetch.ts'
import { htmlToText } from './scan/fetch-page.ts'

type Lead = { id: string; source_url: string; name: string; review_reason: string | null; person_value: string | null; human_confirmed_at: number | string | null }
type Outcome = 'quarantined' | 'blocked' | 'unnamed'
interface Options { tenantId: string; execute: boolean; readPage?: typeof fetchPublicHtml }
const BATCH_SIZE = 50
const ELIGIBLE = `FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
  WHERE j.user_id = ? AND j.status = 'done' AND l.source_kind = 'discover'
    AND l.quarantined_at IS NULL AND l.evidence_purged_at IS NULL`
const LEAD = `SELECT l.id, l.source_url, l.name, l.review_reason, l.human_confirmed_at,
    (SELECT e.value FROM lead_enrichments e WHERE e.tenant_id = j.user_id
      AND e.lead_id = l.id AND e.connector = 'discover' AND e.kind = 'person'
      AND e.value <> '' ORDER BY e.retrieved_at, e.id LIMIT 1) AS person_value
  ${ELIGIBLE} AND l.id = ?`

function reviewOutcome(lead: Lead, blocked: boolean): Exclude<Outcome, 'quarantined'> | null {
  if (lead.human_confirmed_at !== null) return null
  if (lead.review_reason !== null && lead.review_reason !== 'blocked_by_site') return null
  const enrichments = lead.person_value ? [{ kind: 'person', connector: 'discover', value: lead.person_value }] : []
  const person = discoverContact({ source_kind: 'discover', name: lead.name, enrichments })?.person
  if (!person) return 'unnamed'
  return blocked && lead.review_reason === null ? 'blocked' : null
}

// One pass over a workspace's stored discovery leads. Only the original public proof URL is read.
export async function recheckDiscoveryProof(db: Db, { tenantId, execute, readPage = fetchPublicHtml }: Options) {
  const counts = { checked: 0, quarantined: 0, blocked: 0, unnamed: 0 }
  let after = ''
  while (true) {
    const batch = await db.all<Pick<Lead, 'id' | 'source_url'>>(
      `SELECT l.id, l.source_url ${ELIGIBLE} AND l.id > ? ORDER BY l.id LIMIT ?`, [tenantId, after, BATCH_SIZE],
    )
    for (const saved of batch) {
      after = saved.id
      const page = await readPage(saved.source_url).catch(() => null)
      counts.checked++
      const status = page?.status
      const gone = status === 404 || status === 410 || (!!page && 'html' in page && pageIsGone(htmlToText(page.html).text))
      const blocked = status === 401 || status === 403
      if (!execute) {
        const lead = await db.get<Lead>(LEAD, [tenantId, saved.id])
        if (lead?.source_url === saved.source_url) {
          const outcome = gone ? 'quarantined' : reviewOutcome(lead, blocked)
          if (outcome) counts[outcome]++
        }
        continue
      }

      // Fetch outside the transaction, then re-read the row and its contact before changing its state.
      const outcome = await db.tx<Outcome | null>(function* (tx) {
        const lead = yield* tx.get<Lead>(LEAD, [tenantId, saved.id])
        if (!lead || lead.source_url !== saved.source_url) return null
        if (gone) {
          const updated = yield* tx.run(
            'UPDATE leads SET quarantined_at = ?, quarantine_reason = ? WHERE id = ? AND quarantined_at IS NULL AND source_url = ?',
            [Math.floor(Date.now() / 1000), 'page_not_found', lead.id, lead.source_url],
          )
          return updated.changes === 1 ? 'quarantined' : null
        }
        // Preserve other existing holds. A successful fetch never promotes a lead.
        const outcome = reviewOutcome(lead, blocked)
        if (!outcome) return null
        const reason = outcome === 'blocked' ? 'blocked_by_site' : NO_BUYER_NAMED
        const updated = yield* tx.run(
          "UPDATE leads SET review_reason = ? WHERE id = ? AND quarantined_at IS NULL AND human_confirmed_at IS NULL AND COALESCE(review_reason, '') = ? AND source_url = ?",
          [reason, lead.id, lead.review_reason ?? '', lead.source_url],
        )
        return updated.changes === 1 ? outcome : null
      }, 'serializable')
      if (outcome) counts[outcome]++
    }
    if (batch.length < BATCH_SIZE) return counts
  }
}
