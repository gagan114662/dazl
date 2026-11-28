import { test } from 'node:test'
import assert from 'node:assert/strict'
import { businessPlays, type BrainProfile } from '../lib/business-brain.ts'
import { parseReading, promptForAll, READING_SYSTEM, type ReadWordings, type SignalReading } from '../lib/scan/signal-reading.ts'
import { withReadings } from '../lib/scan/signal-readings.ts'
import { normalizeIcp } from '../lib/scan/icp.ts'

const buyer = (lang: string | null, signals: string[]) => ({
  summary: 'Dental practices in Ohio', who: ['Practice owner'], industries: ['dentistry'], sizes: [], where: ['Ohio'], signals, exclude: [],
  ...(lang ? { language: lang } : {}),
})
const plays = (lang: string | null, signals: string[], readings: Record<string, SignalReading> = {}) =>
  businessPlays({ buyer: buyer(lang, signals) } as BrainProfile, [], readings).map(p => p.query)
// One call answers every wording of the profile (lib/scan/signal-reading.ts readWordings): the stub reads the numbered list back and
// answers it in the same order, so `asked` is the list of calls, each with the wordings it carried.
const stub = (answers: Record<string, SignalReading | null>) => {
  const asked: string[][] = []
  const read: ReadWordings = async prompt => {
    const words = [...prompt.matchAll(/^(\d+)\. (.*)$/gm)].map(m => m[2].trim())
    asked.push(words)
    return words.map((w, i) => {
      const a = answers[w]
      if (!a) return `${i + 1}. OTHER`
      return a.kind === 'hiring' ? `${i + 1}. HIRING: ${a.role ?? ''}` : `${i + 1}. NOT_HIRING`
    }).join('\n')
  }
  return { read, asked }
}

// --- the judge's one line -----------------------------------------------------------------------------------------------------

test('#2084 the judge answer is parsed from a fixed shape; anything else is no reading, never a guess', () => {
  assert.deepEqual(parseReading('HIRING: SDRs'), { kind: 'hiring', role: 'SDRs' })
  assert.deepEqual(parseReading('  hiring:  \n'), { kind: 'hiring', role: null })
  assert.deepEqual(parseReading('NOT_HIRING'), { kind: 'not_hiring' })
  assert.deepEqual(parseReading('not hiring'), { kind: 'not_hiring' })
  assert.deepEqual(parseReading('OTHER'), { kind: 'other' })
  assert.equal(parseReading(''), null)
  assert.equal(parseReading('Sure! Here is what I think'), null, 'prose is not a reading')
})

test('#2084 the question names no language: each wording is passed verbatim, in its own language', () => {
  assert.match(READING_SYSTEM, /any language/i)
  const p = promptForAll(['Wir stellen SDRs ein'], 'de')
  assert.match(p, /LANGUAGE: de/)
  assert.match(p, /1\. Wir stellen SDRs ein/, 'the wording is passed verbatim')
  assert.doesNotMatch(p, /\b(?:freeze|stopped|paused)\b.*\b(?:German|Spanish|French)\b/i)
})

// --- readings are filled once per scan, and reused ----------------------------------------------------------------------------

test('#2084 readings are stored with the profile and reused; an English profile asks the judge nothing', async () => {
  const de = normalizeIcp({ ...buyer('de', ['Wir stellen SDRs ein', 'Einstellungsstopp']), summary: 'Dental practices in Ohio' })!
  const { read, asked } = stub({ 'Wir stellen SDRs ein': { kind: 'hiring', role: 'SDRs' }, Einstellungsstopp: { kind: 'not_hiring' } })
  const saved = await withReadings(de, read, 1000)
  assert.deepEqual(saved.signal_readings, { 'Wir stellen SDRs ein': { kind: 'hiring', role: 'SDRs', at: 1000, lang: 'de' }, Einstellungsstopp: { kind: 'not_hiring', at: 1000, lang: 'de' } })
  assert.equal(asked.length, 1, 'both wordings went in one call')
  assert.deepEqual(asked[0], ['Wir stellen SDRs ein', 'Einstellungsstopp'])
  const again = await withReadings(saved, read, 2000)
  assert.equal(asked.length, 1, 'a stored reading is not asked again')
  assert.deepEqual(again.signal_readings, saved.signal_readings, 'and keeps its first reading time')
  const en = normalizeIcp({ ...buyer('en', ['hiring SDRs']), summary: 'Dental practices in Ohio' })!
  const enSaved = await withReadings(en, read, 3000)
  assert.equal(asked.length, 1, 'the compiler reads English: no call')
  assert.equal(enSaved.signal_readings, undefined)
  // a reworded signal is read again, never inherited
  const reworded = await withReadings({ ...saved, signals: ['Wir stellen SDRs ein', 'Wir bauen das Team aus'] }, read, 4000)
  assert.deepEqual(asked.at(-1), ['Wir bauen das Team aus'], 'only the new wording is asked')
  assert.ok(!('Einstellungsstopp' in (reworded.signal_readings ?? {})), 'a reading for a signal no longer saved is dropped')
})

test('#2084 no key (no reader) leaves the signal without a reading, and no reading is never read as fine', async () => {
  const de = normalizeIcp({ ...buyer('de', ['Wir stellen SDRs ein']), summary: 'Dental practices in Ohio' })!
  const saved = await withReadings(de, null, 1000)
  assert.equal(saved.signal_readings, undefined)
  assert.deepEqual(plays('de', ['Wir stellen SDRs ein']), [], 'no reading, no play')
})

// --- the plays in four languages ----------------------------------------------------------------------------------------------

test('#2084 DE: a judged hiring signal makes its play, a judged denial makes none, and nothing is read on English rules', () => {
  const hiring = 'Wir stellen SDRs ein'
  const denial = 'Wir haben einen Einstellungsstopp'
  assert.deepEqual(plays('de', [hiring], { [hiring]: { kind: 'hiring', role: 'SDRs' } }), ['Practice owner at companies in Ohio hiring SDRs'])
  assert.deepEqual(plays('de', [denial], { [denial]: { kind: 'not_hiring' } }), [])
  assert.deepEqual(plays('de', [hiring]), [], 'without a reading the signal makes no play')
  // the table guards the role the judge names: a German not-a-role word never becomes a role
  assert.deepEqual(plays('de', [hiring], { [hiring]: { kind: 'hiring', role: 'niemand' } }), [], 'the German row rejects "niemand"')
})

test('#2084 ES: judged hiring fires, judged denial does not, and the Spanish row guards the role', () => {
  const hiring = 'Estamos contratando SDRs'
  const denial = 'No estamos contratando SDRs'
  assert.deepEqual(plays('es', [hiring], { [hiring]: { kind: 'hiring', role: 'SDRs' } }), ['Practice owner at companies in Ohio hiring SDRs'])
  assert.deepEqual(plays('es', [denial], { [denial]: { kind: 'not_hiring' } }), [])
  assert.deepEqual(plays('es', [denial]), [], 'a denial without a reading is not passed either')
  assert.deepEqual(plays('es', [hiring], { [hiring]: { kind: 'hiring', role: 'nadie' } }), [], 'the Spanish row rejects "nadie"')
})

test('#2084 FR: judged hiring fires, judged denial does not, and the French row guards the role', () => {
  const hiring = 'Nous recrutons des SDR'
  const denial = 'Nous ne recrutons personne'
  assert.deepEqual(plays('fr', [hiring], { [hiring]: { kind: 'hiring', role: 'SDRs' } }), ['Practice owner at companies in Ohio hiring SDRs'])
  assert.deepEqual(plays('fr', [denial], { [denial]: { kind: 'not_hiring' } }), [])
  assert.deepEqual(plays('fr', [hiring], { [hiring]: { kind: 'hiring', role: 'personne' } }), [], 'the French row rejects "personne"')
})

test('#2084 JA: the judge reads the signal (the table has no word rules for a script without spaces)', () => {
  const hiring = 'SDRを採用中'
  const denial = '採用停止中'
  assert.deepEqual(plays('ja', [hiring], { [hiring]: { kind: 'hiring', role: 'SDRs' } }), ['Practice owner at companies in Ohio hiring SDRs'])
  assert.deepEqual(plays('ja', [denial], { [denial]: { kind: 'not_hiring' } }), [])
  assert.deepEqual(plays('ja', [hiring]), [], 'without a reading: no play, never an English guess')
})

// --- what is stored is what is read -------------------------------------------------------------------------------------------

test('#2084 normalizeIcp keeps a well-formed reading, drops a malformed one, and bounds how many are stored', () => {
  const base = { summary: 'Dental practices in Ohio', signals: ['a'], language: 'de' }
  assert.deepEqual(normalizeIcp({ ...base, signal_readings: { a: { kind: 'hiring', role: 'SDRs', at: 5 } } })?.signal_readings, { a: { kind: 'hiring', role: 'SDRs', at: 5 } })
  assert.equal(normalizeIcp({ ...base, signal_readings: { a: { kind: 'maybe', at: 5 } } })?.signal_readings, undefined, 'an unknown kind is dropped')
  assert.equal(normalizeIcp({ ...base, signal_readings: { a: { kind: 'hiring', role: 'SDRs' } } })?.signal_readings, undefined, 'no time, no reading')
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`s${i}`, { kind: 'not_hiring', at: i }]))
  assert.equal(Object.keys(normalizeIcp({ ...base, signal_readings: many })?.signal_readings ?? {}).length, 8, 'bounded')
})
