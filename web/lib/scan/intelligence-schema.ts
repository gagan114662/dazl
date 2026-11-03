// Seller decisions are separate from the lossy, 3900-character working ICP projection.
// No automatic expiry/deletion: append-only history, with new explicit decisions superseding old ones on recall.
import type Database from 'better-sqlite3'
export const SELLER_DECISIONS_SCHEMA = `CREATE TABLE IF NOT EXISTS seller_decisions (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, job_id TEXT NOT NULL,
 site TEXT NOT NULL, offer_id TEXT NOT NULL, hypothesis_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('persona','industry','size','location','disqualifier','pain')),
 text TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('confirm','reject')),
 source_url TEXT, source_quote TEXT, source_checked_at INTEGER,
 created_at INTEGER NOT NULL, version INTEGER NOT NULL CHECK (version = 1),
 UNIQUE(tenant_id,job_id,offer_id,hypothesis_id)
); CREATE INDEX IF NOT EXISTS seller_decisions_recall ON seller_decisions(tenant_id,site,created_at,id);`
export function migrateSellerDecisions(db: Database.Database): void { db.exec(SELLER_DECISIONS_SCHEMA) }
