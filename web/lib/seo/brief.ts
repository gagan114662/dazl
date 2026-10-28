import type Database from 'better-sqlite3'
import type { Db } from '../db/client.ts'
import { fetchKey, readKeyStatus } from '../llm/key-store.ts'
import { providers, ProviderError } from '../llm/provider.ts'
import type { Vendor } from '../llm/vendors.ts'

// Content briefs on the tenant's OWN AI key (BYOK only - never the operator key, never a trial
// scan). One call, plain text brief, stored for history. The UI labels every step "uses your AI key".
// Briefs and the tenant's own key are read and written through the Db layer (SQLite or Postgres).

export function migrateBriefs(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS seo_briefs (
      id         TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      topic      TEXT NOT NULL CHECK (length(topic) BETWEEN 3 AND 300),
      brief      TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );
    CREATE INDEX IF NOT EXISTS seo_briefs_tenant ON seo_briefs (tenant_id, created_at);
  `)
}

const PROMPT = (topic: string) => `You are an SEO content strategist. Write a content brief for a blog post targeting this topic: "${topic}"

Keep it under 500 words, plain text, exactly these sections:
TITLE OPTIONS (3)
TARGET AUDIENCE (2 lines)
SEARCH INTENT (1 line)
OUTLINE (5-7 H2 headings with a one-line note each)
META DESCRIPTION (max 155 chars)
FAQS (3 questions buyers actually ask)

Rules: no hype words, no invented statistics, no claims about specific companies' products unless framed as "verify before publishing".`

export type BriefResult = { id: string; topic: string; brief: string; created_at: number }

export async function generateBrief(db: Db, tenantId: string, rawTopic: string, deps: { fetchImpl?: typeof fetch; master?: Buffer; now?: number } = {}): Promise<BriefResult | { error: 'no_key' | 'invalid' | 'upstream' }> {
  const topic = rawTopic.trim().replace(/\s+/g, ' ').slice(0, 300)
  if (topic.length < 3) return { error: 'invalid' }
  const vendor = ((await readKeyStatus(db, tenantId))[0]?.vendor ?? null) as Vendor | null
  if (!vendor) return { error: 'no_key' }
  const key = await fetchKey(db, tenantId, vendor, deps.master)
  if (!key) return { error: 'no_key' }
  let brief: string
  try {
    brief = (await providers[vendor].complete!(key, PROMPT(topic), deps.fetchImpl ?? fetch, 1500)).trim()
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'auth') throw e // a bad key surfaces as auth, like scans
    return { error: 'upstream' }
  }
  if (brief.length < 100) return { error: 'upstream' }
  const now = deps.now ?? Math.floor(Date.now() / 1000)
  const id = `${now.toString(36)}${Math.random().toString(36).slice(2, 10)}`
  await db.run('INSERT INTO seo_briefs (id, tenant_id, topic, brief, created_at) VALUES (?, ?, ?, ?, ?)', [id, tenantId, topic, brief.slice(0, 8000), now])
  return { id, topic, brief, created_at: now }
}

export function recentBriefs(db: Db, tenantId: string, limit = 10): Promise<BriefResult[]> {
  return db.all<BriefResult>('SELECT id, topic, brief, created_at FROM seo_briefs WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', [tenantId, limit])
}
