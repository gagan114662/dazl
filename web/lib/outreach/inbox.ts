// Inbox and Outcomes conversations, paginated and filtered on the server (#369). One row per thread: the thread's
// deciding reply is chosen first, then filters apply, then the page is cut, so a busy play can never push an older
// conversation of another play off the page. Totals are counted over the same per-thread rows, independent of the page.
//
// The deciding reply of a thread is its newest message a person wrote; an auto-reply or a soft bounce decides only when
// the thread has nothing else (an out-of-office after "yes, tell me more" must not hide the yes). A later "no" or
// opt-out still closes an earlier "yes": both are written by a person.
//
// Its table (inbox_thread_reads) is created with the other reply tables in migrateReplies (lib/outreach/replies.ts).
// On the Db layer (both engines). Tenant scope: every row is the tenant's own inbound_messages; the lead and play come
// from leads joined through the tenant's own scan_jobs, so another tenant's lead id never labels or filters a row.
import { asDb, type DbLike, type Param } from '../db/client.ts'

// Owner-facing states. needs_owner (the same rule as lib/outcomes.ts): an interested, unsorted or uncertain reply on a
// thread that is not stopped, or stopped for review; an uncertain reply also on a thread stopped for a weaker reason.
// Only an opt-out, a "no", a bounce or a suppression settles a thread.
export const NEEDS_OWNER_CLASSES = ['positive', 'other', 'uncertain'] as const
const MACHINE = "('auto','soft_bounce')"
export type InboxStatus = 'all' | 'needs_owner' | 'unread'
export const INBOX_STATUSES: InboxStatus[] = ['all', 'needs_owner', 'unread']
export const PAGE_MAX = 100

export interface InboxThread {
  thread_id: string; gmail_id: string; lead_id: string | null; job_id: string | null; from_email: string; excerpt: string
  classification: string; received_at: number; replies: number; company: string | null; lead_name: string | null
  followups_sent: number | null; stopped: string | null; unread: boolean; needs_owner: boolean
}
export interface InboxCounts { threads: number; needs_owner: number; unread: number; unread_needs_owner: number }
export interface InboxPage { threads: InboxThread[]; next_cursor: string | null; counts: InboxCounts }
export interface InboxQuery { jobId?: string | null; threadId?: string | null; status?: InboxStatus; classification?: string | null; cursor?: string | null; limit?: number }

// Cursor: the last row's (received_at, thread_id), opaque to the client. Anything malformed is refused, never guessed.
export function encodeCursor(at: number, threadId: string): string { return Buffer.from(JSON.stringify([at, threadId])).toString('base64url') }
export function decodeCursor(c: string): { at: number; threadId: string } | null {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown
    if (!Array.isArray(v) || v.length !== 2 || !Number.isSafeInteger(v[0]) || typeof v[1] !== 'string' || v[1].length > 200) return null
    return { at: v[0], threadId: v[1] }
  } catch { return null }
}

// The per-thread rows, before page filters. Window functions run on both engines (SQLite >= 3.25).
function threadsSql(jobFilter: boolean): string {
  return `WITH ranked AS (
      SELECT m.thread_id, m.gmail_id, m.lead_id, m.from_email, m.excerpt, m.classification, m.received_at,
             COUNT(*) OVER (PARTITION BY m.thread_id) AS replies,
             ROW_NUMBER() OVER (PARTITION BY m.thread_id ORDER BY CASE WHEN m.classification IN ${MACHINE} THEN 1 ELSE 0 END, m.received_at DESC, m.gmail_id DESC) AS rn,
             MAX(m.received_at) OVER (PARTITION BY m.thread_id) AS last_at
      FROM inbound_messages m WHERE m.tenant_id = ?
    ), th AS (
      SELECT r.thread_id, r.gmail_id, r.lead_id, j.id AS job_id, r.from_email, r.excerpt, r.classification, r.received_at, r.replies,
             l.company, l.name AS lead_name, t.followups_sent, t.stopped,
             CASE WHEN rd.read_upto IS NULL OR r.last_at > rd.read_upto THEN 1 ELSE 0 END AS unread,
             CASE WHEN r.classification IN ('positive','other','uncertain','bounce_review') AND (t.stopped IS NULL OR t.stopped = 'review'
               OR (r.classification = 'uncertain' AND t.stopped NOT IN ('opt_out','negative','bounce','suppressed'))) THEN 1 ELSE 0 END AS needs_owner
      FROM ranked r
      LEFT JOIN leads l ON l.id = r.lead_id AND EXISTS (SELECT 1 FROM scan_jobs sj WHERE sj.id = l.scan_job_id AND sj.user_id = ?)
      LEFT JOIN scan_jobs j ON j.id = l.scan_job_id
      LEFT JOIN followup_threads t ON t.tenant_id = ? AND t.thread_id = r.thread_id
      LEFT JOIN inbox_thread_reads rd ON rd.tenant_id = ? AND rd.thread_id = r.thread_id
      WHERE r.rn = 1
    )
    SELECT * FROM th WHERE 1 = 1${jobFilter ? ' AND job_id = ?' : ''}`
}

export async function inboxPage(d: DbLike, tenantId: string, q: InboxQuery = {}): Promise<InboxPage> {
  const db = asDb(d)
  const limit = Math.max(1, Math.min(PAGE_MAX, Math.floor(q.limit ?? 50)))
  const base: Param[] = [tenantId, tenantId, tenantId, tenantId]
  if (q.jobId) base.push(q.jobId)
  const sql = threadsSql(!!q.jobId)
  const where: string[] = [], params: Param[] = [...base]
  if (q.threadId) { where.push('thread_id = ?'); params.push(q.threadId) }
  if (q.status === 'needs_owner') where.push('needs_owner = 1')
  if (q.status === 'unread') where.push('unread = 1')
  if (q.classification) { where.push('classification = ?'); params.push(q.classification) }
  if (q.cursor) {
    const c = decodeCursor(q.cursor)
    if (!c) throw new InboxQueryError('bad_cursor')
    where.push('(received_at < ? OR (received_at = ? AND thread_id < ?))'); params.push(c.at, c.at, c.threadId)
  }
  params.push(limit + 1)
  const rows = await db.all<Omit<InboxThread, 'unread' | 'needs_owner'> & { unread: number; needs_owner: number }>(
    `SELECT * FROM (${sql}) x${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY received_at DESC, thread_id DESC LIMIT ?`, params)
  const page = rows.slice(0, limit).map(r => ({ ...r, unread: r.unread === 1, needs_owner: r.needs_owner === 1 }))
  const last = page[page.length - 1]
  const c = await db.get<{ threads: number | null; needs_owner: number | null; unread: number | null; unread_needs_owner: number | null }>(
    `SELECT COUNT(*) AS threads, SUM(needs_owner) AS needs_owner, SUM(unread) AS unread, SUM(unread * needs_owner) AS unread_needs_owner FROM (${sql}) x`, base)
  return {
    threads: page,
    next_cursor: rows.length > limit && last ? encodeCursor(last.received_at, last.thread_id) : null,
    counts: { threads: Number(c?.threads ?? 0), needs_owner: Number(c?.needs_owner ?? 0), unread: Number(c?.unread ?? 0), unread_needs_owner: Number(c?.unread_needs_owner ?? 0) },
  }
}

// The owner opened the thread: everything received up to now in it is read. Only the tenant's own thread can be marked.
export async function markThreadRead(d: DbLike, tenantId: string, threadId: string): Promise<boolean> {
  const db = asDb(d)
  const r = await db.get<{ at: number | null }>('SELECT MAX(received_at) AS at FROM inbound_messages WHERE tenant_id = ? AND thread_id = ?', [tenantId, threadId])
  if (r?.at === null || r?.at === undefined) return false
  await db.run(`INSERT INTO inbox_thread_reads (tenant_id, thread_id, read_upto) VALUES (?, ?, ?)
                ON CONFLICT (tenant_id, thread_id) DO UPDATE SET read_upto = CASE WHEN excluded.read_upto > inbox_thread_reads.read_upto THEN excluded.read_upto ELSE inbox_thread_reads.read_upto END`,
  [tenantId, threadId, Number(r.at)])
  return true
}

export class InboxQueryError extends Error {
  code: 'bad_cursor' | 'bad_status'
  constructor(code: 'bad_cursor' | 'bad_status') { super(code); this.code = code }
}

// Query-string parsing for the route; refuses rather than guesses.
export function parseInboxQuery(sp: URLSearchParams): InboxQuery {
  const status = (sp.get('status') ?? 'all') as InboxStatus
  if (!INBOX_STATUSES.includes(status)) throw new InboxQueryError('bad_status')
  const limit = Number(sp.get('limit') ?? 50)
  return {
    jobId: sp.get('job_id') || null, threadId: sp.get('thread') || null, status, classification: sp.get('class') || null, cursor: sp.get('cursor') || null,
    limit: Number.isFinite(limit) ? limit : 50,
  }
}
