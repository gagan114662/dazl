// #2084: a saved signal the targeting compiler cannot read - because it is not English, or because it is a wording the compiler has no
// rule for - goes to the judge instead of to nothing. The judge answers one question in the signal's own language: is this a company
// hiring a role (which role), or a denial? One short answer per signal, and no answer is never read as "fine".
//
// The caller supplies the reader, so the same spend guard and key the rest of the product uses apply (lib/llm/owner-guard.ts); this
// module owns the question, the one-line answer shape, and the cap.
import type { SignalReading } from './role-words.ts'
export type { SignalReading }
export type ReadSignal = (signal: string, lang: string | null) => Promise<SignalReading | null>

// One line, no prose: the reading is parsed, not summarised. The question names no language and no wording, so a German, Spanish,
// French or Japanese signal is read on its own terms instead of being translated into an English list first.
export const READING_SYSTEM = `You read one buying signal a sales team saved about companies, written in any language.
Decide what it says about hiring, in the language it is written in, and answer with ONE line, nothing else:
HIRING: <the role being hired, in English, or empty>
NOT_HIRING
OTHER
HIRING when the signal says companies are hiring a role now, including a freeze that has lifted or hiring that resumed.
NOT_HIRING when it says hiring stopped, paused, froze, slowed, or that a role is not wanted.
OTHER when it says neither, or you cannot tell.`
export const promptFor = (signal: string, lang: string | null): string => `${READING_SYSTEM}\n\nLANGUAGE: ${lang ?? 'unknown'}\nSIGNAL: ${signal.trim().slice(0, 600)}`

const HIRING_LINE = /^\s*hiring\s*:?\s*(.*)$/i
const NOT_HIRING_LINE = /^\s*not[_\s-]?hiring\b/i
// The judge's one line as a reading; anything unrecognised is null (no reading), never a guess.
export function parseReading(text: string): SignalReading | null {
  const line = text.trim().split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? ''
  const hiring = HIRING_LINE.exec(line)
  if (hiring) return { kind: 'hiring', role: hiring[1].trim().slice(0, 80) || null }
  if (NOT_HIRING_LINE.test(line)) return { kind: 'not_hiring' }
  return null
}

// One call per signal, at most MAX_READINGS. A reading that fails is left out (the signal then makes no play), never replaced by an
// English guess.
export const MAX_READINGS = 5
export async function readSignals(signals: string[], lang: string | null, read: ReadSignal): Promise<Record<string, SignalReading>> {
  const out: Record<string, SignalReading> = {}
  for (const s of [...new Set(signals.map(x => x.trim()).filter(Boolean))].slice(0, MAX_READINGS)) {
    try { const r = await read(s, lang); if (r) out[s] = r } catch { /* no reading: the signal makes no play */ }
  }
  return out
}
