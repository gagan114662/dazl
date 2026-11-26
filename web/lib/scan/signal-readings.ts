// #2084: fills in the judge's reading for each saved signal the compiler cannot read, and keeps the readings of the signals still saved.
// Ziggy's call on the PR: this is a SCAN-time step. The scan passes its own metered completion (its key, its spend cap and ledger), every
// uncompiled wording goes in one bounded call (lib/scan/signal-reading.ts readWordings), and the readings are kept per wording text, so
// the same wording is never paid for twice. A wording the call could not read is labelled (UNREAD_LABEL), never dropped in silence.
import type Database from 'better-sqlite3'
import type { Icp } from './icp.ts'
import { normalizeIcp } from './icp.ts'
import { readWordings, type ReadWordings } from './signal-reading.ts'
import type { Provider } from '../llm/provider.ts'

// One reading per wording, and one label per wording the call could not read. Both are keyed by the exact saved text: a reworded
// signal is read again, never inherited.
export async function withReadings(icp: Icp, read: ReadWordings | null, now = Math.floor(Date.now() / 1000)): Promise<Icp> {
  const lang = (icp.language ?? 'en').trim().toLowerCase().slice(0, 2)
  const kept: NonNullable<Icp['signal_readings']> = {}
  for (const s of icp.signals) { const r = icp.signal_readings?.[s.trim()]; if (r) kept[s.trim()] = r }
  const need = icp.signals.map(s => s.trim()).filter(s => s && !kept[s])
  // English is the compiler's own language; any other language has no word rules, so a signal without a reading makes no play. No
  // reader means no attempt was made: nothing is read and nothing is labelled.
  if (lang === 'en' || !need.length || !read) return dropUnread(icp, kept)
  const unread: NonNullable<Icp['signal_unread']> = {}
  let answered: Record<string, Awaited<ReturnType<typeof readWordings>>[string]> = {}
  try { answered = await readWordings(need, lang, read) } catch {
    // A refused or over-cap call read nothing: every wording it asked about is labelled, and the scan carries on without readings.
    for (const s of need) unread[s] = { at: now }
  }
  for (const [s, r] of Object.entries(answered)) {
    if (r) kept[s] = r.kind === 'hiring' ? { kind: 'hiring', ...(r.role ? { role: r.role } : {}), at: now } : { kind: 'not_hiring', at: now }
    else unread[s] = { at: now }
  }
  const out = dropUnread(icp, kept)
  if (Object.keys(unread).length) out.signal_unread = { ...(out.signal_unread ?? {}), ...unread }
  return out
}

// Readings and labels belong to wordings that are still saved: a removed or reworded signal takes its reading and label with it.
function dropUnread(icp: Icp, kept: NonNullable<Icp['signal_readings']>): Icp {
  const next = { ...icp }
  if (Object.keys(kept).length) next.signal_readings = kept
  else delete next.signal_readings
  if (next.signal_unread) {
    const live = Object.fromEntries(Object.entries(next.signal_unread).filter(([s]) => icp.signals.map(x => x.trim()).includes(s)))
    if (Object.keys(live).length) next.signal_unread = live
    else delete next.signal_unread
  }
  return next
}

// The scan's reading step: one bounded call on the scan's own provider (already wrapped in its spend guard and metered on its ledger),
// with the readings and labels merged into the saved profile so the plays card and the next scan both see them. A failure here never
// fails the scan: the wordings are labelled and the run goes on.
export async function fillReadings(db: Database.Database, tenantId: string, icp: Icp, key: string, provider: Provider, fetchImpl?: typeof fetch): Promise<Icp> {
  const complete = provider.complete
  const lang = (icp.language ?? 'en').trim().toLowerCase().slice(0, 2)
  if (!complete || lang === 'en' || !icp.signals.length) return icp
  const read: ReadWordings = prompt => complete(key, prompt, fetchImpl, 200)
  const filled = await withReadings(icp, read).catch(() => icp)
  if (filled === icp) return icp
  // Merge into the saved profile by wording: an edit made during the scan keeps its own text, and only readings for wordings that are
  // still saved are added. Nothing the person typed is touched.
  try {
    const raw = db.prepare('SELECT buyer_profile FROM users WHERE id = ?').pluck().get(tenantId) as string | null | undefined
    const saved = raw ? normalizeIcp(safeJson(raw)) : null
    if (!saved) return filled
    const texts = new Set(saved.signals.map(s => s.trim()))
    const readings = Object.fromEntries(Object.entries(filled.signal_readings ?? {}).filter(([s]) => texts.has(s)))
    const unread = Object.fromEntries(Object.entries(filled.signal_unread ?? {}).filter(([s]) => texts.has(s)))
    const merged = normalizeIcp({
      ...saved,
      ...(Object.keys(readings).length ? { signal_readings: { ...(saved.signal_readings ?? {}), ...readings } } : {}),
      ...(Object.keys(unread).length ? { signal_unread: { ...(saved.signal_unread ?? {}), ...unread } } : {}),
    })
    if (merged) db.prepare('UPDATE users SET buyer_profile = ? WHERE id = ?').run(JSON.stringify(merged), tenantId)
  } catch { /* the readings still shape this run; a save failure must not stop the scan */ }
  return filled
}

function safeJson(raw: string): unknown { try { return JSON.parse(raw) } catch { return null } }
