// #2084: a saved signal the targeting compiler cannot read - because it is not English, or because it is a wording the compiler has no
// rule for - goes to the judge instead of to nothing. The judge answers one question in the signal's own language: is this a company
// hiring a role (which role), or a denial? One short answer per signal, and no answer is never read as "fine".
//
// Ziggy's call on #2084: the judge is asked ONCE per scan for every uncompiled wording together, on the scan's own key and through the
// scan's spend cap and ledger (never the operator key, never an unmetered side channel). This module owns the question, the numbered
// answer shape, and the bound; the caller supplies the metered completion.
import type { SignalReading } from './role-words.ts'
export type { SignalReading }
export type ReadWordings = (prompt: string) => Promise<string>

// What the person is told when a wording could not be read at all: the same sentence in every surface, so it is never mistaken for
// "no signal here".
export const UNREAD_LABEL = "this wording couldn't be turned into a search; try rewording it"

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

const HIRING_LINE = /^\s*hiring\s*:?\s*(.*)$/i
const NOT_HIRING_LINE = /^\s*not[_\s-]?hiring\b/i
const OTHER_LINE = /^\s*other\b/i
// The judge's one line as a reading; anything unrecognised is null (no reading), never a guess. OTHER is a real answer (neither hiring
// nor a denial): it is kept as a no-play reading so the same wording is not paid for again on the next scan (#2084 B5).
export function parseReading(text: string): SignalReading | null {
  const line = text.trim().split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? ''
  const hiring = HIRING_LINE.exec(line)
  if (hiring) return { kind: 'hiring', role: hiring[1].trim().slice(0, 80) || null }
  if (NOT_HIRING_LINE.test(line)) return { kind: 'not_hiring' }
  if (OTHER_LINE.test(line)) return { kind: 'other' }
  return null
}

// Every uncompiled wording of a profile in ONE call, at most MAX_WORDINGS of them. The answer is one line per wording, prefixed by
// its number, so a wording the judge skipped stays unanswered instead of borrowing its neighbour's line.
export const MAX_WORDINGS = 8
export const promptForAll = (wordings: string[], lang: string | null): string =>
  `${READING_SYSTEM}

LANGUAGE: ${lang ?? 'unknown'}
${wordings.map((w, i) => `${i + 1}. ${w.trim().slice(0, 200)}`).join('\n')}

Answer with one line per wording, in the same order, prefixed by its number and nothing else: "<number>. HIRING: <role>", "<number>. NOT_HIRING" or "<number>. OTHER".`
// One answer per wording, by number. A number with no answer, an answer out of range, or prose is no reading for that wording.
export function parseReadings(text: string, count: number): (SignalReading | null)[] {
  const out: (SignalReading | null)[] = Array.from({ length: count }, () => null)
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(\d{1,2})\s*[.)]\s*(.*)$/.exec(raw)
    if (!m) continue
    const i = Number(m[1]) - 1
    if (i >= 0 && i < count) out[i] = parseReading(m[2])
  }
  return out
}
// The one bounded call: every wording at once. A refused or failed call throws to the caller, which labels what it could not read.
export async function readWordings(wordings: string[], lang: string | null, read: ReadWordings): Promise<Record<string, SignalReading | null>> {
  const asked = [...new Set(wordings.map(w => w.trim()).filter(Boolean))].slice(0, MAX_WORDINGS)
  if (!asked.length) return {}
  const answers = parseReadings(await read(promptForAll(asked, lang)), asked.length)
  return Object.fromEntries(asked.map((w, i) => [w, answers[i] ?? null]))
}
