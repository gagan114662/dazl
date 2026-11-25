import type { Db } from './db/client.ts'
import { discoverContact, NO_BUYER_NAMED } from './discover/card.ts'
import { pageIsGone } from './discover/check.ts'
import { fetchPublicHtml } from './net/public-fetch.ts'
import { htmlToText } from './scan/fetch-page.ts'

type Lead = { id: string; source_url: string; name: string; review_reason: string | null }
type Outcome = 'quarantined' | 'blocked' | 'unnamed'
interface Options { tenantId: string; execute: boolean; readPage?: typeof fetchPublicHtml }
const BATCH_SIZE = 50
const ELIGIBLE = `FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
  WHERE j.user_id = ? AND j.status = 'done' AND l.source_kind = 'discover'
    AND l.quarantined_at IS NULL AND l.evidence_purged_at IS NULL`

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

      // Fetch outside the transaction, then re-read the row and its contact before changing its state.
      const outcome = await db.tx<Outcome | null>(function* (tx) {
        const lead = yield* tx.get<Lead>(
          `SELECT l.id, l.source_url, l.name, l.review_reason ${ELIGIBLE} AND l.id = ?`, [tenantId, saved.id],
        )
        if (!lead || lead.source_url !== saved.source_url) return null
        if (gone) {
          if (!execute) return 'quarantined'
          const updated = yield* tx.run(
            'UPDATE leads SET quarantined_at = ?, quarantine_reason = ? WHERE id = ? AND quarantined_at IS NULL AND source_url = ?',
            [Math.floor(Date.now() / 1000), 'page_not_found', lead.id, lead.source_url],
          )
          return updated.changes === 1 ? 'quarantined' : null
        }
        // Preserve other existing holds. A successful fetch never promotes a lead.
        if (lead.review_reason !== null) return null
        let reason = 'blocked_by_site'
        if (!blocked) {
          const enrichments = yield* tx.all<{ kind: string; connector: string; value: string }>(
            `SELECT kind, connector, value FROM lead_enrichments
             WHERE tenant_id = ? AND lead_id = ? AND connector = 'discover' AND kind = 'person' AND value <> ''
             ORDER BY retrieved_at, id`, [tenantId, lead.id],
          )
          if (discoverContact({ source_kind: 'discover', name: lead.name, enrichments })?.person) return null
          reason = NO_BUYER_NAMED
        }
        const outcome = blocked ? 'blocked' : 'unnamed'
        if (!execute) return outcome
        const updated = yield* tx.run(
          'UPDATE leads SET review_reason = ? WHERE id = ? AND quarantined_at IS NULL AND review_reason IS NULL AND source_url = ?',
          [reason, lead.id, lead.source_url],
        )
        return updated.changes === 1 ? outcome : null
      }, 'serializable')
      if (outcome) counts[outcome]++
    }
    if (batch.length < BATCH_SIZE) return counts
  }
}
