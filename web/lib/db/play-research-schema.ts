// Schema-only startup migration; application research reads and writes use async Db.
import type Database from 'better-sqlite3'
export const PLAY_RESEARCH_SCHEMA=`CREATE TABLE IF NOT EXISTS play_research_sources (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, job_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 input_json TEXT NOT NULL, query_snapshot TEXT NOT NULL, offer_snapshot TEXT NOT NULL,
 play_created_at INTEGER NOT NULL, icp_snapshot TEXT, offer_source TEXT NOT NULL,
 source_check TEXT NOT NULL, person_check TEXT, created_at INTEGER NOT NULL,
 UNIQUE(tenant_id,job_id,fingerprint)
); CREATE INDEX IF NOT EXISTS play_research_sources_play ON play_research_sources(tenant_id,job_id,created_at);`
export function migratePlayResearch(db:Database.Database){db.exec(PLAY_RESEARCH_SCHEMA)}
