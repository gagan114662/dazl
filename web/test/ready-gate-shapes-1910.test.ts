// #1910 offline slice: the three search shapes Quest checks live, run through the gate the product uses
// (lib/scan/leads-view.ts). Home's ready count and the Leads page read these helpers, so a disagreement here is the
// chicago "2 ready, 0 cards" bug or the all-repeats "passed verification but 0 shown" bug returning.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readyRepeats, visibleReadyLeads } from '../lib/scan/leads-view.ts'

interface ShapeLead { company: string; review_reason?: string | null; seen_before?: number | boolean | null }
interface Shape { query: string; found: ShapeLead[] }

// Fixtures shaped like the prod finds in #1910, not like an ideal scan: a clean pass, a pass missing a date, a pass
// missing a person, one repeat, one whose proof nobody could confirm (review), and one that is a lower-fit lead.
const shapes: Shape[] = [
  { query: 'Dentists in Mississauga', found: [
    { company: 'clinic with a dated hiring ad and a named office manager' },
    { company: 'clinic whose signal page carries no date', },
    { company: 'clinic with a dated ad and no named person' },
    { company: 'clinic already shown in an earlier scan', seen_before: 1 },
    { company: 'clinic whose proof page would not load', review_reason: 'proof_unconfirmed' },
  ] },
  { query: 'Commercial cleaning in Toronto', found: [
    { company: 'cleaner with a dated new-contract notice and a named operations lead' },
    { company: 'cleaner already shown in an earlier scan', seen_before: 1 },
    { company: 'cleaner whose proof contradicts its own signal', review_reason: 'signal_mismatch' },
  ] },
  { query: 'Marketing agencies in Austin', found: [
    { company: 'agency with a dated hiring ad and a named founder' },
  ] },
]

const readyLeads = (s: Shape) => s.found.filter(l => !l.review_reason)

for (const shape of shapes) {
  test(`#1910 ${shape.query}: the ready count and the ready cards are the same number`, () => {
    const { ready } = readyRepeats(shape.found)
    assert.equal(ready, readyLeads(shape).length, 'ready is every lead without a review reason')
    assert.equal(visibleReadyLeads(shape.found, true).length, ready, 'the card list never disagrees with the count')
  })

  test(`#1910 ${shape.query}: a scan with ready leads shows a card with the toggle closed`, () => {
    if (readyLeads(shape).length === 0) return
    assert.ok(visibleReadyLeads(shape.found, false).length > 0, 'ready > 0 but the page showed 0 cards')
  })

  test(`#1910 ${shape.query}: a missing date or person is shown, never sent to review`, () => {
    for (const lead of shape.found) {
      if (lead.company.includes('no date') || lead.company.includes('no named person')) {
        assert.equal(lead.review_reason ?? null, null, `${lead.company} is shown with lower confidence`)
        assert.ok(visibleReadyLeads(shape.found, true).includes(lead), `${lead.company} is on the page`)
      }
    }
  })
}

test('#1910 a scan whose ready leads are all repeats does not collapse them to zero cards', () => {
  const allRepeats: ShapeLead[] = [
    { company: 'dentist seen in an earlier scan', seen_before: 1 },
    { company: 'second dentist seen in an earlier scan', seen_before: 1 },
  ]
  const { ready, repeats, collapsible } = readyRepeats(allRepeats)
  assert.equal(ready, 2)
  assert.equal(repeats, 2)
  assert.equal(collapsible, false, 'nothing new to surface, so the repeats stay on the page')
  assert.equal(visibleReadyLeads(allRepeats, false).length, 2)
})

test('#1910 a mix of new and repeat ready leads collapses only the repeats', () => {
  const mixed: ShapeLead[] = [
    { company: 'new dentist' },
    { company: 'dentist seen before', seen_before: 1 },
  ]
  const { collapsible } = readyRepeats(mixed)
  assert.equal(collapsible, true)
  assert.deepEqual(visibleReadyLeads(mixed, false).map(l => l.company), ['new dentist'])
  assert.equal(visibleReadyLeads(mixed, true).length, 2)
})
