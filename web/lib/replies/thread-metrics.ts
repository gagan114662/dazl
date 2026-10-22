import type Database from 'better-sqlite3'
import { migrateThreadReplies } from './threads.ts'

// Thread-verdict quality: which reply searches (platform + query) surface threads that
// grade as buyers. Correct entity, no joins: a thread's verdict is about the THREAD and
// its author, never about a lead. Kept deliberately separate from the lead-level source
// metrics (#136) - the two answer different questions and are never combined.
//
// Honesty rules:
// - buyer_intent NULL means keyword-matched only, no model verdict (e.g. no AI key) -
//   reported as ungraded, never counted as a yes or a no.
// - 'no' threads are hidden from the review list but counted here so the user can see
//   the filter actually filtering - hidden does not mean never existed.
// - A verdict is a model heuristic for review, never proof of buyer intent.

export interface ThreadMetricRow {
  platform: string
  query: string
  total: number
  buyer_yes: number
  uncertain: number
  not_buyer: number
  ungraded: number
}

export function threadMetrics(db: Database.Database, tenantId: string): ThreadMetricRow[] {
  migrateThreadReplies(db)
  return db.prepare(`
    SELECT platform, query,
           COUNT(*) AS total,
           SUM(CASE WHEN buyer_intent = 'yes' THEN 1 ELSE 0 END) AS buyer_yes,
           SUM(CASE WHEN buyer_intent = 'uncertain' THEN 1 ELSE 0 END) AS uncertain,
           SUM(CASE WHEN buyer_intent = 'no' THEN 1 ELSE 0 END) AS not_buyer,
           SUM(CASE WHEN buyer_intent IS NULL THEN 1 ELSE 0 END) AS ungraded
    FROM reply_threads WHERE tenant_id = ?
    GROUP BY platform, query
    ORDER BY buyer_yes DESC, total DESC, platform, query
  `).all(tenantId) as ThreadMetricRow[]
}
