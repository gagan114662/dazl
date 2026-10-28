import type { Db } from '../db/client.ts'

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

// On the Db layer (SQLite or Postgres). The table is created with the store (lib/db/sqlite-migrations.ts on SQLite, the
// PG migrations on Postgres). Sums come back as numbers on both engines.
export async function threadMetrics(db: Db, tenantId: string): Promise<ThreadMetricRow[]> {
  const rows = await db.all<ThreadMetricRow>(`
    SELECT platform, query,
           COUNT(*) AS total,
           SUM(CASE WHEN buyer_intent = 'yes' THEN 1 ELSE 0 END) AS buyer_yes,
           SUM(CASE WHEN buyer_intent = 'uncertain' THEN 1 ELSE 0 END) AS uncertain,
           SUM(CASE WHEN buyer_intent = 'no' THEN 1 ELSE 0 END) AS not_buyer,
           SUM(CASE WHEN buyer_intent IS NULL THEN 1 ELSE 0 END) AS ungraded
    FROM reply_threads WHERE tenant_id = ?
    GROUP BY platform, query
    ORDER BY buyer_yes DESC, total DESC, platform, query
  `, [tenantId])
  return rows.map(r => ({ platform: r.platform, query: r.query, total: Number(r.total), buyer_yes: Number(r.buyer_yes), uncertain: Number(r.uncertain), not_buyer: Number(r.not_buyer), ungraded: Number(r.ungraded) }))
}
