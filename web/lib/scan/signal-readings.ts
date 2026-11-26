// #2084: fills in the judge's reading for each saved signal the compiler cannot read, and keeps the readings of the signals still saved.
// Called where a profile is saved (the one place a saved signal changes), so the plays page in any language reads stored readings and
// makes no paid call of its own.
import type { Icp } from './icp.ts'
import { readSignals, type ReadSignal } from './signal-reading.ts'

export async function withReadings(icp: Icp, read: ReadSignal | null, now = Math.floor(Date.now() / 1000)): Promise<Icp> {
  const lang = (icp.language ?? 'en').trim().toLowerCase().slice(0, 2)
  const kept: NonNullable<Icp['signal_readings']> = {}
  // A reading belongs to the exact signal text that was read: a reworded signal is read again, never inherited.
  for (const s of icp.signals) { const r = icp.signal_readings?.[s.trim()]; if (r) kept[s.trim()] = r }
  const need = icp.signals.map(s => s.trim()).filter(s => s && !kept[s])
  // English is the compiler's own language; any other language has no word rules, so a signal without a reading makes no play.
  if (lang !== 'en' && need.length && read) for (const [s, r] of Object.entries(await readSignals(need, lang, read))) kept[s] = r.kind === 'hiring' ? { kind: 'hiring', ...(r.role ? { role: r.role } : {}), at: now } : { kind: 'not_hiring', at: now }
  const next = { ...icp }
  if (Object.keys(kept).length) next.signal_readings = kept
  else delete next.signal_readings
  return next
}
