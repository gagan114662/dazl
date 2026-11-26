// #1910 offline slice, found/shown. Standing orders: a lead is shown when it has a real company and a signal whose proof
// page names that company; a missing date, person, website or email lowers its confidence and is said on the card - it
// never hides the lead; only a lead whose proof nobody could confirm goes to review. Every lead that came back must
// therefore still be on the page somewhere: ready, review, or research.
import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewListSplit, emptyLeadsMessage, visibleReadyLeads } from '../lib/scan/leads-view.ts'
import { reviewIsActionable } from '../lib/lead-state.ts'
import { reviewCanNameBuyer } from '../lib/people/buyer-reach.ts'

interface Lead { company: string; review_reason?: string | null; seen_before?: number | boolean | null }
interface Shape { query: string; found: Lead[] }

// Each row varies only what the standing orders say must never hide a lead: the missing field, and a proof nobody could confirm.
const shapes: Shape[] = [
  { query: 'Dentists in Mississauga', found: [
    { company: 'clinic, dated ad, named office manager, website and email' },
    { company: 'clinic, signal proof names it, no date on the page' },
    { company: 'clinic, signal proof names it, no person named' },
    { company: 'clinic, proof page would not load', review_reason: 'blocked_by_site' },
  ] },
  { query: 'Commercial cleaning in Toronto', found: [
    { company: 'cleaner, dated new-contract notice, named operations lead' },
    { company: 'cleaner, signal proof names it, no website found' },
    { company: 'cleaner, signal proof names it, no email found' },
    { company: 'cleaner, quote could not be lined up', review_reason: 'quote_unconfirmed' },
  ] },
  { query: 'Marketing agencies in Austin', found: [
    { company: 'agency, dated hiring ad, named founder' },
    { company: 'agency, signal proof names it, closing date passed', review_reason: 'event_date_stale' },
  ] },
  { query: 'Accountants in Calgary', found: [
    { company: 'firm, dated new-partner notice, named managing partner' },
    { company: 'firm, signal proof names it, another company is the customer', review_reason: 'counterparty_signal' },
  ] },
  { query: 'HVAC companies in Denver', found: [
    { company: 'contractor, dated hiring ad, named service manager' },
    { company: 'contractor, proof needs javascript', review_reason: 'needs_javascript' },
  ] },
]

const row = (l: Lead, i: number) => ({ ...l, id: `l${i}`, contact: null, enrichments: [], event_date: null, source_kind: null })

for (const shape of shapes) {
  test(`#1910 ${shape.query}: every lead that came back is still on the page`, () => {
    const rows = shape.found.map(row)
    const ready = rows.filter(l => !l.review_reason)
    const { review, research } = reviewListSplit(rows)
    assert.equal(ready.length + review.length + research.length, shape.found.length, 'nothing is silently dropped')
  })

  test(`#1910 ${shape.query}: a scan with shown leads never says it found nothing`, () => {
    const rows = shape.found.map(row)
    const ready = rows.filter(l => !l.review_reason)
    const { review } = reviewListSplit(rows)
    const shown = ready.length + review.length + reviewListSplit(rows).research.length
    assert.equal(emptyLeadsMessage('done', shown, 0, review.length, 0, 0), null)
    if (ready.length > 0) assert.ok(visibleReadyLeads(rows, false).length > 0, 'ready leads are on the page')
  })

  test(`#1910 ${shape.query}: the review list matches the confirm verdict, not a raw reason`, () => {
    const rows = shape.found.map(row)
    const { review, research } = reviewListSplit(rows)
    // The list applies the buyer rule too (lib/lead-state.ts heldState -> reviewCanNameBuyer), so the verdict is compared
    // with the same input the list itself uses: a lead with no reachable buyer is research however confirmable its reason.
    for (const l of [...review, ...research]) {
      const buyer_unreachable = !reviewCanNameBuyer({ id: l.id, contact: (l as { contact: string | null }).contact }, [])
      assert.equal(review.includes(l), reviewIsActionable({ review_reason: l.review_reason, buyer_unreachable }), `${l.company}: one verdict`)
    }
  })
}

test('#1910 a lead missing exactly one field stays shown, for each field', () => {
  const missing = [
    { company: 'no date', note: 'date' },
    { company: 'no person', note: 'person' },
    { company: 'no website', note: 'website' },
    { company: 'no email', note: 'email' },
  ]
  const rows = missing.map((m, i) => ({ ...row({ company: m.company }, i), missing: m.note }))
  const { review, research } = reviewListSplit(rows)
  assert.equal(rows.length, 4)
  assert.equal(review.length + research.length, 0, 'none of them is held')
  assert.equal(visibleReadyLeads(rows, true).length, 4, 'all four are shown with lower confidence')
})
