// Continuous event detection for monitors (#387). A monitor re-runs its play on the existing scheduler; this module
// decides which of a finished run's leads are worth an alert. Before it, a run's "new" count was every company name the
// monitor had not stored yet, review lane included, so a blocked research item or the same news re-found under another
// company spelling counted as new. Now an alert is one of three state changes of a DATED EVENT, per tenant:
//   new_company   - the first actionable event of a company the tenant has had no actionable event for
//   new_signal    - a genuinely new actionable event (another event date / kind) for a company already alerted on
//   now_reachable - an event already alerted on whose lead is now actionable end to end (domain, matching person and a
//                   published contact route: the `scan:actionable` verdict lib/scan/actionable.ts writes)
// Everything else is suppressed with a reason: undated or unverified-date leads, events outside the play's window (old
// news, future dates), blocked / needs-review / quarantined / held research items, and an event already seen by ANY of
// the tenant's plays (dedupe across plays). Each event keeps first_seen / occurred / last_checked / actionable / reachable
// timestamps; each monitor keeps a cursor per source host; each alert keeps its detection latency.
// No network and no paid calls: this only reads rows the scan pipeline already wrote and gated, inside the caller's
// transaction. The scans themselves stay on the scheduler's quota and the runner's spend reservation (lib/monitors.ts).
// Db layer (SQLite + Postgres); migrateMonitorEvents is the SQLite setup, pg/0045_monitor_events.sql the Postgres one.
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Db, Tx, TxBody } from './db/client.ts'
import { windowStatus } from './scan/window.ts'

export function migrateMonitorEvents(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitor_events (
      user_id         TEXT NOT NULL,
      event_key       TEXT NOT NULL,
      entity_key      TEXT NOT NULL,
      monitor_id      TEXT NOT NULL,
      occurred_at     INTEGER NOT NULL,
      first_seen_at   INTEGER NOT NULL,
      last_checked_at INTEGER NOT NULL,
      actionable_at   INTEGER,
      reachable_at    INTEGER,
      PRIMARY KEY (user_id, event_key)
    );
    CREATE INDEX IF NOT EXISTS monitor_events_entity ON monitor_events (user_id, entity_key);
    CREATE TABLE IF NOT EXISTS monitor_alerts (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      run_id     TEXT NOT NULL,
      event_key  TEXT NOT NULL,
      kind       TEXT NOT NULL CHECK (kind IN ('new_company','new_signal','now_reachable')),
      company    TEXT NOT NULL,
      latency_s  INTEGER NOT NULL,
      at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS monitor_alerts_monitor ON monitor_alerts (monitor_id, at);
    CREATE TABLE IF NOT EXISTS monitor_cursors (
      monitor_id      TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      source          TEXT NOT NULL,
      last_event_at   INTEGER,
      last_checked_at INTEGER NOT NULL,
      PRIMARY KEY (monitor_id, source)
    );
  `)
}

export type AlertKind = 'new_company' | 'new_signal' | 'now_reachable'
// The selected alert policy, per monitor: 'all' three kinds; 'reachable' only events that can be acted on now (a new
// event whose lead is already reachable, or now_reachable); 'new_companies' only new_company. The policy filters what is
// alerted, never what is recorded: state changes are tracked the same way under every policy.
export const ALERT_POLICIES = ['all', 'reachable', 'new_companies'] as const
export type AlertPolicy = typeof ALERT_POLICIES[number]
export const isAlertPolicy = (v: unknown): v is AlertPolicy => typeof v === 'string' && (ALERT_POLICIES as readonly string[]).includes(v)
// A play with no window of its own ("in the past 30 days") is held to this one: an event older than this is old news.
export const DEFAULT_EVENT_WINDOW_DAYS = 90

export interface RunLead {
  company: string; company_domain: string | null; event_date: string | null; date_status: string | null; signal_kind: string | null
  source_url: string; review_reason: string | null; confidence: number | null; quarantined_at: number | null
  held: boolean       // a required gate failed and its review write was rejected (the scan:gate marker): never verified
  reachable: boolean  // the scan's own actionability verdict: domain, matching person and published route confirmed
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\b(?:inc|llc|ltd|limited|corp|co|the|gmbh)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
const hostOf = (u: string) => u.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0]
export const entityKeyOf = (l: Pick<RunLead, 'company' | 'company_domain'>): string =>
  l.company_domain && hostOf(l.company_domain).includes('.') ? `d:${hostOf(l.company_domain)}` : `n:${slug(l.company)}`
// One event = the company, the day it happened and what kind of thing happened. The same news re-found next week, or
// reported by a second outlet, is the same event; a later dated event for the same company is a new one.
export const eventKeyOf = (l: RunLead): string => `${entityKeyOf(l)}|${l.event_date}|${l.signal_kind ?? 'signal'}`
export const sourceOf = (l: Pick<RunLead, 'source_url'>): string => hostOf(l.source_url) || 'unknown'
const dayStartS = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000)

// Verified: what the pipeline already treats as a usable lead. A review-lane item (blocked page, needs JavaScript, quote
// unconfirmed...), a quarantined lead or a held one is research, never a new actionable lead.
export const verified = (l: RunLead): boolean => l.review_reason == null && l.confidence != null && l.quarantined_at == null && !l.held && !!l.company.trim()

export type Suppress = 'undated' | 'out_of_window' | 'not_actionable' | 'already_seen' | 'policy'
export interface PriorEvent { actionable_at: number | null; reachable_at: number | null }
export type Decision = { kind: AlertKind; alert: boolean } | { suppress: Exclude<Suppress, 'policy'> }

// Pure. `windowDays`: the play's own window, else DEFAULT_EVENT_WINDOW_DAYS. `entityKnown`: the tenant already had an
// actionable event for this company. A transition with alert=false was filtered by the policy (still recorded).
export function decide(l: RunLead, prior: PriorEvent | null, entityKnown: boolean, policy: AlertPolicy, windowDays: number, now: number): Decision {
  if (l.date_status !== 'verified' || !l.event_date) return { suppress: 'undated' }          // only dated events can be new
  if (windowStatus(l.event_date, windowDays, new Date(now * 1000)) !== 'inside') return { suppress: 'out_of_window' }  // old news, future or bad dates
  if (!verified(l)) return { suppress: 'not_actionable' }
  let kind: AlertKind
  if (!prior || prior.actionable_at == null) kind = entityKnown ? 'new_signal' : 'new_company'
  else if (prior.reachable_at == null && l.reachable) kind = 'now_reachable'
  else return { suppress: 'already_seen' }
  const alert = policy === 'all' || (policy === 'reachable' && l.reachable) || (policy === 'new_companies' && kind === 'new_company')
  return { kind, alert }
}

export interface FoldResult { alerts: { kind: AlertKind; company: string; event_key: string; latency_s: number }[]; suppressed: Partial<Record<Suppress, number>> }

// Fold one finished run into the tenant's event state, in the caller's transaction: records first-seen / occurred /
// last-checked / actionable / reachable, writes the alerts the policy allows, advances this monitor's source cursors.
export function* foldRunEvents(t: Tx, a: { userId: string; monitorId: string; runId: string; leads: RunLead[]; policy: AlertPolicy; windowDays: number; now: number }): TxBody<FoldResult> {
  const out: FoldResult = { alerts: [], suppressed: {} }
  const bump = (s: Suppress) => { out.suppressed[s] = (out.suppressed[s] ?? 0) + 1 }
  for (const l of a.leads) {
    if (l.date_status !== 'verified' || !l.event_date || windowStatus(l.event_date, a.windowDays, new Date(a.now * 1000)) !== 'inside') {
      bump(l.date_status !== 'verified' || !l.event_date ? 'undated' : 'out_of_window'); continue   // never stored, never surfaced
    }
    const ek = entityKeyOf(l), ev = eventKeyOf(l), occ = dayStartS(l.event_date)
    const prior = yield* t.get<{ actionable_at: number | null; reachable_at: number | null }>('SELECT actionable_at, reachable_at FROM monitor_events WHERE user_id = ? AND event_key = ?', [a.userId, ev])
    const known = !!(yield* t.get('SELECT 1 AS x FROM monitor_events WHERE user_id = ? AND entity_key = ? AND event_key <> ? AND actionable_at IS NOT NULL LIMIT 1', [a.userId, ek, ev]))
    const p: PriorEvent | null = prior ? { actionable_at: prior.actionable_at == null ? null : Number(prior.actionable_at), reachable_at: prior.reachable_at == null ? null : Number(prior.reachable_at) } : null
    const d = decide(l, p, known, a.policy, a.windowDays, a.now)
    const act = 'kind' in d && d.kind !== 'now_reachable', reach = 'kind' in d && l.reachable
    yield* t.run(`INSERT INTO monitor_events (user_id, event_key, entity_key, monitor_id, occurred_at, first_seen_at, last_checked_at, actionable_at, reachable_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, event_key) DO UPDATE SET last_checked_at = excluded.last_checked_at,
        actionable_at = COALESCE(monitor_events.actionable_at, excluded.actionable_at), reachable_at = COALESCE(monitor_events.reachable_at, excluded.reachable_at)`,
      [a.userId, ev, ek, a.monitorId, occ, a.now, a.now, act ? a.now : null, reach ? a.now : null])
    if ('suppress' in d) bump(d.suppress)
    else if (!d.alert) bump('policy')
    else {
      const latency = Math.max(0, a.now - occ)
      yield* t.run('INSERT INTO monitor_alerts (id, user_id, monitor_id, run_id, event_key, kind, company, latency_s, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [randomBytes(12).toString('hex'), a.userId, a.monitorId, a.runId, ev, d.kind, l.company.slice(0, 150), latency, a.now])
      out.alerts.push({ kind: d.kind, company: l.company, event_key: ev, latency_s: latency })
    }
    yield* t.run(`INSERT INTO monitor_cursors (monitor_id, source, last_event_at, last_checked_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (monitor_id, source) DO UPDATE SET last_checked_at = excluded.last_checked_at,
        last_event_at = CASE WHEN monitor_cursors.last_event_at IS NULL OR excluded.last_event_at > monitor_cursors.last_event_at THEN excluded.last_event_at ELSE monitor_cursors.last_event_at END`,
      [a.monitorId, sourceOf(l), occ, a.now])
  }
  return out
}

// Missed-run recovery: how many scheduled runs a late run stands in for, and how many days of events it can no longer
// see (the gap since the previous run beyond the play's window). A late monitor runs ONE scan, never one per missed
// slot, so recovery adds no paid calls; whatever happened inside the window is still found by that one run.
export function missedRuns(dueAt: number, now: number, intervalHours: number): number {
  return Math.max(0, Math.floor((now - dueAt) / (intervalHours * 3600)))
}
export function uncoveredDays(prevRanAt: number | null, ranAt: number, windowDays: number): number {
  return prevRanAt == null ? 0 : Math.max(0, Math.floor((ranAt - prevRanAt) / 86400) - windowDays)
}

export interface DetectionReport {
  alerts: number; by_kind: Record<AlertKind, number>
  latency: { median_s: number | null; max_s: number | null }   // event date -> alert, over this monitor's alerts
  last_run: { ran_at: number; missed_runs: number; uncovered_days: number } | null
  sources: { source: string; last_event_at: number | null; last_checked_at: number }[]
}
// Owner-scoped report for one monitor: alert counts by kind, detection latency, the last run's missed-run recovery and
// the per-source cursors. Another tenant's monitor id reads as empty (the route answers 404 before calling this).
export async function detectionReport(db: Db, userId: string, monitorId: string, windowDays: number): Promise<DetectionReport> {
  const alerts = await db.all<{ kind: AlertKind; latency_s: number }>('SELECT kind, latency_s FROM monitor_alerts WHERE user_id = ? AND monitor_id = ? ORDER BY latency_s', [userId, monitorId])
  const by_kind: Record<AlertKind, number> = { new_company: 0, new_signal: 0, now_reachable: 0 }
  for (const a of alerts) by_kind[a.kind]++
  const lat = alerts.map(a => Number(a.latency_s)).sort((x, y) => x - y)
  const runs = await db.all<{ ran_at: number; missed_runs: number | null }>(
    'SELECT r.ran_at, r.missed_runs FROM monitor_runs r JOIN monitors m ON m.id = r.monitor_id WHERE r.monitor_id = ? AND m.user_id = ? ORDER BY r.ran_at DESC LIMIT 2', [monitorId, userId])
  const last = runs[0] ? { ran_at: Number(runs[0].ran_at), missed_runs: Number(runs[0].missed_runs ?? 0), uncovered_days: uncoveredDays(runs[1] ? Number(runs[1].ran_at) : null, Number(runs[0].ran_at), windowDays) } : null
  const sources = (await db.all<{ source: string; last_event_at: number | null; last_checked_at: number }>(
    'SELECT c.source, c.last_event_at, c.last_checked_at FROM monitor_cursors c JOIN monitors m ON m.id = c.monitor_id WHERE c.monitor_id = ? AND m.user_id = ? ORDER BY c.source', [monitorId, userId]))
    .map(s => ({ source: s.source, last_event_at: s.last_event_at == null ? null : Number(s.last_event_at), last_checked_at: Number(s.last_checked_at) }))
  return { alerts: alerts.length, by_kind, latency: { median_s: lat.length ? lat[Math.floor((lat.length - 1) / 2)] : null, max_s: lat.length ? lat[lat.length - 1] : null }, last_run: last, sources }
}
