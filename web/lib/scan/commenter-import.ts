// Commenter import (Pro only). The user pastes LinkedIn profile URLs - or uploads their
// own export of linkedin.com/in/ links - for people who engaged with a post, and dazl
// researches each person on the public web. This is the no-scraping design:
//  - only linkedin.com/in/<slug> profile URLs are accepted; post, company, feed and
//    every other LinkedIn path is rejected at import;
//  - the URL is stored as provenance and is NEVER fetched - not here, not by the runner,
//    not by the verifier (see runner.ts and lib/scan/fetch-page.ts);
//  - the person's name is derived from the URL slug and always labeled 'derived' -
//    it is a guess from the slug, not profile data.
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { scanQuota } from '../plans.ts'

export const MAX_PROFILES = 100

export function migrateCommenterImport(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS commenter_batches (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      total      INTEGER NOT NULL,
      note       TEXT,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );
    CREATE INDEX IF NOT EXISTS commenter_batches_user ON commenter_batches (user_id, created_at);

    CREATE TABLE IF NOT EXISTS commenter_rows (
      id           TEXT PRIMARY KEY,
      batch_id     TEXT NOT NULL REFERENCES commenter_batches(id) ON DELETE CASCADE,
      profile_url  TEXT NOT NULL CHECK (length(profile_url) BETWEEN 1 AND 500),
      slug         TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 100),
      derived_name TEXT NOT NULL CHECK (length(derived_name) BETWEEN 1 AND 150),
      state        TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','skipped')),
      note         TEXT,
      job_id       TEXT REFERENCES scan_jobs(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS commenter_rows_batch ON commenter_rows (batch_id);
  `)
}

// Only personal profile URLs. Posts, articles, companies, schools, groups, feed items -
// anything else on linkedin.com - is rejected, because accepting it would invite a fetch.
const PROFILE_RE = /^(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([a-z0-9][a-z0-9-]{0,98}[a-z0-9])\/?(?:[?#].*)?$/i

export function normalizeProfileUrl(raw: string): { url: string; slug: string } | { reason: string } {
  let s = raw.trim()
  if (!s) return { reason: 'blank' }
  const quoted = /^"((?:[^"]|"")*)"/.exec(s)
  s = (quoted ? quoted[1].replace(/""/g, '"') : s.split(',')[0]).trim()
  if (!s) return { reason: 'blank' }
  if (/linkedin\.com\/(posts|feed|company|school|groups|jobs|pulse|article)/i.test(s)) {
    return { reason: 'only profile URLs (linkedin.com/in/...) are accepted - posts and pages are never fetched' }
  }
  const m = PROFILE_RE.exec(s)
  if (!m) {
    if (/linkedin\.com/i.test(s)) return { reason: 'not a profile URL - use linkedin.com/in/<name>' }
    return { reason: 'not a linkedin.com profile URL' }
  }
  const slug = m[1].toLowerCase()
  return { url: `https://www.linkedin.com/in/${slug}`, slug }
}

// Slug to display name: 'jane-doe-8a4b2112' -> 'Jane Doe'. Trailing tokens containing
// digits (LinkedIn's member-id suffix) are dropped. This is a guess from the URL text,
// always labeled 'derived' - never presented as profile data.
export function deriveName(slug: string): string {
  const parts = slug.split('-').filter(Boolean)
  const nameParts = parts.filter(p => !/\d/.test(p))
  const use = (nameParts.length > 0 ? nameParts : parts).slice(0, 4)
  return use.map(p => p[0].toUpperCase() + p.slice(1)).join(' ').slice(0, 150)
}

export interface ParsedProfiles {
  valid: { url: string; slug: string; derived_name: string }[]
  invalid: { line: string; reason: string }[]
  overflow: number
}

// One profile URL per line; anything after the first comma is ignored (a LinkedIn
// export row still imports). Duplicates collapse to their first occurrence.
export function parseProfiles(text: string, max = MAX_PROFILES): ParsedProfiles {
  const seen = new Set<string>()
  const valid: ParsedProfiles['valid'] = []
  const invalid: { line: string; reason: string }[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) continue
    const r = normalizeProfileUrl(rawLine)
    if ('reason' in r) {
      if (r.reason !== 'blank') invalid.push({ line: rawLine.trim().slice(0, 100), reason: r.reason })
      continue
    }
    if (seen.has(r.url)) continue
    seen.add(r.url)
    valid.push({ url: r.url, slug: r.slug, derived_name: deriveName(r.slug) })
  }
  const overflow = Math.max(0, valid.length - max)
  return { valid: valid.slice(0, max), invalid, overflow }
}

export function createCommenterBatch(db: Database.Database, userId: string, rows: ParsedProfiles['valid']): string {
  const id = randomBytes(12).toString('hex')
  db.transaction(() => {
    db.prepare('INSERT INTO commenter_batches (id, user_id, total) VALUES (?, ?, ?)').run(id, userId, rows.length)
    const ins = db.prepare('INSERT INTO commenter_rows (id, batch_id, profile_url, slug, derived_name) VALUES (?, ?, ?, ?, ?)')
    for (const r of rows) ins.run(randomBytes(12).toString('hex'), id, r.url, r.slug, r.derived_name)
  })()
  return id
}

// One research job per pending row until the plan quota stops the batch - same shape as
// the CSV domain import. The job carries the derived name; the profile URL stays in the
// batch row as provenance and is never fetched. person_name marks the job for the runner.
export function queuePendingCommenters(db: Database.Database, userId: string, batchId: string): { queued: number; quotaStop: boolean } {
  const batch = db.prepare('SELECT id FROM commenter_batches WHERE id = ? AND user_id = ?').get(batchId, userId)
  if (!batch) return { queued: 0, quotaStop: false }
  const rows = db.prepare("SELECT id, derived_name FROM commenter_rows WHERE batch_id = ? AND state = 'pending' AND job_id IS NULL ORDER BY rowid").all(batchId) as { id: string; derived_name: string }[]
  let queued = 0
  let quotaStop = false
  for (const row of rows) {
    if (!scanQuota(db, userId).allowed) { quotaStop = true; break }
    const jobId = randomBytes(12).toString('hex')
    db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, batch_id, person_name) VALUES (?, ?, ?, '-', '-', ?, ?)").run(jobId, userId, row.derived_name.slice(0, 150), batchId, row.derived_name.slice(0, 150))
    db.prepare('UPDATE commenter_rows SET job_id = ? WHERE id = ?').run(jobId, row.id)
    queued++
  }
  if (quotaStop) {
    const { n } = db.prepare('SELECT count(*) AS n FROM commenter_rows WHERE batch_id = ? AND job_id IS NOT NULL').get(batchId) as { n: number }
    const { total } = db.prepare('SELECT total FROM commenter_batches WHERE id = ?').get(batchId) as { total: number }
    db.prepare('UPDATE commenter_batches SET note = ? WHERE id = ?').run(`${n} of ${total} ran, quota reached`, batchId)
  }
  return { queued, quotaStop }
}

export interface CommenterRowStatus { profile_url: string; derived_name: string; name_source: 'derived'; status: 'pending' | 'skipped' | 'queued' | 'running' | 'done' | 'failed'; job_id: string | null; leads: number | null; error: string | null; note: string | null }
export interface CommenterBatchStatus { batch_id: string; total: number; note: string | null; created_at: number; counts: Record<string, number>; rows: CommenterRowStatus[] }

export function commenterBatchStatus(db: Database.Database, userId: string, batchId: string): CommenterBatchStatus | undefined {
  const batch = db.prepare('SELECT id, total, note, created_at FROM commenter_batches WHERE id = ? AND user_id = ?').get(batchId, userId) as { id: string; total: number; note: string | null; created_at: number } | undefined
  if (!batch) return undefined
  const rows = db.prepare(
    `SELECT r.profile_url, r.derived_name, r.state, r.note, r.job_id, j.status AS job_status, j.error,
            (SELECT count(*) FROM leads l WHERE l.scan_job_id = j.id) AS leads
     FROM commenter_rows r LEFT JOIN scan_jobs j ON j.id = r.job_id
     WHERE r.batch_id = ? ORDER BY r.rowid`,
  ).all(batchId) as { profile_url: string; derived_name: string; state: string; note: string | null; job_id: string | null; job_status: string | null; error: string | null; leads: number | null }[]
  const counts: Record<string, number> = {}
  const out: CommenterRowStatus[] = rows.map(r => {
    const status = (r.job_id ? (r.job_status === 'pending' ? 'queued' : r.job_status) : r.state) as CommenterRowStatus['status']
    counts[status] = (counts[status] ?? 0) + 1
    return { profile_url: r.profile_url, derived_name: r.derived_name, name_source: 'derived', status, job_id: r.job_id, leads: r.job_id ? r.leads : null, error: r.job_id ? r.error : null, note: r.note }
  })
  return { batch_id: batch.id, total: batch.total, note: batch.note, created_at: batch.created_at, counts, rows: out }
}
