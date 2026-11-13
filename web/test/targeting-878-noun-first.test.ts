// #878 staging data (Hermes-PC, issue comment 6841873411): all three ready leads carried an opening signal from an Instagram
// post ("Opened a new 5th location in Woodbridge on Hwy 27 in the GTA", "New dental clinic opened in Yorkville at 11
// Yorkville Ave in Toronto", "New dental clinic now open in Parkdale, Toronto"), yet every C1 "opening a new location"
// clause row said "no verified source shows this company's open (location) event", with the placeholder source URL.
// The opening readers only knew verb-first wording ("opened a new location") with no ordinal; noun-first openings
// ("New dental clinic now open", "Our 5th location is now open", "Grand opening of our new clinic") were never read,
// and the subject check took the opening's own noun phrase for another company. Pure: no database or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { compileTargeting, evaluatePlan, eventMatches, planConditions } from '../lib/scan/targeting.ts'
import { planProofs, type ProofLead } from '../lib/scan/targeting-proof.ts'
import { quoteShowsEvent } from '../lib/scan/sales-hiring-gate.ts'
import { targetingClauseRow } from '../lib/scan/actionable.ts'

const ctx = { query: '', icp: null, salesGatePassed: false, competitors: null, graded: true, now: Date.parse('2026-11-12T16:30:00Z') }
const lead = (company: string, quote: string, url: string, event_date: string | null = null): ProofLead => ({ company, company_domain: null, evidence_excerpt: quote, signal: quote, source_url: url, event_date })
// the three live leads, with the live signal wording as their quotes (the quotes themselves were not captured)
const LIVE: [string, string, string][] = [
  ['Metro City Dentistry', 'Opened a new 5th location in Woodbridge on Hwy 27 in the GTA', 'https://www.instagram.com/reel/DSKjaWLFMpX/'],
  ['Eleven Dental', 'New dental clinic opened in Yorkville at 11 Yorkville Ave in Toronto', 'https://www.instagram.com/p/DZZ5KnNu2SY/'],
  ['Kailash Dentistry', 'New dental clinic now open in Parkdale, Toronto', 'https://www.instagram.com/reel/DSV4forkuNc/'],
]

test('#878 the live opening wordings are read as this company\'s opening of a new location; the clause row cites the lead\'s own source', () => {
  for (const q of ['Dental clinics in Toronto opening a new location or expanding', 'Dental clinics in Toronto that opened a new location or are hiring front-desk staff']) {
    const plan = compileTargeting(q, null)
    const c1 = planConditions(plan.root)[0].cond
    assert.deepEqual([c1.event, c1.object], ['open', 'location'], q)
    for (const [company, quote, url] of LIVE) {
      const ev = evaluatePlan(plan, planProofs(plan, lead(company, quote, url), [], { ...ctx, query: q }))
      const p = ev.clauses.find(x => x.id === 'C1')!
      assert.notEqual(p.reason, "no verified source shows this company's open (location) event", `${company}: ${quote}`)
      assert.equal(p.source_url, url, 'the clause cites the lead source, not the placeholder')
      assert.equal(p.truth, 'pass', `${company}: no clock on this plan, so the shown opening meets C1 (${p.reason})`)
      // the stored row: met, and honest that the evidence has no date of its own
      assert.match(targetingClauseRow(p, new Date(ctx.now)).value, /^C1 .*: pass, no evidence date$/)
    }
  }
})

test('#878 with a clock on the condition, an undated opening is shown but not dated: "unknown", saying it carries no date (never "no verified source")', () => {
  const plan = compileTargeting('Dental clinics in Toronto that opened a new location in the last 90 days', null)
  for (const [company, quote, url] of LIVE) {
    const p = evaluatePlan(plan, planProofs(plan, lead(company, quote, url), [], ctx)).clauses[0]
    assert.equal(p.truth, 'unknown')
    assert.match(p.reason, /^the source shows this company's open \(location\) event but carries no date, so its 90-day clock cannot be checked$/)
    assert.equal(p.source_url, url)
    // dated inside the clock, it is met, with its own evidence date
    const d = evaluatePlan(plan, planProofs(plan, lead(company, quote, url, '2026-10-30'), [], ctx)).clauses[0]
    assert.deepEqual([d.truth, d.date], ['pass', '2026-10-30'])
    assert.match(targetingClauseRow(d, new Date(ctx.now)).value, /: pass, evidence dated 2026-10-30$/)
  }
})

test('#878 noun-first openings are read; not-yet, hours, other companies and denials are not', () => {
  const yes: [string, string][] = [
    ['Metro City Dentistry', 'Our 5th location is now open in Woodbridge on Hwy 27!'],
    ['Kailash Dentistry', 'Grand opening of our new dental clinic in Parkdale'],
    ['Kailash Dentistry', 'Kailash Dentistry: New dental clinic now open in Parkdale'],
    ['Eleven Dental', 'Our second clinic has officially opened in Yorkville'],
  ]
  const no: [string, string][] = [
    ['Kailash Dentistry', 'The clinic is open on Sundays'],
    ['Kailash Dentistry', 'Our new clinic will open next spring'],
    ['Kailash Dentistry', 'New dental clinic will be open soon in Parkdale'],
    ['Kailash Dentistry', 'Our new clinic is not open yet'],
    ['Metro City Dentistry', 'Smile Co opened a new clinic nearby'],
    ['Metro City Dentistry', "Smile Co's new clinic is now open in Woodbridge"],
  ]
  const shows = (company: string, q: string) => quoteShowsEvent(q, q, false, company) && eventMatches('open', 'location', q)
  for (const [c, q] of yes) assert.equal(shows(c, q), true, q)
  for (const [c, q] of no) assert.equal(shows(c, q), false, q)
  // a named kind still needs that kind: a new clinic is a new location, not a new office
  assert.equal(eventMatches('open', 'office', 'New dental clinic now open in Parkdale'), false)
  assert.equal(eventMatches('open', 'clinic', 'New dental clinic now open in Parkdale'), true)
})
