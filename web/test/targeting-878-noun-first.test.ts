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
import { needsEventBeyondHiring, showsEventBeyondHiring } from '../lib/search/page-class.ts'
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
    // review round 3 on #1130: real captions the allow-list must keep
    ['Kailash Dentistry', 'New Dental Clinic Now Open In Parkdale'],
    ['Kailash Dentistry', 'NEW DENTAL CLINIC NOW OPEN IN PARKDALE'],
    ['Metro City Dentistry', 'Our new Woodbridge location is now open!'],
    ['Kailash Dentistry', 'Our new Parkdale clinic is now open'],
    ['Kailash Dentistry', 'New Kailash Dentistry clinic now open in Parkdale'],
    ['Kailash Dentistry', 'Our new clinic is now open at 2150 Yonge St'],
    ['Kailash Dentistry', 'New clinic now open in Parkdale at 1500 Queen St W'],
    ['Kailash Dentistry', 'new dental clinic now open in parkdale'],
    ['Kailash Dentistry', 'Our new clinic is now open and accepting new patients'],
    ['Kailash Dentistry', 'New clinic now open - come say hi'],
    ['Kailash Dentistry', 'Our new clinic is officially open for business'],
    ['Kailash Dentistry', 'Grand opening of our new clinic at 1500 Queen St'],
  ]
  const no: [string, string][] = [
    ['Kailash Dentistry', 'The clinic is open on Sundays'],
    ['Kailash Dentistry', 'Our new clinic will open next spring'],
    ['Kailash Dentistry', 'New dental clinic will be open soon in Parkdale'],
    ['Kailash Dentistry', 'Our new clinic is not open yet'],
    ['Metro City Dentistry', 'Smile Co opened a new clinic nearby'],
    ['Metro City Dentistry', "Smile Co's new clinic is now open in Woodbridge"],
    // review on #1130: hours, availability, websites, someone else's or a future opening, bare "now open"
    ['Kailash Dentistry', 'Our new clinic is open on Sundays'],
    ['Kailash Dentistry', 'The new office is open late on Thursdays'],
    ['Kailash Dentistry', 'Our new clinic in Parkdale is open Monday to Friday'],
    ['Kailash Dentistry', 'The new site is open for registration'],
    ['Kailash Dentistry', 'Our new site is now open, book online'],
    ['Kailash Dentistry', 'New office opened by Smile Co'],
    ['Kailash Dentistry', 'Grand opening of the new Smile Co clinic'],
    ['Kailash Dentistry', 'new clinic in Parkdale run by Smile Co is now open'],
    ['Kailash Dentistry', 'Grand opening of our new clinic next month'],
    ['Kailash Dentistry', 'Our 3rd office is now open in May 2027'],
    ['Kailash Dentistry', 'Now open for bookings'],
    ['Kailash Dentistry', 'We are now open'],
    ['Kailash Dentistry', 'New location coming soon'],
    ['Kailash Dentistry', 'New dental clinic is not yet open'],
    // review round 2 on #1130: hours / availability not on any list, other companies in the name, future, questions, reopenings
    ['Kailash Dentistry', 'Our new clinic is now open 7 days a week'],
    ['Kailash Dentistry', 'Our new clinic is open 9am to 5pm'],
    ['Kailash Dentistry', 'Our new clinic is open 7am-7pm'],
    ['Kailash Dentistry', 'Our new clinic is open every day'],
    ['Kailash Dentistry', 'Our new clinic is open all summer'],
    ['Kailash Dentistry', 'Our new clinic is open year-round'],
    ['Kailash Dentistry', 'Our new clinic is open around the clock'],
    ['Kailash Dentistry', 'Our new clinic open hours: 9-5'],
    ['Kailash Dentistry', 'New clinic open house this Saturday'],
    ['Kailash Dentistry', 'New Smile Co clinic is now open in Parkdale'],
    ['Kailash Dentistry', 'New Smile Dental clinic now open'],
    ['Kailash Dentistry', 'New clinic in Toronto from Smile Co is now open'],
    ['Kailash Dentistry', 'Our new office is open tomorrow'],
    ['Kailash Dentistry', 'Our new office is open this Saturday'],
    ['Kailash Dentistry', 'Our new office is open this weekend'],
    ['Kailash Dentistry', 'Our new office is open December 5'],
    ['Kailash Dentistry', 'Grand opening of our new clinic is on Saturday'],
    ['Kailash Dentistry', 'Grand opening of our new clinic will be held next week'],
    ['Kailash Dentistry', 'Grand opening of our new clinic coming soon'],
    ['Kailash Dentistry', 'Grand opening of our new clinic on Dec 5'],
    ['Kailash Dentistry', 'Grand opening of our new clinic: join us December 5!'],
    ['Kailash Dentistry', 'Is our new clinic open?'],
    ['Kailash Dentistry', 'Our new clinic is open to new patients'],
    ['Kailash Dentistry', 'Our new clinic is open for walk-ins'],
    ['Kailash Dentistry', 'Our new clinic is open again after renovations'],
    // review round 3 on #1130
    ['Kailash Dentistry', 'Our new clinic is now open: 9am-5pm daily'],
    ['Kailash Dentistry', 'Our new clinic open: Mon-Fri 9-5'],
    ['Kailash Dentistry', 'Our new clinic is now open: weekends only'],
    ['Kailash Dentistry', 'Our new clinic is now open, said Smile Co CEO Jane Doe'],
    ['Kailash Dentistry', 'Our new clinic is now open in Parkdale starting Monday'],
    ['Kailash Dentistry', 'Our new clinic is open in Parkdale beginning June'],
    ['Kailash Dentistry', 'Our new clinic is open in Toronto in December'],
    ['Kailash Dentistry', 'Our new clinic is open in Parkdale Mon to Fri'],
    ['Kailash Dentistry', 'Grand opening of our new clinic tonight'],
    ['Kailash Dentistry', 'New clinic opened in 2015 in Parkdale'],
    // review round 4 on #1130
    ['Kailash Dentistry', 'Our new clinic is open in two weeks'],
    ['Kailash Dentistry', 'Our new clinic is open in a few weeks'],
    ['Kailash Dentistry', 'Our new clinic is open in a month'],
    ['Kailash Dentistry', 'Our new clinic is open in the fall'],
    ['Kailash Dentistry', 'Our new clinic is open in Q1'],
    ['Kailash Dentistry', 'Our new clinic is open on the 15th'],
    ['Kailash Dentistry', 'Our new clinic is open in the afternoon'],
    ['Kailash Dentistry', 'Our new clinic in Parkdale is open in the afternoons'],
    ['Kailash Dentistry', 'Our new clinic is open on holidays'],
    ['Kailash Dentistry', 'Our new clinic is open at 10 sharp'],
    ['Kailash Dentistry', 'Our new clinic is now open - 9 to 5'],
    ['Kailash Dentistry', 'Our new office is open in Parkdale during renovations'],
    ['Kailash Dentistry', 'New Starbucks location now open in Parkdale'],
    ['Kailash Dentistry', 'New Invisalign clinic now open'],
    ['Kailash Dentistry', 'New clinic is now open in Parkdale for Smile Co patients'],
    ['Kailash Dentistry', 'Our new clinic opened and serving patients since 2015'],
    ['Kailash Dentistry', 'Our new clinic opened in Parkdale years ago'],
  ]
  const shows = (company: string, q: string) => quoteShowsEvent(q, q, false, company) && eventMatches('open', 'location', q)
  for (const [c, q] of yes) assert.equal(shows(c, q), true, q)
  for (const [c, q] of no) assert.equal(shows(c, q), false, q)
  // a named kind still needs that kind: a new clinic is a new location, not a new office
  assert.equal(eventMatches('open', 'office', 'New dental clinic now open in Parkdale'), false)
  assert.equal(eventMatches('open', 'clinic', 'New dental clinic now open in Parkdale'), true)
})

test('#878 review on #1130: job ads are not openings for the sales-hiring gate, and pure hiring requests do not start needing an event', () => {
  for (const q of ['Join our new sales office team as an SDR', 'Hiring: Account Executive for our 2nd location', 'Now open: Senior Account Executive role', 'Our new practice manager starts Monday']) {
    assert.equal(quoteShowsEvent(q, q, false, 'Acme Dental'), false, q)
    assert.equal(showsEventBeyondHiring(q), false, q)
  }
  for (const q of ['dental practices hiring a new practice manager', 'hiring a second office manager', 'companies hiring a 2nd location manager', 'gyms now open 24/7 hiring trainers', 'SaaS hiring SDRs, now open to remote']) assert.equal(needsEventBeyondHiring([], q), false, q)
})

test('#878 review on #1130: hours and adjective requests compile to no opening condition; plurals keep their stem', () => {
  for (const q of ['dental clinics in toronto with new patients and offices open Saturdays', 'Clinics with a 2nd location open late', 'Dental clinics whose new clinic is open on weekends']) {
    const opens = planConditions(compileTargeting(q, null).root).map(x => x.cond).filter(c => c.kind === 'event' && c.event === 'open')
    assert.deepEqual(opens, [], q)
  }
  assert.equal(eventMatches('open', 'office', 'Smile Co opened new offices downtown'), true)
  const c = planConditions(compileTargeting('dental groups that opened new offices', null).root)[0].cond
  assert.deepEqual([c.event, c.object], ['open', 'office'])
})
