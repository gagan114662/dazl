// #2084: fills in the judge's reading for each saved signal the compiler cannot read, and keeps the readings of the signals still saved.
// Ziggy's call on the PR: this is a SCAN-time step on the scan's own metered completion (its key, its spend cap and ledger), every
// uncompiled wording in one bounded call (lib/scan/signal-reading.ts readWordings), readings kept per wording text AND language so the
// same wording is never paid for twice, and a wording the call could not read is labelled (UNREAD_LABEL), never dropped in silence.
//
// Ziggy's exact-head review of #2084: (B1) readings are SERVER state - the scan input never carries them and only readings this run
// produced for the SAVED profile are merged back; (B3) that merge is a compare-and-swap, so a concurrent profile edit is not overwritten;
// (B4) a cached reading is reused only in the language it was judged in; (B5) OTHER is a persisted no-play result and an unreadable
// wording backs off, so neither is paid for on every scan.
import type Database from 'better-sqlite3'
import type { Icp } from './icp.ts'
import { normalizeIcp } from './icp.ts'
import { readWordings, type ReadWordings } from './signal-reading.ts'
import type { Provider } from '../llm/provider.ts'

// B5: a refused or unanswered wording is retried only after this backoff, so a run does not re-pay for the same unreadable wording every
// scan. A wording the judge answered OTHER is a persisted reading (kept), never retried.
export const UNREAD_BACKOFF_S = 7 * 24 * 60 * 60

const normLang = (icp: Icp): string => (icp.language ?? 'en').trim().toLowerCase().slice(0, 2)
const sigsOf = (icp: Icp): string[] => [...new Set(icp.signals.map(s => s.trim()).filter(Boolean))]

// B1: the scan input must not carry readings - they are server state written only by this step.
export function stripReadings(icp: Icp): Icp {
  if (!icp.signal_readings && !icp.signal_unread) return icp
  const next = { ...icp }
  delete next.signal_readings
  delete next.signal_unread
  return next
}

// One reading per wording, one label per wording the call could not read, both keyed by the exact saved text (a reworded signal is read
// again). `icp.signal_readings`/`signal_unread` are the SERVER cache this run may reuse (B1); a reading judged in another language is not
// reused (B4).
export async function withReadings(icp: Icp, read: ReadWordings | null, now = Math.floor(Date.now() / 1000)): Promise<Icp> {
  const lang = normLang(icp)
  const sigs = sigsOf(icp)
  const kept: NonNullable<Icp['signal_readings']> = {}
  for (const s of sigs) {
    const r = icp.signal_readings?.[s]
    if (r && r.lang === lang) kept[s] = r // B4: only the same-language reading is reused
  }
  const withinBackoff = (s: string): boolean => {
    const u = icp.signal_unread?.[s]
    return !!(u && typeof u.retry_after === 'number' && now < u.retry_after)
  }
  // B5: never re-ask a wording already kept (incl. OTHER) or one still inside its unread backoff.
  const need = sigs.filter(s => !kept[s] && !withinBackoff(s))
  const freshUnread: NonNullable<Icp['signal_unread']> = {}
  // English is the compiler's own language; any other language has no word rules, so a signal without a reading makes no play. No reader
  // means no attempt was made: nothing is read and nothing is labelled.
  if (lang !== 'en' && need.length && read) {
    let answered: Record<string, Awaited<ReturnType<typeof readWordings>>[string]> = {}
    try { answered = await readWordings(need, lang, read) } catch {
      // A refused or over-cap call read nothing: every wording it asked about backs off, and the scan carries on without readings.
      for (const s of need) freshUnread[s] = { at: now, retry_after: now + UNREAD_BACKOFF_S }
    }
    for (const [s, r] of Object.entries(answered)) {
      if (r) kept[s] = r.kind === 'hiring' ? { kind: 'hiring', ...(r.role ? { role: r.role } : {}), at: now, lang } : { kind: r.kind, at: now, lang }
      else freshUnread[s] = { at: now, retry_after: now + UNREAD_BACKOFF_S }
    }
  }
  // Readings and labels belong to wordings still saved: a removed or reworded signal takes its reading and label with it.
  const out = { ...icp }
  const rOut: NonNullable<Icp['signal_readings']> = {}
  for (const s of sigs) if (kept[s]) rOut[s] = kept[s]
  if (Object.keys(rOut).length) out.signal_readings = rOut
  else delete out.signal_readings
  const uOut: NonNullable<Icp['signal_unread']> = {}
  for (const s of sigs) {
    if (kept[s]) continue
    if (freshUnread[s]) uOut[s] = freshUnread[s]
    else if (withinBackoff(s)) uOut[s] = icp.signal_unread![s]
  }
  if (Object.keys(uOut).length) out.signal_unread = uOut
  else delete out.signal_unread
  return out
}

// The scan's reading step. The cache and the merge are the SAVED profile (server state), never the scan input (B1). One bounded call on
// the scan's own provider, already wrapped in its spend guard and metered on its ledger. The merge is a compare-and-swap so a concurrent
// edit is not overwritten (B3), and only readings THIS run produced are written. A failure here never fails the scan.
export async function fillReadings(db: Database.Database, tenantId: string, icp: Icp, key: string, provider: Provider, fetchImpl?: typeof fetch): Promise<Icp> {
  const complete = provider.complete
  const lang = normLang(icp)
  if (!complete || lang === 'en' || !icp.signals.length) return stripReadings(icp)
  const now = Math.floor(Date.now() / 1000)
  const read: ReadWordings = prompt => complete(key, prompt, fetchImpl, 200)
  // Read the saved profile once for its cache (server truth). Judge only what is missing - one call, never re-judged on a CAS retry.
  let raw: string | null | undefined
  let saved: Icp | null
  try {
    raw = db.prepare('SELECT buyer_profile FROM users WHERE id = ?').pluck().get(tenantId) as string | null | undefined
    saved = raw ? normalizeIcp(safeJson(raw)) : null
  } catch { return stripReadings(icp) }
  // B1: the cache is the saved profile's, never the input's; the run's signals drive what is read. No saved profile yet: still read for
  // this run, but there is nothing to persist.
  const filled = await withReadings({ ...stripReadings(icp), signal_readings: saved?.signal_readings, signal_unread: saved?.signal_unread }, read, now)
  if (!saved) return filled
  // B3: merge only readings THIS run produced (at === now), for the saved profile's signals, with compare-and-swap on the raw text. A
  // lost race re-reads the current saved profile and retries the merge WITHOUT re-judging, and never overwrites a concurrent edit's fields.
  for (let attempt = 0; attempt < 3; attempt++) {
    const texts = new Set(saved.signals.map(s => s.trim()))
    const readings = Object.fromEntries(Object.entries(filled.signal_readings ?? {}).filter(([s, v]) => texts.has(s) && v.at === now))
    const unread = Object.fromEntries(Object.entries(filled.signal_unread ?? {}).filter(([s, v]) => texts.has(s) && v.at === now))
    const merged = normalizeIcp({
      ...saved,
      ...(Object.keys(readings).length ? { signal_readings: { ...(saved.signal_readings ?? {}), ...readings } } : {}),
      ...(Object.keys(unread).length ? { signal_unread: { ...(saved.signal_unread ?? {}), ...unread } } : {}),
    })
    if (!merged) return filled
    try {
      const info = db.prepare('UPDATE users SET buyer_profile = ? WHERE id = ? AND buyer_profile IS ?').run(JSON.stringify(merged), tenantId, raw ?? null)
      if (Number(info.changes) > 0) return filled
    } catch { return filled }
    // Lost the race: re-read the current saved profile and merge onto it.
    try {
      raw = db.prepare('SELECT buyer_profile FROM users WHERE id = ?').pluck().get(tenantId) as string | null | undefined
      saved = raw ? normalizeIcp(safeJson(raw)) : null
    } catch { return filled }
    if (!saved) return filled
  }
  return filled
}

function safeJson(raw: string): unknown { try { return JSON.parse(raw) } catch { return null } }
