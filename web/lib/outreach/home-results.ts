// #1040: what the last 30 days produced, for Home - from stored rows only (no new tracking), one tenant, on the async Db
// layer (SQLite and Postgres). Counts, with one rule each so the by-signal table adds up to the tiles:
//  - new leads: leads found in the window (by the scan's own row, scan_jobs.user_id = tenant), not rejected;
//  - contacted: first-touch emails SENT in the window (outreach_messages.status 'sent', never test sends, never to a test-fixture
//    lead: the verification fixture records a 'sent' message without the test flag);
//  - replied: of those sent messages, the ones with a person-written reply (a reply matched to the message,
//    inbound_messages.outreach_message_id, classified positive / negative / other / opt_out / uncertain - never an
//    auto-reply or any bounce notice);
//  - interested: of those, the ones with a reply thread whose deciding reply is positive - the Inbox's rule
//    (lib/outreach/inbox.ts): per Gmail thread, the newest message that is not an auto-reply or soft bounce, so "yes"
//    then "no" (or a delivery notice in the same thread) is not interested, and a notice in a thread of its own does not
//    undo the yes. The tile's Inbox link (?class=positive) lists those threads over all time; it also lists threads Home
//    leaves out (sent before the window, test sends, sends to a test-fixture lead), never fewer.
// New leads are the ones the Leads list shows: not rejected, not hidden as a poor fit (fit <= 1; lib/play-mail.ts
// VISIBLE_LEAD), not test fixtures (lib/scan/store.ts and store-db.ts list reads leave out source_kind 'test').
// The latest replies are replies to those same messages (sent in the window), so the list never shows a reply the tiles
// do not count. A sent message whose lead row is gone still counts, under no signal type.
// Per signal type, each lead counts under its own stored type (leads.signal_kind) or, never graded, under its channel
// (leads.source_kind, "Search (signal type not graded)"); "No signal type" = a lead with neither, or a message whose lead is gone
// or another tenant's. So a reply is counted once, under the
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
// A message's lead labels it only when the lead's scan is the same tenant's (outreach_messages.lead_id has no tenant
// binding): another workspace's lead never lends its company or signal type; that message counts under no type.
const OWN_LEAD = 'EXISTS (SELECT 1 FROM scan_jobs lj WHERE lj.id = l.scan_job_id AND lj.user_id = m.tenant_id)'

export interface HomeResults {
  window_days: number
  since: number
  // false: Gmail reply reading is off, so a missing reply is unobserved: replied / interested are null (unknown), not 0
  reply_reading: boolean
  tiles: { leads: number; contacted: number; replied: number | null; interested: number | null }
  by_signal: { signal: string; leads: number; contacted: number; replied: number | null }[]
  latest_leads: { id: string; company: string; signal: string; job_id: string; created_at: number }[]
  latest_replies: { thread_id: string; company: string; classification: string; received_at: number }[]
}

export async function homeResults(db: Db, tenantId: string, now: number = Math.floor(Date.now() / 1000), replyReading = true): Promise<HomeResults> {
  const since = now - RESULTS_WINDOW_DAYS * 86400
  const marks = PERSON_REPLY.map(() => '?').join(', ')
  // leads found in the window, by type (the tenant's own scans only)
  const leadRows = await db.all<{ kind: string | null; src: string | null; n: number | string }>(
    `SELECT l.signal_kind AS kind, l.source_kind AS src, COUNT(*) AS n FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
     WHERE j.user_id = ? AND l.created_at >= ? AND l.quarantined_at IS NULL AND (l.fit IS NULL OR l.fit > 1) AND (l.source_kind IS NULL OR l.source_kind <> 'test') GROUP BY l.signal_kind, l.source_kind`, [tenantId, since])
  // first-touch emails sent in the window, each with whether it got a person-written / positive reply, by the lead's type
  const sentRows = await db.all<{ kind: string | null; src: string | null; sent: number | string; replied: number | string; interested: number | string }>(
    `SELECT l.signal_kind AS kind, l.source_kind AS src, COUNT(*) AS sent,
       SUM(CASE WHEN EXISTS (SELECT 1 FROM inbound_messages r WHERE r.tenant_id = m.tenant_id AND r.outreach_message_id = m.id AND r.classification IN (${marks})) THEN 1 ELSE 0 END) AS replied,
       SUM(CASE WHEN EXISTS (SELECT 1 FROM inbound_messages p WHERE p.tenant_id = m.tenant_id AND p.outreach_message_id = m.id AND p.classification IN (${marks})
                      AND (SELECT d.classification FROM inbound_messages d WHERE d.tenant_id = p.tenant_id AND d.thread_id = p.thread_id AND d.classification NOT IN ${MACHINE}
                           ORDER BY d.received_at DESC, d.gmail_id DESC LIMIT 1) = 'positive') THEN 1 ELSE 0 END) AS interested
     FROM outreach_messages m LEFT JOIN leads l ON l.id = m.lead_id AND ${OWN_LEAD}
     WHERE m.tenant_id = ? AND m.status = 'sent' AND m.sent_at >= ? AND COALESCE(m.test, 0) = 0 AND (l.source_kind IS NULL OR l.source_kind <> 'test')
     GROUP BY l.signal_kind, l.source_kind`, [...PERSON_REPLY, ...PERSON_REPLY, tenantId, since])
  // A lead's row: its graded signal type; a lead never graded (no stored type: most search leads made without a scoring
  // model, every hiring-feed / CSV / manual lead) is counted under the channel that produced it ("source:<kind>"), never under a
  // type it was not given. 'unknown': a lead with neither field (older rows), or a message whose lead is gone or another tenant's.
  const kind = (k: string | null, src: string | null) => k || (src ? `source:${src}` : 'unknown')
  const by = new Map<string, { signal: string; leads: number; contacted: number; replied: number }>()
  const row = (k: string) => { let r = by.get(k); if (!r) { r = { signal: k, leads: 0, contacted: 0, replied: 0 }; by.set(k, r) } return r }
  for (const r of leadRows) row(kind(r.kind, r.src)).leads += Number(r.n)
  let interested = 0
  for (const r of sentRows) { const x = row(kind(r.kind, r.src)); x.contacted += Number(r.sent); x.replied += Number(r.replied); interested += Number(r.interested) }
  const by_signal = [...by.values()].sort((a, b) => b.replied - a.replied || b.contacted - a.contacted || b.leads - a.leads || a.signal.localeCompare(b.signal))
  const sum = (k: 'leads' | 'contacted' | 'replied') => by_signal.reduce((n, r) => n + r[k], 0)
  const latest_leads = (await db.all<{ id: string; company: string | null; signal: string | null; job_id: string; created_at: number | string }>(
    `SELECT l.id, l.company, l.signal, l.scan_job_id AS job_id, l.created_at FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
     WHERE j.user_id = ? AND l.created_at >= ? AND l.quarantined_at IS NULL AND (l.fit IS NULL OR l.fit > 1) AND (l.source_kind IS NULL OR l.source_kind <> 'test') ORDER BY l.created_at DESC, l.id DESC LIMIT 5`, [tenantId, since]))
    .map(r => ({ id: r.id, company: r.company || 'Unnamed company', signal: r.signal || '', job_id: r.job_id, created_at: Number(r.created_at) }))
  const latest_replies = (await db.all<{ thread_id: string; company: string | null; classification: string; received_at: number | string }>(
    `SELECT r.thread_id, l.company, r.classification, r.received_at FROM inbound_messages r
     JOIN outreach_messages m ON m.id = r.outreach_message_id AND m.tenant_id = r.tenant_id LEFT JOIN leads l ON l.id = m.lead_id AND ${OWN_LEAD}
     WHERE r.tenant_id = ? AND r.classification IN (${marks}) AND m.status = 'sent' AND m.sent_at >= ? AND COALESCE(m.test, 0) = 0 AND (l.source_kind IS NULL OR l.source_kind <> 'test')
     ORDER BY r.received_at DESC, r.gmail_id DESC LIMIT 5`, [tenantId, ...PERSON_REPLY, since]))
    .map(r => ({ thread_id: r.thread_id, company: r.company || 'Unknown company', classification: r.classification, received_at: Number(r.received_at) }))
  const tiles = { leads: sum('leads'), contacted: sum('contacted'), replied: sum('replied') as number | null, interested: interested as number | null }
  // reading off: replies to what was sent are unobserved (nothing sent: zero is still certain); the replies already
  // stored stay listed as what was seen
  if (!replyReading && tiles.contacted > 0) {
    tiles.replied = null; tiles.interested = null
    return { window_days: RESULTS_WINDOW_DAYS, since, reply_reading: false, tiles, by_signal: by_signal.map(s => ({ ...s, replied: s.contacted > 0 ? null : 0 })), latest_leads, latest_replies }
  }
  return { window_days: RESULTS_WINDOW_DAYS, since, reply_reading: replyReading, tiles, by_signal, latest_leads, latest_replies }
}

// The signal ids (lib/scan/score.ts SIGNALS, plus commenter imports' competitor_complaint) in plain words.
// A source row holds only that channel's leads with no graded type (a graded lead counts under its type), so each label says so.
const SOURCE_LABEL: Record<string, string> = {
  query: 'Search', hiring_feed: 'Hiring feed', csv: 'CSV import', manual_source: 'Added by you',
  watch: 'Watched search', monitor: 'Monitor', commenter: 'Commenters on a post', first_party: 'Your site visitors',
}
export function signalLabel(id: string): string {
  if (id === 'unknown') return 'No signal type'
  if (id.startsWith('source:')) { const s = id.slice(7); return `${SOURCE_LABEL[s] ?? `${s.charAt(0).toUpperCase()}${s.slice(1).replace(/_/g, ' ')}`} (signal type not graded)` }
  const s = id.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}
