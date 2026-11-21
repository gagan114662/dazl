// Operator resolution of one stuck pending spend marker, with evidence (#1441 review). Never a timer: a marker is
// resolved only when the call it belongs to is found and that call's scan job is terminal (done/failed, not claimed).
// Resolving keeps the full worst-case reservation in the day/month windows (nothing refunded or repriced): the
// marker row becomes 'r:<id>' (the record), and a linked call row is marked 'kept' with the operator's reason.
// An unattributed marker (no call found) or one whose job is still active is refused: it needs a person to find out.
import type Database from 'better-sqlite3'

export interface MarkerEvidence {
  period: string; reserved_usd: number; age_s: number; failed_settle: boolean
  call: { id: string; scan_job_id: string; kind: string; status: string; reserve_usd: number; created_at: number } | null
  job: { id: string; status: string; error: string | null; claimed_at: number | null; finished_at: number | null } | null
  resolvable: boolean; why: string
}

const hasTable = (db: Database.Database, t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)

export function markerEvidence(db: Database.Database, tenant: string, now: number): MarkerEvidence[] {
  const rows = db.prepare("SELECT period, reserved_usd, updated_at FROM tenant_spend_pools WHERE tenant_id = ? AND period LIKE 'p:%' ORDER BY period").all(tenant) as { period: string; reserved_usd: number; updated_at: number }[]
  const calls = hasTable(db, 'scan_spend_calls'), jobs = hasTable(db, 'scan_jobs')
  return rows.map(r => {
    const id = r.period.slice(2)
    const call = calls ? (db.prepare("SELECT id, scan_job_id, kind, status, reserve_usd, created_at FROM scan_spend_calls WHERE user_id = ? AND (id = ? OR reason = ?) ORDER BY created_at DESC LIMIT 1").get(tenant, id, `native_legacy_link:${r.period}`) as MarkerEvidence['call'] | undefined) ?? null : null
    const job = call && jobs ? (db.prepare('SELECT id, status, error, claimed_at, finished_at FROM scan_jobs WHERE id = ? AND user_id = ?').get(call.scan_job_id, tenant) as MarkerEvidence['job'] | undefined) ?? null : null
    const terminal = !!job && (job.status === 'done' || job.status === 'failed') && job.claimed_at === null
    const why = !call ? 'unattributed: no call row links to this marker; find the call before resolving'
      : !job ? 'the linked call has no scan job of this tenant'
      : !terminal ? `the linked scan job is ${job.status}${job.claimed_at !== null ? ' (claimed)' : ''}: the call may still be running`
      : 'linked call belongs to a finished scan job'
    return { period: r.period, reserved_usd: r.reserved_usd, age_s: now - Number(r.updated_at), failed_settle: Number(r.updated_at) === 0, call, job, resolvable: terminal, why }
  })
}

// The durable record of every operator resolution (one row per marker), whatever state the call row is in.
function ensureLog(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS spend_marker_resolutions (
    tenant_id TEXT NOT NULL, period TEXT NOT NULL, reserved_usd REAL NOT NULL, call_id TEXT, scan_job_id TEXT,
    reason TEXT NOT NULL CHECK (length(reason) <= 500), resolved_at INTEGER NOT NULL, PRIMARY KEY (tenant_id, period))`)
}

export function resolveMarker(db: Database.Database, tenant: string, period: string, reason: string, now: number): MarkerEvidence {
  if (!/^p:[0-9a-z]{10}$/.test(period)) throw new Error('not a pending marker period')
  const clean = reason.replace(/\s+/g, ' ').trim()
  if (clean.length < 8) throw new Error('a recorded reason (8+ characters) is required')
  ensureLog(db)
  return db.transaction(() => {
    const ev = markerEvidence(db, tenant, now).find(e => e.period === period)
    if (!ev) throw new Error('no such pending marker for this workspace')
    if (!ev.resolvable) throw new Error(`refused: ${ev.why}`)
    const moved = db.prepare("UPDATE tenant_spend_pools SET period = 'r:' || substr(period, 3), updated_at = ? WHERE tenant_id = ? AND period = ?").run(now, tenant, period)
    if (moved.changes !== 1) throw new Error('marker changed during resolution')
    db.prepare('INSERT INTO spend_marker_resolutions (tenant_id, period, reserved_usd, call_id, scan_job_id, reason, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(tenant, period, ev.reserved_usd, ev.call?.id ?? null, ev.call?.scan_job_id ?? null, clean.slice(0, 500), now)
    if (ev.call && ev.call.status === 'reserved') db.prepare("UPDATE scan_spend_calls SET status = 'kept', reason = ?, settled_at = ? WHERE id = ? AND user_id = ? AND status = 'reserved'").run(`operator: ${clean}`.slice(0, 80), now, ev.call.id, tenant)
    return ev
  })()
}
