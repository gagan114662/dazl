// #1910 offline slice, the words. A held lead is not shown as Ready, and the card must still tell the customer why in words
// they can act on. Three prod failures shaped this: "Zayed Law: no usable event date" printed beside a card that said
// the day was verified on the cited source (#1176 reader 2), a fixed reason list shown for every group (#1176, prod
// 66449147), and a "widen the window" fix offered where no window could help.
import test from 'node:test'
import assert from 'node:assert/strict'
import { CAUSE_TEXT, researchCause, researchHint, researchTip, type ResearchCause } from '../lib/lead-state.ts'

const CAUSES = Object.keys(CAUSE_TEXT) as ResearchCause[]
const INTERNAL = /gate|ICP|icp|null|undefined|review_reason|boolean|NaN|\[object/i

test('#1910 every hold reason reads as plain words about the lead, not about our code', () => {
  for (const cause of CAUSES) {
    const text = CAUSE_TEXT[cause]
    assert.ok(text.trim().length > 0, `${cause} has words`)
    assert.ok(!INTERNAL.test(text), `${cause} says nothing internal: "${text}"`)
    assert.equal(text, text.trim(), `${cause} is not padded`)
  }
})

test('#1910 Home never says there is no verified date when a lead day is verified', () => {
  const withNeed: ResearchCause[] = ['need']
  const hint = researchHint(withNeed)
  assert.match(hint, /event day is verified/i, 'it names the verified day')
  assert.doesNotMatch(hint, /none has verified/i, 'it does not deny the verified day')
  const mixed: ResearchCause[] = ['need', 'undated', 'place']
  assert.doesNotMatch(researchHint(mixed), /^none has verified/i, 'a mixed group is not all "unverified"')
  assert.match(researchHint(mixed), /for 1 of them the event day is verified/i)
})

test('#1910 an all-unfit group says reviewing cannot make them ready', () => {
  for (const hint of [researchHint(['unfit']), researchHint(['unfit', 'unfit'])])
    assert.match(hint, /not a fit for your profile, so reviewing them cannot make them ready/i)
})

test('#1910 Home names only the reasons the group really has, in the per-lead words', () => {
  // researchTip sentence-cases each line, so compare without case.
  const lower = researchTip(['undated', 'place']).toLowerCase()
  assert.ok(lower.includes(CAUSE_TEXT.undated.toLowerCase()), 'undated in its own words')
  assert.ok(lower.includes(CAUSE_TEXT.place.toLowerCase()), 'place in its own words')
  for (const absent of ['closed', 'unfit', 'contact'] as ResearchCause[])
    assert.ok(!lower.includes(CAUSE_TEXT[absent].toLowerCase()), `${absent} is not in the group, so it is not named`)
  assert.match(lower, /reading them is fine; checking them does not make them ready/i)
})

test('#1910 a window fix only ever belongs to a dated lead that was merely too old', () => {
  const older = researchCause({ id: 'l1', review_reason: 'outside_window', event_date: '2026-06-01' } as never)
  const undated = researchCause({ id: 'l2', review_reason: 'outside_window_undated', event_date: null } as never)
  const undatedAny = researchCause({ id: 'l3', window_held: true, event_date: null, day_verified: true } as never)
  assert.equal(older, 'older', 'a dated lead past the window carries the window cause')
  assert.equal(undated, 'undated', 'no date is undated, never the window cause')
  assert.equal(undatedAny, 'undated', 'a window hold with no date is still undated')
})

// The three shapes' mixed groups, as the research list shows them.
const shapes: { query: string; causes: ResearchCause[]; absent: ResearchCause[] }[] = [
  { query: 'Dentists in Mississauga', causes: ['undated', 'place', 'customer', 'need'], absent: ['closed', 'unfit', 'contact', 'older'] },
  { query: 'Commercial cleaning in Toronto', causes: ['unsupported', 'customer', 'closed'], absent: ['place', 'unfit', 'contact'] },
  { query: 'Marketing agencies in Austin', causes: ['older', 'undated', 'need'], absent: ['customer', 'closed', 'contact'] },
]

for (const shape of shapes) {
  test(`#1910 ${shape.query}: the research group's words match what it holds`, () => {
    const tip = researchTip(shape.causes).toLowerCase()
    for (const cause of shape.causes) assert.ok(tip.includes(CAUSE_TEXT[cause].toLowerCase()), `${cause} is named`)
    for (const absent of shape.absent) assert.ok(!tip.includes(CAUSE_TEXT[absent].toLowerCase()), `${absent} is not named`)
    const hint = researchHint(shape.causes)
    if (shape.causes.includes('need')) assert.doesNotMatch(hint, /none has verified, dated evidence/i, 'a verified day is not denied')
    else assert.match(hint, /none has verified, dated evidence/i, 'with no verified day it says so once')
  })
}
