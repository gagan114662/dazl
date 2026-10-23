// CSV bulk import of company domains (Pro only). Each valid domain becomes one
// per-company scan job that runs the same research, verification and enrichment
// pipeline as a manual scan; each job counts as one scan against the monthly plan
// quota. Never trial-funded: the route requires the tenant's own LLM key and a Pro
// plan before a batch is accepted.
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { scanQuota } from '../plans.ts'

export const MAX_DOMAINS = 50

export function migrateCsv(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS csv_batches (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      total      INTEGER NOT NULL,
      note       TEXT,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );
    CREATE INDEX IF NOT EXISTS csv_batches_user ON csv_batches (user_id, created_at);

    CREATE TABLE IF NOT EXISTS csv_rows (
      id       TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES csv_batches(id) ON DELETE CASCADE,
      domain   TEXT NOT NULL CHECK (length(domain) BETWEEN 1 AND 253),
      state    TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','skipped')),
      note     TEXT,
      job_id   TEXT REFERENCES scan_jobs(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS csv_rows_batch ON csv_rows (batch_id);
  `)
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/
// TLDs that never name a public company site.
const INTERNAL_TLDS = new Set(['local', 'localhost', 'internal', 'lan', 'corp', 'home', 'test', 'invalid', 'example'])

// Turns one uploaded cell into a bare hostname, or says why it is not one.
// Protocol, credentials, port and path are stripped; www. and case are normalized away.
export function normalizeDomain(raw: string): { domain: string } | { reason: string } {
  let s = raw.trim().toLowerCase()
  if (!s) return { reason: 'blank' }
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  s = s.split('@').pop() ?? s
  s = s.split(/[/?#]/)[0]
  s = s.replace(/:\d+$/, '')
  s = s.replace(/^www\./, '').replace(/\.$/, '')
  if (!s) return { reason: 'blank' }
  if (IPV4_RE.test(s) || s.includes(':')) return { reason: 'ip addresses are not allowed' }
  if (!HOST_RE.test(s)) return { reason: 'not a valid hostname' }
  if (INTERNAL_TLDS.has(s.split('.').pop()!)) return { reason: 'internal hosts are not allowed' }
  return { domain: s }
}

export interface ParsedCsv {
  valid: string[]
  invalid: { line: string; reason: string }[]
  overflow: number // valid domains beyond MAX_DOMAINS, not imported
}

// One domain per line; anything after the first comma on a line is ignored (a real CSV
// with extra columns still imports). Blank rows are skipped silently; invalid rows are
// flagged in the result; duplicates collapse to their first occurrence.
export function parseDomains(text: string, max = MAX_DOMAINS): ParsedCsv {
  const seen = new Set<string>()
  const valid: string[] = []
  const invalid: { line: string; reason: string }[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    let cell = rawLine.trim()
    if (!cell) continue
    const quoted = /^"((?:[^"]|"")*)"/.exec(cell)
    cell = (quoted ? quoted[1].replace(/""/g, '"') : cell.split(',')[0]).trim()
    if (!cell) continue
    const r = normalizeDomain(cell)
    if ('reason' in r) { invalid.push({ line: cell.slice(0, 100), reason: r.reason }); continue }
    if (seen.has(r.domain)) continue
    seen.add(r.domain)
    valid.push(r.domain)
  }
  const overflow = Math.max(0, valid.length - max)
  return { valid: valid.slice(0, max), invalid, overflow }
}

export function createBatch(db: Database.Database, userId: string, domains: string[]): string {
  const id = randomBytes(12).toString('hex')
  db.transaction(() => {
    db.prepare('INSERT INTO csv_batches (id, user_id, total) VALUES (?, ?, ?)').run(id, userId, domains.length)
    const ins = db.prepare('INSERT INTO csv_rows (id, batch_id, domain) VALUES (?, ?, ?)')
    for (const d of domains) ins.run(randomBytes(12).toString('hex'), id, d)
  })()
  return id
}

// Creates one scan job per pending row until the plan quota stops the batch. Rows left
// without a job stay pending so a later resume (new month, upgraded plan) can pick them up.
export const RUN_BUDGET_KEYS = ['paid_fallback', 'credit_enrichment', 'judge'] as const
// Normalize an explicitly supplied per-run budget. Absent (undefined/null) means
// current behavior. An explicitly supplied budget must be a plain object using
// only the known narrowing keys, each === false; anything else is REJECTED so a
// caller expecting a restricted run is never silently widened into a full run.
export function normalizeRunBudget(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'budget must be an object' }
  const keys = Object.keys(raw as Record<string, unknown>)
  if (keys.length === 0) return { ok: false, error: 'budget names no controls' }
  const out: Record<string, false> = {}
  for (const k of keys) {
    if (!(RUN_BUDGET_KEYS as readonly string[]).includes(k)) return { ok: false, error: `unknown budget control: ${k}` }
    if ((raw as Record<string, unknown>)[k] !== false) return { ok: false, error: `budget.${k} accepts only false - the control can only narrow a run` }
    out[k] = false
  }
  return { ok: true, value: JSON.stringify(out) }
}

export function queuePendingRows(db: Database.Database, userId: string, batchId: string, runBudget: string | null = null): { queued: number; quotaStop: boolean } {
  const batch = db.prepare('SELECT id FROM csv_batches WHERE id = ? AND user_id = ?').get(batchId, userId)
  if (!batch) return { queued: 0, quotaStop: false }
  const rows = db.prepare("SELECT id, domain FROM csv_rows WHERE batch_id = ? AND state = 'pending' AND job_id IS NULL ORDER BY rowid").all(batchId) as { id: string; domain: string }[]
  let queued = 0
  let quotaStop = false
  for (const row of rows) {
    if (!scanQuota(db, userId).allowed) { quotaStop = true; break }
    const jobId = randomBytes(12).toString('hex')
    db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, csv_domain, batch_id, run_budget) VALUES (?, ?, ?, '-', '-', ?, ?, ?)").run(jobId, userId, row.domain.slice(0, 150), row.domain, batchId, runBudget)
    db.prepare('UPDATE csv_rows SET job_id = ? WHERE id = ?').run(jobId, row.id)
    queued++
  }
  if (quotaStop) {
    const { n } = db.prepare('SELECT count(*) AS n FROM csv_rows WHERE batch_id = ? AND job_id IS NOT NULL').get(batchId) as { n: number }
    const { total } = db.prepare('SELECT total FROM csv_batches WHERE id = ?').get(batchId) as { total: number }
    db.prepare('UPDATE csv_batches SET note = ? WHERE id = ?').run(`${n} of ${total} ran, quota reached`, batchId)
  }
  return { queued, quotaStop }
}

export interface CsvRowStatus { domain: string; status: 'pending' | 'skipped' | 'queued' | 'running' | 'done' | 'failed'; job_id: string | null; leads: number | null; error: string | null; note: string | null }
export interface CsvBatchStatus { batch_id: string; total: number; note: string | null; created_at: number; counts: Record<string, number>; rows: CsvRowStatus[] }

export function batchStatus(db: Database.Database, userId: string, batchId: string): CsvBatchStatus | undefined {
  const batch = db.prepare('SELECT id, total, note, created_at FROM csv_batches WHERE id = ? AND user_id = ?').get(batchId, userId) as { id: string; total: number; note: string | null; created_at: number } | undefined
  if (!batch) return undefined
  const rows = db.prepare(
    `SELECT r.domain, r.state, r.note, r.job_id, j.status AS job_status, j.error,
            (SELECT count(*) FROM leads l WHERE l.scan_job_id = j.id) AS leads
     FROM csv_rows r LEFT JOIN scan_jobs j ON j.id = r.job_id
     WHERE r.batch_id = ? ORDER BY r.rowid`,
  ).all(batchId) as { domain: string; state: string; note: string | null; job_id: string | null; job_status: string | null; error: string | null; leads: number | null }[]
  const counts: Record<string, number> = {}
  const out: CsvRowStatus[] = rows.map(r => {
    const status = (r.job_id ? (r.job_status === 'pending' ? 'queued' : r.job_status) : r.state) as CsvRowStatus['status']
    counts[status] = (counts[status] ?? 0) + 1
    return { domain: r.domain, status, job_id: r.job_id, leads: r.job_id ? r.leads : null, error: r.job_id ? r.error : null, note: r.note }
  })
  return { batch_id: batch.id, total: batch.total, note: batch.note, created_at: batch.created_at, counts, rows: out }
}
