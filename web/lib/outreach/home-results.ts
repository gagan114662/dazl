// #1040: what the last 30 days produced, for Home - from stored rows only (no new tracking), one tenant, on the async Db
// layer (SQLite and Postgres). Counts, with one rule each so the by-signal table adds up to the tiles:
//  - new leads: leads found in the window (by the scan's own row, scan_jobs.user_id = tenant), not rejected;
//  - contacted: first-touch emails SENT in the window (outreach_messages.status 'sent', never test sends);
//  - replied: of those sent messages, the ones with a person-written reply (a reply matched to the message,
//    inbound_messages.outreach_message_id, classified positive / negative / other / opt_out / uncertain - never an
//    auto-reply or any bounce notice);
//  - interested: of those, the ones whose deciding reply is positive - the Inbox's rule (lib/outreach/inbox.ts): the
//    newest reply that is not an auto-reply or soft bounce, so "yes" then "no" (or a bounce notice) is not interested.
// New leads are the ones the Leads page shows: not rejected, not hidden as a poor fit (fit <= 1), not test fixtures.
// The latest replies are replies to those same messages (sent in the window), so the list never shows a reply the tiles
// do not count. A sent message whose lead row is gone still counts, under no signal type.
// Per signal type, each lead counts under its own stored type (leads.signal_kind), so a reply is counted once, under the
// lead its message went to: the table's replied column always sums to the Replied tile.
// "Ready" leads are not counted here: that verdict needs the per-request gate checks of the Leads page (the draft guard,
// the time window, timing), so Home says "new leads" and links to Leads, never a "ready" number it cannot back.
import type { Db } from '../db/client.ts'
import { NOT_A_PERSON, sqlList } from './needs-owner.ts'

export const RESULTS_WINDOW_DAYS = 30
// 'uncertain' counts: the classifier gives it to hedged answers a person wrote ("Not really interested", "maybe later")
// and to bodies it could not read; auto-replies and bounces have their own classes and never count
const PERSON_REPLY = ['positive', 'negative', 'other', 'opt_out', 'uncertain']
// The Inbox's deciding reply (lib/outreach/inbox.ts): the newest message that is not a machine's (NOT_A_PERSON)
const MACHINE = sqlList(NOT_A_PERSON)

export interface HomeResults {
  window_days: number
  since: number
  tiles: { leads: number; contacted: number; replied: number; interested: number }
  by_signal: { signal: string; leads: number; contacted: number; replied: number }[]
  latest_leads: { id: string; company: string; signal: string; job_id: string; created_at: number }[]
  latest_replies: { thread_id: string; company: string; classification: string; received_at: number }[]
}

export async function homeResults(db: Db, tenantId: string, now: number = Math.floor(Date.now() / 1000)): Promise<HomeResults> {
  const since = now - RESULTS_WINDOW_DAYS * 86400
  const marks = PERSON_REPLY.map(() => '?').join(', ')
  // leads found in the window, by type (the tenant's own scans only)
  const leadRows = await db.all<{ kind: string | null; n: number | string }>(
    `SELECT l.signal_kind AS kind, COUNT(*) AS n FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
     WHERE j.user_id = ? AND l.created_at >= ? AND l.quarantined_at IS NULL AND (l.fit IS NULL OR l.fit > 1) AND (l.source_kind IS NULL OR l.source_kind <> 'test') GROUP BY l.signal_kind`, [tenantId, since])
  // first-touch emails sent in the window, each with whether it got a person-written / positive reply, by the lead's type
  const sentRows = await db.all<{ kind: string | null; sent: number | string; replied: number | string; interested: number | string }>(
    `SELECT l.signal_kind AS kind, COUNT(*) AS sent,
       SUM(CASE WHEN EXISTS (SELECT 1 FROM inbound_messages r WHERE r.tenant_id = m.tenant_id AND r.outreach_message_id = m.id AND r.classification IN (${marks})) THEN 1 ELSE 0 END) AS replied,
       SUM(CASE WHEN (SELECT r.classification FROM inbound_messages r WHERE r.tenant_id = m.tenant_id AND r.outreach_message_id = m.id AND r.classification NOT IN ${MACHINE}
                      ORDER BY r.received_at DESC, r.gmail_id DESC LIMIT 1) = 'positive' THEN 1 ELSE 0 END) AS interested
     FROM outreach_messages m LEFT JOIN leads l ON l.id = m.lead_id
     WHERE m.tenant_id = ? AND m.status = 'sent' AND m.sent_at >= ? AND COALESCE(m.test, 0) = 0
     GROUP BY l.signal_kind`, [...PERSON_REPLY, tenantId, since])
  const kind = (k: string | null) => k || 'unknown'
  const by = new Map<string, { signal: string; leads: number; contacted: number; replied: number }>()
  const row = (k: string) => { let r = by.get(k); if (!r) { r = { signal: k, leads: 0, contacted: 0, replied: 0 }; by.set(k, r) } return r }
  for (const r of leadRows) row(kind(r.kind)).leads += Number(r.n)
  let interested = 0
  for (const r of sentRows) { const x = row(kind(r.kind)); x.contacted += Number(r.sent); x.replied += Number(r.replied); interested += Number(r.interested) }
  const by_signal = [...by.values()].sort((a, b) => b.replied - a.replied || b.contacted - a.contacted || b.leads - a.leads || a.signal.localeCompare(b.signal))
  const sum = (k: 'leads' | 'contacted' | 'replied') => by_signal.reduce((n, r) => n + r[k], 0)
  const latest_leads = (await db.all<{ id: string; company: string | null; signal: string | null; job_id: string; created_at: number | string }>(
    `SELECT l.id, l.company, l.signal, l.scan_job_id AS job_id, l.created_at FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
     WHERE j.user_id = ? AND l.created_at >= ? AND l.quarantined_at IS NULL AND (l.fit IS NULL OR l.fit > 1) AND (l.source_kind IS NULL OR l.source_kind <> 'test') ORDER BY l.created_at DESC, l.id DESC LIMIT 5`, [tenantId, since]))
    .map(r => ({ id: r.id, company: r.company || 'Unnamed company', signal: r.signal || '', job_id: r.job_id, created_at: Number(r.created_at) }))
  const latest_replies = (await db.all<{ thread_id: string; company: string | null; classification: string; received_at: number | string }>(
    `SELECT r.thread_id, l.company, r.classification, r.received_at FROM inbound_messages r
     JOIN outreach_messages m ON m.id = r.outreach_message_id AND m.tenant_id = r.tenant_id LEFT JOIN leads l ON l.id = m.lead_id
     WHERE r.tenant_id = ? AND r.classification IN (${marks}) AND m.status = 'sent' AND m.sent_at >= ? AND COALESCE(m.test, 0) = 0
     ORDER BY r.received_at DESC, r.gmail_id DESC LIMIT 5`, [tenantId, ...PERSON_REPLY, since]))
    .map(r => ({ thread_id: r.thread_id, company: r.company || 'Unknown company', classification: r.classification, received_at: Number(r.received_at) }))
  return { window_days: RESULTS_WINDOW_DAYS, since, tiles: { leads: sum('leads'), contacted: sum('contacted'), replied: sum('replied'), interested }, by_signal, latest_leads, latest_replies }
}

// The signal ids (lib/scan/score.ts SIGNALS, plus commenter imports' competitor_complaint) in plain words.
export function signalLabel(id: string): string {
  if (id === 'unknown') return 'No signal type'
  const s = id.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}
