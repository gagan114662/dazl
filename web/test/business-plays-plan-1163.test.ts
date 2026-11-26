// #1163, second half (Ziggy on #2068): businessPlays reads the compiled plan instead of keeping its own list of negating wordings.
// The plan says which conditions exist and which are negated, so a hiring play needs a signal whose conditions are hiring conditions
// and at least one of them is POSITIVE with a role. Nothing here is a wording list: the affirmative twin of every denial is in the
// same table, so a guard that simply stopped reading negation cannot pass.
import test from 'node:test'
import assert from 'node:assert/strict'
import { businessPlays } from '../lib/business-brain.ts'
import type { Icp } from '../lib/scan/icp.ts'

const icp = (signals: string[]): Icp => ({ summary: 'Recruiting software for dental practices', who: ['Practice owner'], industries: [], sizes: [], where: ['Ohio'], signals, exclude: [] })
const plays = (signal: string): string[] => businessPlays({ buyer: icp([signal]) }, []).map(p => p.query)

// Fires: the freeze is over and the plan holds two positive hiring conditions, the second with a role.
test('#1163 a lifted freeze followed by real hiring makes a hiring play', () => {
  assert.deepEqual(plays('hiring freeze lifted, now hiring SDRs'), ['Practice owner at companies in Ohio hiring SDRs'])
})

test('#1163 a plain hiring signal still makes its hiring play', () => {
  assert.deepEqual(plays('hiring SDRs'), ['Practice owner at companies in Ohio hiring SDRs'])
})

// Does not fire: the plan holds no positive hiring condition (a denial), or a hiring condition with no role.
const DENIALS = ['stopped hiring SDRs', 'hiring freeze', 'hiring SDRs on hold', 'not hiring SDRs', 'instead of hiring recruiters',
  'hiring SDRs postponed', 'hiring SDRs is unlikely', 'hiring SDRs? Nope', 'hiring nobody', 'hiring slowdown', 'hiring SDRs is off the table']
for (const s of DENIALS) {
  test(`#1163 "${s}" makes no play`, () => {
    assert.deepEqual(plays(s), [])
  })
}

// A signal that is not only about hiring stays a plain play, exactly as before: the plan's other condition is the signal.
test('#1163 a mixed signal keeps its plain play and makes no hiring play', () => {
  assert.deepEqual(plays('raised a Series A, hiring SDRs'), ['Practice owner in Ohio - raised a Series A, hiring SDRs'])
  assert.deepEqual(plays('Business rejecting venture capital funding'), [])
})

// Two more languages, both ways. The compiler reads English; a signal in another language compiles to no condition at all, so the
// honest outcome is no play in either direction - the affirmative is not invented and the denial is not misread. Pinned so that a
// future multilingual compiler has to change these on purpose.
const OTHER_LANGUAGES: [string, string][] = [
  ['German, affirmative', 'wir stellen SDRs ein'],
  ['German, denial', 'Einstellungsstopp aufgehoben, jetzt SDRs einstellen'],
  ['Spanish, affirmative', 'contratando SDRs'],
  ['Spanish, denial', 'dejamos de contratar SDRs'],
]
for (const [what, s] of OTHER_LANGUAGES) {
  test(`#1163 ${what}: "${s}" makes no play from text the compiler cannot read`, () => {
    assert.deepEqual(plays(s), [])
  })
}
