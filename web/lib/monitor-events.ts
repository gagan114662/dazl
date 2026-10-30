// Event-level change detection for monitors (#387). A monitor re-runs a scan; what is worth an alert is not "a company name not seen before" (monitor_seen.dedup_key)
// but, per tenant: a NEW COMPANY with an actionable event, a NEW SIGNAL (a genuinely new event for a known company), a lead that BECAME ACTIONABLE, or a lead whose
// contact became verified (NOW REACHABLE). Repeated old news, a blocked / needs-review research item, and an event already alerted by another play are suppressed.
// Every event carries first-seen / occurred / last-checked; each source has a cursor; detection latency and missed-run recovery are reported. Verified-only: this reads the
// leads the pipeline already verified and never loosens a gate. Db layer (SQLite + Postgres); migrateMonitorEvents is the SQLite setup.
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Db, Tx, TxBody } from './db/client.ts'

export function migrateMonitorEvents(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitor_events (
      user_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      monitor_id TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      occurred_at INTEGER,
      last_checked_at INTEGER NOT NULL,
      first_actionable_at INTEGER,
      reachable INTEGER NOT NULL DEFAULT 0,
      alerted_kind TEXT,
      alerted_at INTEGER,
      PRIMARY KEY (user_id, event_key)
    );
    CREATE INDEX IF NOT EXISTS monitor_events_entity ON monitor_events (user_id, entity_key);
    CREATE TABLE IF NOT EXISTS monitor_alerts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      monitor_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('new_company','new_signal','newly_actionable','now_reachable')),
      company TEXT,
      latency_s INTEGER,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS monitor_alerts_run ON monitor_alerts (run_id);
    CREATE TABLE IF NOT EXISTS monitor_cursors (
      monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      last_event_at INTEGER,
      last_checked_at INTEGER NOT NULL,
      PRIMARY KEY (monitor_id, source)
    );
  `)
}

export type AlertKind = 'new_company' | 'new_signal' | 'newly_actionable' | 'now_reachable'
export interface AlertPolicy { kinds: ReadonlySet<AlertKind>; maxAgeDays: number }
export const DEFAULT_POLICY: AlertPolicy = { kinds: new Set<AlertKind>(['new_company', 'new_signal', 'newly_actionable', 'now_reachable']), maxAgeDays: 90 }

export interface RunLead { company: string; company_domain: string | null; contact: string | null; source_url: string; event_date: string | null; signal: string; review_reason: string | null; confidence: number | null; quarantined_at: number | null; date_status: string | null }
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\b(?:inc|llc|ltd|corp|co|the|gmbh)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
const host = (d: string) => d.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0]
export const entityKeyOf = (l: Pick<RunLead, 'company' | 'company_domain'>) => (l.company_domain && host(l.company_domain).includes('.') ? `d:${host(l.company_domain)}` : `n:${slug(l.company)}`)
const cleanUrl = (u: string) => u.toLowerCase().replace(/^[a-z]+:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '')
// An event is the company plus what happened and where it is stated: the same news re-found next week is the same event; a new dated article is a new one.
export const eventKeyOf = (l: RunLead) => `${entityKeyOf(l)}|${l.event_date ?? 'undated'}|${l.event_date ? cleanUrl(l.source_url) : slug(l.signal).slice(0, 60)}`
export const sourceOf = (l: Pick<RunLead, 'source_url'>) => host(l.source_url) || 'unknown'
const dayS = (d: string | null) => { const t = d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(`${d}T00:00:00Z`) : NaN; return Number.isFinite(t) ? Math.floor(t / 1000) : null }

// ACTIONABLE = what the pipeline already treats as a verified, usable lead: no review reason (so a blocked or needs-review research item is not one), a confidence, not quarantined,
// a named company and a date that was not found unverified. Reachable = it carries a contact (the contact gates ran in the pipeline).
export const actionable = (l: RunLead) => l.review_reason == null && l.confidence != null && l.quarantined_at == null && !!l.company.trim() && l.date_status !== 'unverified'
export const reachable = (l: RunLead) => actionable(l) && !!l.contact?.trim()

export interface Prior { entityKnown: boolean; event: { first_actionable_at: number | null; reachable: boolean; alerted_kind: AlertKind | null; occurred_at: number | null } | null }
export type Decision = { alert: AlertKind } | { suppress: 'not_actionable' | 'old_news' | 'unchanged' | 'policy' | 'already_alerted' }
export function decide(l: RunLead, prior: Prior, now: number, policy: AlertPolicy = DEFAULT_POLICY): Decision {
  const act = actionable(l)
  if (!act) return { suppress: 'not_actionable' }                       // blocked / research / needs-review never inflates the alert count
  const occ = dayS(l.event_date)
  if (!prior.event && occ !== null && now - occ > policy.maxAgeDays * 86400) return { suppress: 'old_news' }   // old news is recorded, not alerted
  let kind: AlertKind | null = null
  if (!prior.event) kind = prior.entityKnown ? 'new_signal' : 'new_company'
  else if (prior.event.first_actionable_at === null) kind = 'newly_actionable'
  else if (!prior.event.reachable && reachable(l)) kind = 'now_reachable'
  if (!kind) return { suppress: 'unchanged' }
  return policy.kinds.has(kind) ? { alert: kind } : { suppress: 'policy' }
}

export interface FoldResult { alerts: { kind: AlertKind; company: string; event_key: string; latency_s: number | null }[]; suppressed: Record<string, number> }
// Fold one finished run into the tenant's event state in the caller's transaction: records first-seen / occurred / last-checked, decides, writes alerts, advances source cursors.
export function* foldRunEvents(t: Tx, a: { userId: string; monitorId: string; runId: string; leads: RunLead[]; now: number; policy?: AlertPolicy }): TxBody<FoldResult> {
  const policy = a.policy ?? DEFAULT_POLICY, out: FoldResult = { alerts: [], suppressed: {} }
  const entitySeen = new Set<string>()
  for (const l of a.leads) {
    const ek = entityKeyOf(l), ev = eventKeyOf(l), occ = dayS(l.event_date), act = actionable(l), rc = reachable(l)
    const row = yield* t.get<{ first_actionable_at: number | null; reachable: number; alerted_kind: AlertKind | null; occurred_at: number | null }>('SELECT first_actionable_at, reachable, alerted_kind, occurred_at FROM monitor_events WHERE user_id = ? AND event_key = ?', [a.userId, ev])
    let known = entitySeen.has(ek)
    if (!known) known = !!(yield* t.get('SELECT 1 AS x FROM monitor_events WHERE user_id = ? AND entity_key = ? AND event_key <> ? LIMIT 1', [a.userId, ek, ev]))
    const prior: Prior = { entityKnown: known, event: row ? { first_actionable_at: row.first_actionable_at == null ? null : Number(row.first_actionable_at), reachable: !!Number(row.reachable), alerted_kind: row.alerted_kind, occurred_at: row.occurred_at == null ? null : Number(row.occurred_at) } : null }
    const d = decide(l, prior, a.now, policy)
    entitySeen.add(ek)
    if (!row) yield* t.run('INSERT INTO monitor_events (user_id, event_key, entity_key, monitor_id, first_seen_at, occurred_at, last_checked_at, first_actionable_at, reachable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, event_key) DO NOTHING', [a.userId, ev, ek, a.monitorId, a.now, occ, a.now, act ? a.now : null, rc ? 1 : 0])
    else yield* t.run('UPDATE monitor_events SET last_checked_at = ?, first_actionable_at = COALESCE(first_actionable_at, ?), reachable = CASE WHEN ? = 1 THEN 1 ELSE reachable END WHERE user_id = ? AND event_key = ?', [a.now, act ? a.now : null, rc ? 1 : 0, a.userId, ev])
    if ('alert' in d) {
      const latency = occ === null ? null : Math.max(0, a.now - occ)
      yield* t.run('INSERT INTO monitor_alerts (id, user_id, monitor_id, run_id, event_key, entity_key, kind, company, latency_s, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [randomBytes(12).toString('hex'), a.userId, a.monitorId, a.runId, ev, ek, d.alert, l.company.slice(0, 120), latency, a.now])
      yield* t.run('UPDATE monitor_events SET alerted_kind = ?, alerted_at = ? WHERE user_id = ? AND event_key = ?', [d.alert, a.now, a.userId, ev])
      out.alerts.push({ kind: d.alert, company: l.company, event_key: ev, latency_s: latency })
    } else out.suppressed[d.suppress] = (out.suppressed[d.suppress] ?? 0) + 1
    const src = sourceOf(l)
    yield* t.run('INSERT INTO monitor_cursors (monitor_id, source, last_event_at, last_checked_at) VALUES (?, ?, ?, ?) ON CONFLICT (monitor_id, source) DO UPDATE SET last_event_at = CASE WHEN excluded.last_event_at IS NOT NULL AND (monitor_cursors.last_event_at IS NULL OR excluded.last_event_at > monitor_cursors.last_event_at) THEN excluded.last_event_at ELSE monitor_cursors.last_event_at END, last_checked_at = excluded.last_checked_at', [a.monitorId, src, occ, a.now])
  }
  return out
}

// Detection latency (how long after the event happened dazl first alerted) and missed-run recovery (how many scheduled runs were skipped and whether the next run still covers them).
export async function detectionLatency(db: Db, userId: string, sinceS: number): Promise<{ alerts: number; withDate: number; medianS: number | null; maxS: number | null }> {
  const rows = await db.all<{ latency_s: number | null }>('SELECT latency_s FROM monitor_alerts WHERE user_id = ? AND at >= ?', [userId, sinceS])
  const l = rows.map(r => r.latency_s).filter((x): x is number => x != null).map(Number).sort((a, b) => a - b)
  return { alerts: rows.length, withDate: l.length, medianS: l.length ? l[Math.floor(l.length / 2)] : null, maxS: l.length ? l[l.length - 1] : null }
}
export function missedRuns(m: { last_run_at: number | null; interval_hours: number }, now: number): { missed: number; gapS: number | null; lookbackDays: number } {
  const iv = m.interval_hours * 3600
  const gap = m.last_run_at == null ? null : now - m.last_run_at, missed = gap == null ? 0 : Math.max(0, Math.floor(gap / iv) - 1)
  // after a gap the next run must look back far enough to cover the missed window (plus one interval of overlap), never less than the normal freshness target
  return { missed, gapS: gap, lookbackDays: Math.max(1, Math.ceil(((gap ?? iv) + iv) / 86400)) }
}
