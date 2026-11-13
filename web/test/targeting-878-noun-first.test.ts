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
    ['Kailash Dentistry', 'New Kailash Dentistry clinic now open in Parkdale'],
    ['Kailash Dentistry', 'Our new clinic is now open at 2150 Yonge St'],
    ['Kailash Dentistry', 'New clinic now open in Parkdale at 1500 Queen St W'],
    ['Kailash Dentistry', 'new dental clinic now open in parkdale'],
    ['Kailash Dentistry', 'Our new clinic is now open and accepting new patients'],
    ['Kailash Dentistry', 'New clinic now open - come say hi'],
    ['Kailash Dentistry', 'Our new clinic is officially open for business'],
    ['Kailash Dentistry', 'Grand opening of our new clinic at 1500 Queen St'],
    ['Kailash Dentistry', 'NEW KAILASH DENTISTRY CLINIC NOW OPEN IN PARKDALE'],
    ['Kailash Dentistry', 'new family dental clinic now open in parkdale'],
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
    // review round 5 on #1130 (fixed after the last round)
    ['Kailash Dentistry', 'New Starbucks Location Now Open In Parkdale'],
    ['Kailash Dentistry', 'NEW STARBUCKS LOCATION NOW OPEN IN PARKDALE'],
    ['Kailash Dentistry', 'new starbucks location now open in parkdale'],
    ['Kailash Dentistry', 'new clinic now open in parkdale from smile co'],
    ['Kailash Dentistry', 'Our new clinic is open in Christmas'],
    ['Kailash Dentistry', 'Our new clinic is open in Phase 2'],
    ['Kailash Dentistry', 'Our new clinic is now open in Parkdale for new Smile Co patients'],
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

test('#878 review (Hermes-PC) at 942c1a71: a pronoun names whoever the quote named before it, and a closed opening is no opening', () => {
  const q = 'Dental clinics in Toronto opening a new location or expanding'
  const plan = compileTargeting(q, null)
  const c1 = (quote: string, company = 'Metro City Dentistry') => evaluatePlan(plan, planProofs(plan, lead(company, quote, 'https://www.instagram.com/p/x/'), [], { ...ctx, query: q })).clauses.find(x => x.id === 'C1')!.truth
  // finding 2: another company's opening, through a pronoun, never proves the lead's C1
  for (const other of [
    'Bright Smiles is growing. Their new clinic is now open in Parkdale',
    'Congrats to our friends at Bright Smiles! Their new clinic is now open in Parkdale',
    'Bright Smiles is growing. Their new clinic opened in Parkdale',
    'Bright Smiles is growing. They opened a new clinic in Parkdale',
  ]) assert.notEqual(c1(other), 'pass', other)
  // the lead named before the pronoun: the lead's own opening. A pronoun with no one named fails closed (reversed at
  // 77e509ac: "Big news! Their new clinic ..." is not attributable to the lead)
  // the lead the only name in the quote: the pronoun refers to the lead (decision after the review at 89e021f3)
  assert.equal(c1('Metro City Dentistry is growing. Their new clinic is now open in Parkdale'), 'pass')
  assert.equal(c1('Metro City Dentistry is growing! New clinic now open in Parkdale'), 'pass')
  assert.notEqual(c1('Big news! Their new clinic is now open in Parkdale'), 'pass')
  // finding 3: reported closed, shut or moved, in brackets, after a dash, in any form
  for (const closed of [
    'New clinic now open in Parkdale (closed permanently)',
    'Our new clinic is now open in Parkdale - temporarily closed',
    'Our new clinic is now open - closed until further notice',
    'Grand opening of our new clinic in Parkdale (now permanently closed)',
    'Metro City Dentistry opened a new clinic in Parkdale, since closed',
    'Our new clinic opened in Parkdale but has moved',
    'Our new clinic in Parkdale is no longer open',
  ]) assert.notEqual(c1(closed), 'pass', closed)
  assert.equal(c1('New clinic now open in Parkdale'), 'pass', 'the plain opening still passes')
})

// review (Hermes-PC) at 57008172
// The sales-hiring gate reads a verb-first opening ("opened a new clinic") exactly as main did (true, design at 77e509ac);
// for those quotes only C1 is fixed. A noun-first opening's gate is new, and fails closed.
const verbFirst = (q: string) => /\bopen(?:ed|ing|s)?\s+a\s+new\b/i.test(q)
const truthOf = (q: string, company: string, quote: string) => { const plan = compileTargeting(q, null); return evaluatePlan(plan, planProofs(plan, lead(company, quote, 'https://x.example/p'), [], { ...ctx, query: q })).clauses.find(x => x.id === 'C1')!.truth }
const DENTAL = 'Dental clinics in Toronto opening a new location or expanding'

test('#878 review at 57008172 finding 1: closing a round, a Series A or a gap is no closure; launches and expansions keep their main result', () => {
  // [plan, quote, gate on main, C1 on main]
  const rows: [string, string, boolean, string][] = [
    ['SaaS companies launching a new product', 'Acme launched a new product after closing a $5M round', true, 'pass'],
    ['SaaS companies expanding to new markets', 'Acme closed its Series A and is expanding to Austin', true, 'unknown'],
    ['SaaS companies expanding to new markets', 'Acme expanded to Austin after closing a seed round', true, 'unknown'],
    ['SaaS companies expanding to new markets', 'Acme moved to a bigger office and is expanding to Austin', true, 'unknown'],
    ['SaaS companies launching a new product', 'Acme launched a new app, closing the gap with rivals', true, 'unknown'],
  ]
  for (const [q, quote, gate, c1] of rows) {
    assert.equal(quoteShowsEvent(quote, quote, false, 'Acme'), gate, quote)
    assert.equal(truthOf(q, 'Acme', quote), c1, quote)
  }
})

test('#878 review at 57008172 finding 2: a closure anywhere in the quote, not only in the opening\'s clause, undoes the opening', () => {
  for (const quote of [
    'Our new clinic is now open in Parkdale. Permanently closed',
    'Our new clinic is now open in Parkdale\nPermanently closed',
    'We opened a new clinic in Parkdale. It has since closed',
  ]) {
    assert.notEqual(truthOf(DENTAL, 'Metro City Dentistry', quote), 'pass', quote)
    assert.equal(quoteShowsEvent(quote, quote, false, 'Metro City Dentistry'), verbFirst(quote), quote)
  }
})

test('#878 review at 57008172 finding 3: an opening with no subject of its own belongs to the nearest name before it; @handles are names', () => {
  for (const quote of [
    'Bright Smiles is growing. The new clinic is now open in Parkdale',
    'Bright Smiles is growing! New clinic now open in Parkdale',
    'Bright Smiles is growing. Opened a new clinic in Parkdale',
    'Congrats @brightsmiles! Their new clinic is now open in Parkdale',
  ]) {
    assert.notEqual(truthOf(DENTAL, 'Metro City Dentistry', quote), 'pass', quote)
    assert.equal(quoteShowsEvent(quote, quote, false, 'Metro City Dentistry'), verbFirst(quote), quote)
  }
  for (const quote of [
    'New dental clinic now open in Parkdale',
    'Metro City Dentistry is growing! New clinic now open in Parkdale',
    'Congrats to us @metrocitydentistry! Our new clinic is now open',
    'Congrats @metrocitydentistry! New clinic now open in Parkdale',
  ]) {
    assert.equal(truthOf(DENTAL, 'Metro City Dentistry', quote), 'pass', quote)
    assert.equal(quoteShowsEvent(quote, quote, false, 'Metro City Dentistry'), true, quote)
  }
})

test('#878 review at 57008172 finding 4: an earlier name is the lead only when it carries every distinctive word of the lead\'s name (or the reverse)', () => {
  const no = 'Bright Family Dentistry is growing. Their new clinic is now open in Parkdale'
  assert.notEqual(truthOf(DENTAL, 'Family Dental Care', no), 'pass', no)
  assert.equal(quoteShowsEvent(no, no, false, 'Family Dental Care'), false, no)
  // finding 4's positive, with the pronoun: the lead is the only name in the quote, so "Their" is the lead's
  assert.equal(truthOf(DENTAL, 'Family Dental Care', 'Family Dental Care is growing. Their new clinic is now open'), 'pass')
  const yes = 'Family Dental Care is growing! New clinic now open'
  assert.equal(truthOf(DENTAL, 'Family Dental Care', yes), 'pass', yes)
  assert.equal(quoteShowsEvent(yes, yes, false, 'Family Dental Care'), true, yes)
})

// review (independent) at 519f060c: every new rule is for openings only; every other event reads exactly as on main
const plans = { launch: 'SaaS companies launching a new product', expand: 'SaaS companies expanding to new markets', office: 'SaaS companies opening a new office' }
const both = (q: string, company: string, quote: string) => [quoteShowsEvent(quote, quote, false, company), truthOf(q, company, quote)]

test('#878 review at 519f060c R2 + corpus: launch, expansion and partner quotes give exactly main\'s gate and C1 (values recorded from origin/main)', () => {
  const rows: [string, string, string, boolean, string][] = [
    ["SaaS companies launching a new product", "Acme", "Acme launched a new product today", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Today we launched a new product for finance teams", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Launched a new product for finance teams", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Introducing Acme Flow. We launched a new product today", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Meet Flow, our new AI assistant. We launched a new product built for Salesforce users", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Acme Corp launched a new product, its first since the Stripe integration", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Acme partners with HubSpot. They launched a new product for marketers", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Following feedback from Shopify merchants, Acme launched a new product", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "After talking to Salesforce admins we launched a new product", false, "unknown"],
    ["SaaS companies launching a new product", "Acme", "Acme launched a new product after the shutdown of its legacy tool", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Acme shut down its legacy product and launched a new product", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Acme moved to a new pricing model and launched a new product", true, "pass"],
    ["SaaS companies expanding to new markets", "Acme", "Acme is expanding to Austin", true, "unknown"],
    ["SaaS companies expanding to new markets", "Acme", "Acme relocated its HQ and is expanding to Austin", true, "unknown"],
    ["SaaS companies expanding to new markets", "Acme", "We are expanding to Austin. Thanks to our partners at Google", true, "unknown"],
    ["SaaS companies expanding to new markets", "Acme", "Thanks to AWS, we are expanding to Austin", true, "unknown"],
    ["SaaS companies expanding to new markets", "Acme", "Big news from the Acme team! Expanding to Austin this month", true, "unknown"],
    ["SaaS companies expanding to new markets", "Acme", "Partnering with Microsoft. Expanding to Austin", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry is expanding to Parkdale", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry is expanding to Parkdale after closing its old office", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry relocated and is expanding to Parkdale", true, "unknown"],
    ["SaaS companies launching a new product", "Acme", "CEO Jane Doe said her team launched a new product", false, "unknown"],
    ["SaaS companies launching a new product", "Acme", "Acme integrates with Slack. Its new product launched today", false, "unknown"],
    ["SaaS companies launching a new product", "Acme", "Acme integrates with Slack. They launched a new product today", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Acme announced a partnership with Slack and its team launched a new product", true, "pass"],
    ["SaaS companies expanding to new markets", "Acme", "Acme signs Walmart as a customer. They are expanding to Austin", true, "unknown"],
    ["SaaS companies launching a new product", "Acme", "Bright Labs is growing. The new product launched today", false, "unknown"],
    ["SaaS companies launching a new product", "Acme", "Bright Labs is growing. Launched a new product today", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Congrats @brightlabs! Their new product launched today", false, "unknown"],
    // R10 (review at 89e021f3): a launch / expansion object keeps main's stem ("tomatoes" -> tomato, "services" -> servic)
    ["SaaS companies launching new tomatoes", "Acme", "Acme launched a new tomato", true, "pass"],
    ["SaaS companies launching a new tomato", "Acme", "Acme launched new tomatoes", true, "pass"],
    ["SaaS companies launching new services", "Acme", "Acme launched a new service for banks", true, "unknown"],
    ["SaaS companies launching new heroes", "Acme", "Acme launched a new hero", true, "pass"],
  ]
  for (const [q, company, quote, gate, c1] of rows) assert.deepEqual(both(q, company, quote), [gate, c1], quote)
  // R7: "opens a new chapter" is no opening, so it is read as on main too
  assert.deepEqual(both(plans.launch, 'Acme', 'Bright Labs is growing. Acme opens a new chapter'), [true, 'unknown'])
})

test('#878 review at 519f060c R1: an opening whose subject is only determiners / adverbs, or a pronoun for an unnamed or lower-case practice, is not the lead\'s', () => {
  for (const quote of [
    'Bright Smiles is growing. A new clinic is now open in Parkdale',
    'Bright Smiles is growing. This new clinic is now open in Parkdale',
    'Bright Smiles is growing. That new clinic is now open in Parkdale',
    'Bright Smiles is growing. Just opened a new clinic in Parkdale',
    'congrats to bright smiles! their new clinic is now open in parkdale',
    'Congrats to brightsmiles! Their new clinic is now open in Parkdale',
    'Congrats to the team at bright smiles. New clinic now open in Parkdale',
    'Congrats to our friends down the street! Their new clinic is now open in Parkdale',
    'Huge congrats to our neighbours. Their new clinic is now open in Parkdale',
    'Bright Smiles is growing. The team opened a new clinic in Parkdale',
    'Welcome to the neighbourhood, Bright Smiles! New clinic now open in Parkdale',
  ]) assert.deepEqual(both(DENTAL, 'Metro City Dentistry', quote), [verbFirst(quote), 'unknown'], quote)
})

test('#878 review at 519f060c R3: only a standalone banner (anywhere) or a closure with nothing after it (in the opening\'s clause) undoes an opening', () => {
  // main's pass kept: closing a round, shutting a product, relocating an HQ, another office closing, closed applications
  for (const quote of [
    'Acme relocated its HQ and opened a new office in Austin',
    'Acme shut down its legacy product and opened a new office in Austin',
    'Acme has moved to a new HQ and opened a new office in Austin',
    'Acme has closed a $5M round and opened a new office in Austin',
    'Acme opened a new office in Austin. Our old Boston office has closed',
    'Acme opened a new office in Austin. Applications for the beta are now closed',
    'Acme opened a new office in Austin to be closer to customers who moved to Texas',
  ]) assert.deepEqual(both(plans.office, 'Acme', quote), [true, 'pass'], quote)
  for (const quote of [
    'Our new clinic is now open in Parkdale. Permanently closed',
    'Our new clinic is now open in Parkdale\nTemporarily closed',
    'We opened a new clinic in Parkdale. It has since closed',
    'New clinic now open in Parkdale (closed permanently)',
    'New clinic now open in Parkdale [closed]',
    'Our new clinic is now open in Parkdale - temporarily closed',
    'Metro City Dentistry opened a new clinic in Parkdale, since closed',
  ]) assert.deepEqual(both(DENTAL, 'Metro City Dentistry', quote), [verbFirst(quote), 'unknown'], quote)
})

test('#878 review at 519f060c R4: greetings, thanks, partners, people and places are not names', () => {
  for (const [company, quote] of [
    ['Acme', 'Hello Austin! Opened a new office downtown'],
    ['Acme', 'Thanks to Stripe! Opened a new office in Austin'],
    ['Acme', 'Partnering with Google Cloud. Opened a new office in Austin'],
    ['Acme', 'Growing fast! Opened a new office in Austin'],
    ['Acme', 'Sarah Chen joins as VP. They opened a new office in Austin'],
  ]) assert.deepEqual(both(plans.office, company, quote), [true, 'pass'], quote)
  assert.deepEqual(both('Restaurants opening a new location', "Joe's Pizza", 'Queen West, we are here! Opened a new location this week'), [true, 'pass'])
  // a new-form opening after a capitalised name that is not the lead fails closed, as on main (design at 77e509ac)
  for (const quote of ['Welcome Dr. Patel to the team! New clinic now open in Parkdale', 'Thank you Parkdale! The new clinic is now open']) assert.deepEqual(both(DENTAL, 'Metro City Dentistry', quote), [false, 'unknown'], quote)
})

test('#878 review at 519f060c R5: a handle is the lead only when it equals the lead\'s name; an extra or a missing distinctive word is another practice', () => {
  for (const [company, quote] of [
    ['Smile Dental', 'Congrats @brightsmiles! Their new clinic is now open in Parkdale'],
    ['City Dental', 'Congrats @kingcitydental! Their new clinic is now open in Parkdale'],
    ['Metro City Dentistry', 'Congrats @notmetrocitydentistry! Their new clinic is now open in Parkdale'],
    ['Metro City Dentistry', 'Congrats @metrocitydentistrynorth! Their new clinic is now open in Parkdale'],
    ['Metro City Dentistry', 'Congrats Metro City Dentistry North! Their new clinic is now open in Parkdale'],
    ['Metro City Dentistry', 'Metro Dental is growing. Their new clinic is now open in Parkdale'],
    ['Smile Dental', 'Smile Dental Studio Brampton is growing. Their new clinic is now open in Parkdale'],
  ]) assert.deepEqual(both(DENTAL, company, quote), [false, 'unknown'], quote)
  for (const quote of ['Congrats @metrocitydentistry! New clinic now open in Parkdale', 'Congrats @metro_city_dental! New clinic now open in Parkdale']) assert.deepEqual(both(DENTAL, 'Metro City Dentistry', quote), [true, 'pass'], quote)
})

// review (independent) at 77e509ac and 89e021f3, design by the author: openings main already read (verb-first, main's regex
// and object) are read with main's code; only the new forms are attributed to the lead from the whole quote, and fail
// closed when in doubt. The reviewer's corpus c1-c5: [plan, lead, quote, main gate, main C1, gate now, C1 now]. Main's
// values were recorded from origin/main (corpus c1-c12). Every difference from main is an opening that is the lead's own (posted as
// "our" / "we", the lead alone named, or nothing named at all): no other practice goes from unknown on main to pass.
test('#878 review at 2f8eeba2: the c1-c12 corpus against main; every flip is the lead\'s own opening', () => {
  // main C1 null: main compiled no such condition for the request
  const rows: [string, string, string, boolean, string | null, boolean, string][] = [
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing. Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Congrats @bright_smiles_dental! Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Congrats @bright.smiles! New clinic now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Congrats to \"bright smiles\" - their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "congrats to bright smiles! their new clinic is now open in parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Huge congrats to our neighbours. Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing. This new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing. Its new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing. The practice opened a new clinic in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing. Their team opened a new clinic in Parkdale", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing. The team opened a new clinic in Parkdale", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing. Dr. Patel opened a new clinic in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Shoutout to Bright Smiles, who opened a new clinic in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing and has opened a new clinic in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles: new clinic now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "BRIGHT SMILES IS GROWING. THEIR NEW CLINIC IS NOW OPEN IN PARKDALE", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing. Brand new clinic now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing. Our friends' new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Welcome to the neighbourhood, Bright Smiles! New clinic now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Congrats @metrocity! Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Congrats @metrocitydentistrynorth! Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Congrats @notmetrocitydentistry! Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Congrats Metro City Dentistry North! Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry congratulates Bright Smiles. Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro Dental is growing. Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "City Dental is growing. Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Smile Dental", "Smile Dental Studio Brampton is growing. Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Bright Smiles Dental Studio", "Bright Smiles is growing. Their new clinic is now open in Parkdale", false, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing. They have opened a new clinic in Parkdale", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing - their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing, and their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Big news from Bright Smiles. Opening a new clinic in Parkdale", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing. Now open: a new clinic in Parkdale", true, "unknown", true, "unknown"],
    ["SaaS companies launching a new product", "Acme", "Acme launched a new product today", true, "pass", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Today we launched a new product for finance teams", true, "pass", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Launched a new product for finance teams", true, "pass", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Introducing Acme Flow. We launched a new product today", true, "pass", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Meet Flow, our new AI assistant. We launched a new product built for Salesforce users", true, "pass", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Acme Corp launched a new product, its first since the Stripe integration", true, "pass", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Acme partners with HubSpot. They launched a new product for marketers", true, "pass", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Following feedback from Shopify merchants, Acme launched a new product", true, "pass", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "After talking to Salesforce admins we launched a new product", false, "unknown", false, "unknown"],
    ["SaaS companies launching a new product", "Acme", "Built with OpenAI. Launched a new product this week", true, "pass", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Acme launched a new product after the shutdown of its legacy tool", true, "pass", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Acme shut down its legacy product and launched a new product", true, "pass", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Acme moved to a new pricing model and launched a new product", true, "pass", true, "pass"],
    ["SaaS companies expanding to new markets", "Acme", "Acme is expanding to Austin", true, "unknown", true, "unknown"],
    ["SaaS companies expanding to new markets", "Acme", "Acme relocated its HQ and is expanding to Austin", true, "unknown", true, "unknown"],
    ["SaaS companies expanding to new markets", "Acme", "We are expanding to Austin. Thanks to our partners at Google", true, "unknown", true, "unknown"],
    ["SaaS companies expanding to new markets", "Acme", "Thanks to AWS, we are expanding to Austin", true, "unknown", true, "unknown"],
    ["SaaS companies expanding to new markets", "Acme", "Big news from the Acme team! Expanding to Austin this month", true, "unknown", true, "unknown"],
    ["SaaS companies expanding to new markets", "Acme", "Partnering with Microsoft. Expanding to Austin", true, "unknown", true, "unknown"],
    ["SaaS companies opening a new office", "Acme", "Acme relocated its HQ and opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Acme opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "We opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "After moving to a hybrid model, Acme opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Acme opened a new office in Austin after it moved to remote-first", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Acme has moved to a new HQ and opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Partnering with Google Cloud. Opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Thanks to Stripe! Opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Hello Austin! Opened a new office downtown", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Welcome Sarah Chen, our new VP. We opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Sarah Chen joins as VP. They opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Acme shut down its legacy product and opened a new office in Austin", true, "pass", true, "pass"],
    ["Restaurants opening a new location", "Joe's Pizza", "Joe's Pizza opened a new location on Queen St", true, "pass", true, "pass"],
    ["Restaurants opening a new location", "Joe's Pizza", "Opened a new location on Queen St! Come say hi", true, "pass", true, "pass"],
    ["Restaurants opening a new location", "Joe's Pizza", "Queen West, we are here! Opened a new location this week", true, "pass", true, "pass"],
    ["Restaurants opening a new location", "Joe's Pizza", "Shoutout to Toronto Life for the feature. We opened a new location on Queen St", true, "pass", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry opened a new clinic in Parkdale", true, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale", false, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Welcome Dr. Patel to the team! Our new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Welcome Dr. Patel to the team! New clinic now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Happy Holidays from Toronto! New clinic now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Thank you Parkdale! The new clinic is now open", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry is growing. They opened a new clinic in Parkdale", true, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dental opened a new clinic in Parkdale. Visit us at 12 Queen St", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Thanks to Invisalign for the support. We opened a new clinic in Parkdale", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Thanks to Invisalign for the support. Opened a new clinic in Parkdale", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry has moved to a bigger space and opened a new clinic in Parkdale", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry opened a new clinic in Parkdale. Our old Queen St office has closed", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry opened a new clinic in Parkdale. Our Yonge office relocated here", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry is expanding to Parkdale", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry is expanding to Parkdale after closing its old office", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry relocated and is expanding to Parkdale", true, "unknown", true, "unknown"],
    ["SaaS companies opening a new office", "Acme", "Acme has closed a $5M round and opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Acme opened a new office in Austin. Our old Boston office has closed", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Acme opened a new office in Austin. Applications for the beta are now closed", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Acme opened a new office in Austin to be closer to customers who moved to Texas", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Growing fast! Opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Big week at Acme. Opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "CEO Jane Doe said her team opened a new office in Austin", false, "unknown", false, "unknown"],
    ["SaaS companies launching a new product", "Acme", "CEO Jane Doe said her team launched a new product", false, "unknown", false, "unknown"],
    ["SaaS companies launching a new product", "Acme", "Acme integrates with Slack. Its new product launched today", false, "unknown", false, "unknown"],
    ["SaaS companies launching a new product", "Acme", "Acme integrates with Slack. They launched a new product today", true, "pass", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Acme announced a partnership with Slack and its team launched a new product", true, "pass", true, "pass"],
    ["SaaS companies expanding to new markets", "Acme", "Acme signs Walmart as a customer. They are expanding to Austin", true, "unknown", true, "unknown"],
    ["SaaS companies launching a new product", "Acme", "Bright Labs is growing. The new product launched today", false, "unknown", false, "unknown"],
    ["SaaS companies launching a new product", "Acme", "Bright Labs is growing. Launched a new product today", true, "pass", true, "pass"],
    ["SaaS companies launching a new product", "Acme", "Congrats @brightlabs! Their new product launched today", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Smile Dental", "Congrats @brightsmiles! Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "City Dental", "Congrats @kingcitydental! Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Family Dental Care", "Congrats @brightfamilydentalcare! Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Congrats @Bright_Smiles. Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Congrats to brightsmiles! Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Congrats to the team at bright smiles. New clinic now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Congrats to our friends down the street! Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Congrats Dr. Lee! Her new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Dr. Lee of Metro City Dentistry: her new clinic is now open in Parkdale", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing. That new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing. Another new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing. A new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing. Yet another new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing. Opening a new clinic in Parkdale", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing. Just opened a new clinic in Parkdale", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing. Officially opened a new clinic in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing. Grand opening of their new clinic in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing. Grand opening of its new clinic in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Big news! Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Proud to work with Bright Smiles. Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles celebrates a milestone. Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles just keeps growing! Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Looking for a dentist? Try Bright Smiles. Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Visit Bright Smiles! New clinic now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry welcomes Bright Smiles to the neighbourhood. Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Welcome Bright Smiles to Parkdale! Their new clinic is now open", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles celebrated a milestone. The new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles' new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Dr. Lee and the Bright Smiles team: their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "brightsmiles is growing. their new clinic is now open in parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles expands. Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles, a family practice, keeps growing. New clinic now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Thanks to Bright Smiles for the referral! Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. CLOSED", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale · Permanently closed · Dentist", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale | Permanently closed", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "We opened a new clinic in Parkdale. It closed in March", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "We opened a new clinic in Parkdale. Sadly, we have closed it", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. Permanently closed", false, "unknown", false, "unknown"],
    ["SaaS companies opening a new office", "Acme", "Sarah Chen has joined as CTO. Opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Austin is our next home! Opened a new office downtown", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Demand is booming! Opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Greetings from Austin! Opened a new office downtown", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "We were at SaaStr this week. Also opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Q3 was huge. Opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Hiring is up 40%. Opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Acme Software is growing. Opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Acme Software is growing. They opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Acme is growing. Opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme Inc", "ACME is growing. They opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Big news from Acme HQ. Opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "News from Acme. Opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Congrats to the whole team! Opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Shoutout to Stripe for the support. Opened a new office in Austin", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Live from Austin! We just opened a new office", true, "pass", true, "pass"],
    ["SaaS companies opening a new office", "Acme", "Stripe is our payments partner. They opened a new office in Austin", true, "pass", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dental Centre is growing. Their new clinic is now open in Parkdale", false, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City is growing. Their new clinic is now open in Parkdale", false, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Dr. Patel is joining us! New clinic now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Parkdale has a new dentist! New clinic now open on Queen St W", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Invisalign is now available. New clinic now open in Parkdale", false, "unknown", false, "unknown"],
    ["SaaS companies launching a new product", "Acme", "Bright Labs announced that we opened a new office", false, "unknown", false, "unknown"],
    ["SaaS companies launching a new product", "Acme", "Acme launched a new app and opened a new office. It has since closed", true, "unknown", true, "unknown"],
    ["SaaS companies expanding to new markets", "Acme", "Acme opened a new office and is expanding to Austin. Permanently closed", true, "unknown", true, "unknown"],
    ["SaaS companies expanding to new markets", "Acme", "Bright Labs is growing. They opened a new office and are expanding to Austin", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "so proud of bright smiles! new clinic now open in parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "#brightsmiles new clinic now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New clinic now open in Parkdale - congrats Bright Smiles!", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New clinic now open in Parkdale. Congrats Bright Smiles!", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New clinic now open in Parkdale 🎉 @brightsmiles", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Excited for them! New clinic now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our neighbours did it! New clinic now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "so happy for our neighbours. opened a new clinic in parkdale", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Grand opening of their new clinic in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New clinic now open in Parkdale, run by the bright smiles team", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Hello Toronto! New clinic now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Happy Monday Parkdale! Our new clinic is now open", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Welcome Dr. Patel to the team! Our new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New dental clinic now open in Parkdale", false, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our 5th location is now open", false, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry: our 5th location is now open!", false, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "We opened a new clinic in Parkdale", true, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Opened a new clinic in Parkdale! Thanks Toronto", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Thanks Toronto! Opened a new clinic in Parkdale", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Invisalign now offered. Our new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["SaaS companies launching new services", "Acme", "Acme launched a new service for banks", true, "unknown", true, "unknown"],
    ["SaaS companies launching new features", "Acme", "Acme launched a new feature for banks", true, "unknown", true, "unknown"],
    ["SaaS companies launching a new feature", "Acme", "Acme launched new features for banks", true, "unknown", true, "unknown"],
    ["SaaS companies launching new businesses", "Acme", "Acme launched a new business unit", true, "unknown", true, "unknown"],
    ["SaaS companies launching new processes", "Acme", "Acme launched a new process", true, "unknown", true, "unknown"],
    ["SaaS companies launching new classes", "Acme", "Acme launched a new class", true, "unknown", true, "unknown"],
    ["SaaS companies launching new tomatoes", "Acme", "Acme launched a new tomato", true, "pass", true, "pass"],
    ["SaaS companies launching a new tomato", "Acme", "Acme launched new tomatoes", true, "pass", true, "pass"],
    ["SaaS companies launching new heroes", "Acme", "Acme launched a new hero", true, "pass", true, "pass"],
    ["SaaS companies launching new boxes", "Acme", "Acme launched a new box", true, "pass", true, "pass"],
    ["SaaS companies launching new releases", "Acme", "Acme launched new releases", true, "pass", true, "pass"],
    ["SaaS companies launching new sizes", "Acme", "Acme launched a new size", true, "unknown", true, "unknown"],
    ["SaaS companies expanding into Wales", "Acme", "Acme is expanding into Wales", true, "pass", true, "pass"],
    ["SaaS companies expanding into new markets", "Acme", "Acme is expanding into new markets", true, "pass", true, "pass"],
    ["Retailers opening new branches", "Acme", "Acme opened a new branch", true, "pass", true, "pass"],
    ["Retailers opening new offices", "Acme", "Acme opened new offices in Austin", true, "pass", true, "pass"],
    ["Retailers opening a new location", "Acme", "Acme opened a new store in Austin", true, "unknown", true, "pass"],
    ["Retailers opening a 5th location", "Acme", "Acme opened its 5th location in Austin", true, null, true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Bright Smiles is growing! Our new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "From all of us at Bright Smiles: our new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale! - The Bright Smiles team", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. Love, Bright Smiles", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "We at Bright Smiles opened our 5th location in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale! Book with Dr. Lee at Bright Smiles", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry welcomes bright smiles to the neighbourhood! Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry welcomes a new neighbour! Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry welcomes the practice down the street. Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry: new clinic now open in Parkdale. Thanks Bright Smiles for the referral!", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New clinic now open in Parkdale #brightsmilesdental", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New clinic now open in Parkdale #brightsmiles #newclinic", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New clinic now open in Parkdale #metrocitydentistry", false, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Their new clinic is now open in Parkdale. Congrats Metro City Dentistry!", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Their new clinic is now open in Parkdale. Congrats Metro City Dentistry and Bright Smiles!", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry: their new clinic is now open in Parkdale, says bright smiles", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "metro city dentistry shared: new clinic now open in parkdale by bright smiles", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry reposted: Bright Smiles' new clinic is now open in Parkdale", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry reposted @brightsmiles: new clinic now open in Parkdale", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry reposted brightsmiles: new clinic now open in Parkdale", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry is growing. Their new clinic is now open in Parkdale. Welcome Bright Smiles' Dr. Lee to the team", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry and bright smiles dental are growing. Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Grand opening of our new clinic in Parkdale. Hosted by Bright Smiles", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. Proudly part of the Bright Smiles family", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New clinic now open in Parkdale. A bright smiles dental location", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New clinic now open in Parkdale, a bright smiles location", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Dr. Lee's new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New clinic now open in Parkdale. Dr. Lee and team welcome you", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale, #parkdale #torontodentist", false, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "So excited! Our new clinic is now open in Parkdale. #familydentistry #smiles", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open at Bright Smiles Dental in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New clinic now open at Bright Smiles Plaza, Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale Village Bright Smiles", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale 🦷 Book now: brightsmiles.com", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. www.brightsmiles.ca", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. Call 416-555-0100", false, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "bright smiles: our new clinic is now open in parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "bright smiles here! our new clinic is now open in parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "brightsmiles.ca - our new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "the bright smiles crew: our new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "dr lee's new clinic is now open in parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "\"Our new clinic is now open,\" Dr. Lee of Bright Smiles told CP24", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "\"Our new clinic is now open,\" dr lee told reporters", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. Owned and operated by bright smiles", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. A member of the bright smiles network", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. Formerly metro city dentistry", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. Not affiliated with Metro City Dentistry", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry is growing. Their new clinic is now open in Parkdale. Brought to you by bright smiles", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry is growing. Their new clinic is now open in Parkdale under new owner bright smiles", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry was acquired. Their new clinic is now open in Parkdale", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry has a new neighbour. Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry has new competition. Their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry is growing. They say their new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale", false, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale! Come visit us", false, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale! Book online, link in bio 🦷✨ #newclinic #dentist", false, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "We're excited to share that our new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry: new clinic now open in Parkdale!", true, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "@metrocitydentistry new clinic now open in Parkdale", false, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Big news! Our new clinic is now open in Parkdale", false, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. Thank you to our amazing patients!", false, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. Thank you to all our patients and staff", false, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our second location is now open in Parkdale. Same great team, new address", false, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open on the same street as Metro City Dentistry", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open at the same address as Metro City Dentistry", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale, in the same space as Metro City Dentistry", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. Not Metro City Dentistry", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale, next door to Metro City Dentistry", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. We are not Metro City Dentistry", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in the Metro City Dentistry space", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open at Metro City Dentistry North", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale - Open Door Clinic", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Open Door Clinic: our new clinic is now open in Parkdale", true, "unknown", true, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Open Door Clinic is growing! Our new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. Love, The Community Clinic", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. Love, the community clinic team", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "The Community Clinic is growing! Our new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Same Day Clinic: our new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Hello Clinic! Our new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Grand Avenue Clinic is growing! Our new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Happy Patients Clinic is open! Our new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. Best Clinic in town!", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. Your Neighbourhood Clinic", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. The Neighbourhood Clinic team", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale! - Team Amazing", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. We are Community Health", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale - the Metro team", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry is growing. Their new clinic is now open in Parkdale. Open Door Clinic", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry is growing. Their new clinic is now open in Parkdale. Welcome Open Door Clinic", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry is growing! Our new clinic is now open in Parkdale", false, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. Love, Amazing", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Amazing is growing! Our new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Welcome Home is growing! Our new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Smiles! Our new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Family! Our new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry is growing. Their new clinic is now open in Parkdale. love, open door clinic", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry is growing! Our new clinic is now open, same as the community clinic", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry is growing. Their new clinic is now open in Parkdale, same as the community clinic", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "open door clinic is growing! our new clinic is now open in parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "the community clinic is growing! our new clinic is now open in parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "OPEN DOOR CLINIC IS GROWING! OUR NEW CLINIC IS NOW OPEN IN PARKDALE", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Open-Door Clinic is growing! Our new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Open. Door. Clinic. Our new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Open Door, Clinic! Our new clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale, the same as Open Door Clinic", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale, same as Metro City Dentistry", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "metro city dentistry is growing. their new clinic is now open in parkdale. the community clinic team", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "metro city dentistry is growing! our new clinic is now open in parkdale. hello from the neighbourhood clinic", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry is growing! Our new clinic is now open in Parkdale. The Community team", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. - Grand Clinic", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale. Love, the team at grand clinic", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry is growing. Their new clinic is now open in Parkdale! the open door team", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new clinic is now open in Parkdale! the best clinic team", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new Title Case Clinic Is Now Open In Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our New Clinic Is Now Open In Parkdale", false, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Metro City Dentistry: Our New Clinic Is Now Open!", true, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new Bright Smiles clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our New Bright Smiles Clinic Is Now Open In Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new Bright Smiles Clinic Is Now Open", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new Smiles clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new Bright clinic is now open", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "OUR NEW BRIGHT SMILES CLINIC IS NOW OPEN", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "our new bright smiles clinic is now open in parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new Title Case Clinic Is Now Open In Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new Parkdale clinic is now open", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New Bright Smiles clinic now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New Bright Smiles Clinic Now Open In Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New Bright Smiles Clinic is now open in Parkdale!", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "The new Bright Smiles Clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New Bright Smiles Dental Clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new Bright Smiles Clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Brand new Bright Smiles Office is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New Smile Studio is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New Kids Dental Clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new Metro City Dentistry Clinic is now open in Parkdale", false, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New Parkdale Clinic is now open", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new Parkdale Location is now open!", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New Family Dental Clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New Downtown Dental Clinic is now open", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New Care Dental Clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New Urgent Care Clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New Community Health Clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New Family Health Clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New Pediatric Dental Care Clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New Modern Family Dental Clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New Bright Smiles Family Dental Clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New Metro Dental Clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New City Dental Clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New City Family Dental Clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New Metro City Family Dental Clinic is now open", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new Metro Dental Clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New metro dental clinic now open in parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "new city dental clinic now open in parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new City Dental office is now open", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New Family Dental clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new Family Dental Clinic is now open", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New Main Street Dental Clinic is now open", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New Dental Care Clinic now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Second Family Dental location is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "New Toronto Dental Clinic is now open", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new Toronto clinic is now open", false, "unknown", false, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Our new Parkdale clinic is now open", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Grand opening of their new Family Dental Clinic", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Metro City Dentistry", "Grand opening of our new Family Dental Clinic in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Family Dental Care", "New Family Care Clinic is now open in Parkdale", false, "unknown", true, "pass"],
    ["Dental clinics in Toronto opening a new location or expanding", "Family Dental Care", "New Family Dental Clinic is now open in Parkdale", false, "unknown", false, "unknown"],
    ["Dental clinics in Toronto opening a new location or expanding", "Family Dental Care", "Our new Family Dental Care clinic is now open", false, "unknown", true, "pass"],
  ]
  // the only quotes whose result differs from main: each is an opening this lead made
  const LEAD_OWN = new Set([
    "Bright Smiles is growing. Their new clinic is now open in Parkdale",
    "Metro City Dentistry opened a new clinic in Parkdale",
    "Our new clinic is now open in Parkdale",
    "Metro City Dentistry is growing. They opened a new clinic in Parkdale",
    "Metro City Dental Centre is growing. Their new clinic is now open in Parkdale",
    "Metro City is growing. Their new clinic is now open in Parkdale",
    "New dental clinic now open in Parkdale",
    "Our 5th location is now open",
    "Metro City Dentistry: our 5th location is now open!",
    "We opened a new clinic in Parkdale",
    "Acme opened a new store in Austin",
    "Acme opened its 5th location in Austin",
    "New clinic now open in Parkdale #metrocitydentistry",
    "Our new clinic is now open in Parkdale, #parkdale #torontodentist",
    "Our new clinic is now open in Parkdale. Call 416-555-0100",
    "Our new clinic is now open in Parkdale! Come visit us",
    "Our new clinic is now open in Parkdale! Book online, link in bio 🦷✨ #newclinic #dentist",
    "Metro City Dentistry: new clinic now open in Parkdale!",
    "@metrocitydentistry new clinic now open in Parkdale",
    "Big news! Our new clinic is now open in Parkdale",
    "Our new clinic is now open in Parkdale. Thank you to our amazing patients!",
    "Our new clinic is now open in Parkdale. Thank you to all our patients and staff",
    "Our second location is now open in Parkdale. Same great team, new address",
    "Metro City Dentistry is growing! Our new clinic is now open in Parkdale",
    "Our New Clinic Is Now Open In Parkdale",
    "Metro City Dentistry: Our New Clinic Is Now Open!",
    "Our new Metro City Dentistry Clinic is now open in Parkdale",
    "Our new Toronto clinic is now open",
    "New Family Care Clinic is now open in Parkdale",
    "Our new Family Dental Care clinic is now open",
  ])
  for (const [q, company, quote, mainGate, mainC1, gate, c1] of rows) {
    assert.deepEqual(both(q, company, quote), [gate, c1], quote)
    if (gate !== mainGate || c1 !== mainC1) {
      assert.ok(LEAD_OWN.has(quote), `${quote}: differs from main but is not listed as the lead's own opening`)
      assert.match(quote, /\bopen/i, 'only openings differ from main')
      assert.ok(c1 === 'pass' && mainC1 !== 'fail', `${quote}: a flip only ever makes the lead's own opening pass`)
    }
  }
  assert.equal(LEAD_OWN.size, 30)   // 31 flipped rows (1 quote(s) in two corpus files)
})

test('#878 review at 77e509ac R1 / R8 / R9: no context fails closed, the new banners close, the lead with descriptive words is the lead', () => {
  // R1: a pronoun with no one named, and every other-practice shape, never pass
  for (const quote of ['Their new clinic is now open in Parkdale', 'Big news! Their new clinic is now open in Parkdale', 'Visit Bright Smiles! New clinic now open in Parkdale', "Bright Smiles' new clinic is now open in Parkdale", 'Thanks to Bright Smiles for the referral! Their new clinic is now open in Parkdale']) assert.notEqual(truthOf(DENTAL, 'Metro City Dentistry', quote), 'pass', quote)
  // R8: "·", "|", a bare CLOSED, "It closed in March", "we have closed it"
  for (const quote of ['Our new clinic is now open in Parkdale · Permanently closed · Dentist', 'Our new clinic is now open in Parkdale | Permanently closed', 'Our new clinic is now open in Parkdale. CLOSED', 'We opened a new clinic in Parkdale. It closed in March', 'We opened a new clinic in Parkdale. Sadly, we have closed it']) assert.notEqual(truthOf(DENTAL, 'Metro City Dentistry', quote), 'pass', quote)
  // R9: the lead's own words with only descriptive words after them are the lead; a place word after them is not
  for (const quote of ['Metro City Dental Centre is growing! New clinic now open in Parkdale', 'Metro City is growing! New clinic now open in Parkdale', 'Metro City Dental Centre is growing. Their new clinic is now open in Parkdale']) assert.equal(truthOf(DENTAL, 'Metro City Dentistry', quote), 'pass', quote)
  assert.notEqual(truthOf(DENTAL, 'Metro City Dentistry', 'Metro City North is growing! New clinic now open in Parkdale'), 'pass')
  // the bare noun-first opening, and the poster's own, still pass
  for (const quote of ['New dental clinic now open in Parkdale', 'Our new clinic is now open in Parkdale']) assert.equal(truthOf(DENTAL, 'Metro City Dentistry', quote), 'pass', quote)
})

test('#878 review at 89e021f3 R1: a new-form opening is attributed from the whole quote, before and after it', () => {
  // [lead plan C1 must not pass, gate as main]: other practices after the opening, lower-case targets, unnamed parties,
  // a pronoun inside the opening
  for (const quote of [
    'New clinic now open in Parkdale 🎉 @brightsmiles',
    'New clinic now open in Parkdale - congrats Bright Smiles!',
    'New clinic now open in Parkdale. Congrats Bright Smiles!',
    'New clinic now open in Parkdale, run by the bright smiles team',
    'so proud of bright smiles! new clinic now open in parkdale',
    'Excited for them! New clinic now open in Parkdale',
    'Our neighbours did it! New clinic now open in Parkdale',
    'so happy for our neighbours. opened a new clinic in parkdale',
    'Grand opening of their new clinic in Parkdale',
  ]) assert.deepEqual(both(DENTAL, 'Metro City Dentistry', quote), [verbFirst(quote), 'unknown'], quote)
  // the poster's own ("our" / "we"), the lead alone named, or nothing named: the lead's
  for (const quote of [
    'New dental clinic now open in Parkdale',
    'Metro City Dentistry is growing! New clinic now open in Parkdale',
    'Congrats to us @metrocitydentistry! Our new clinic is now open',
  ]) assert.deepEqual(both(DENTAL, 'Metro City Dentistry', quote), [true, 'pass'], quote)
  // the poster's own opening still fails with another practice's handle, or congrats aimed at someone else
  for (const quote of ['Our new clinic is now open in Parkdale @brightsmiles', 'Congrats to Bright Smiles! Our new clinic is now open in Parkdale']) assert.notEqual(truthOf(DENTAL, 'Metro City Dentistry', quote), 'pass', quote)
})

test('#878 decision after the review at 89e021f3: a pronoun is the lead\'s when the lead is the only name in the quote; generic #tags are no name', () => {
  for (const [company, quote] of [
    ['Family Dental Care', 'Family Dental Care is growing. Their new clinic is now open'],
    ['Metro City Dentistry', 'Metro City Dentistry is growing. Their new clinic is now open in Parkdale'],
    ['Metro City Dentistry', 'New dental clinic now open in Parkdale #newclinic #grandopening #dentist #toronto'],
    ['Metro City Dentistry', 'Our new clinic is now open in Parkdale #newclinic #dentist'],
  ]) assert.deepEqual(both(DENTAL, company, quote), [true, 'pass'], quote)
  for (const [company, quote] of [
    ['Metro City Dentistry', 'Grand opening of their new clinic in Parkdale'],
    ['Metro City Dentistry', 'Their new clinic is now open in Parkdale'],
    ['Metro City Dentistry', 'Bright Smiles is growing. Their new clinic is now open in Parkdale'],
    ['Family Dental Care', 'Bright Family Dentistry is growing. Their new clinic is now open in Parkdale'],
    ['Metro City Dentistry', 'Excited for them! New clinic now open in Parkdale'],
    // the lead named, but someone else (unnamed, or a congrats target) is in the quote too
    ['Metro City Dentistry', 'Metro City Dentistry is growing. Excited for them! Their new clinic is now open'],
    ['Metro City Dentistry', 'Metro City Dentistry is growing. Our neighbours did it! Their new clinic is now open'],
    // a #tag that is a business name is a name
    ['Metro City Dentistry', '#brightsmiles new clinic now open in Parkdale'],
    ['Metro City Dentistry', '#familydentalcare new clinic now open in Parkdale'],
    ['Metro City Dentistry', 'Our new clinic is now open in Parkdale #brightsmiles'],
  ]) assert.deepEqual(both(DENTAL, company, quote), [false, 'unknown'], quote)
})

// review at d010a0c3, design by the author: all three attribution paths are strict. Main gives unknown for every new form,
// so failing closed loses nothing against main.
test('#878 review at d010a0c3: first person, lead named and nobody named are strict; documented fail-closed limits', () => {
  const no: [string, string][] = [
    // (i) first person with another practice anywhere in the rest of the quote
    ['Metro City Dentistry', 'Bright Smiles is growing! Our new clinic is now open in Parkdale'],
    ['Metro City Dentistry', 'Our new clinic is now open in Parkdale! - The Bright Smiles team'],
    ['Metro City Dentistry', 'Our new clinic is now open in Parkdale. Love, Bright Smiles'],
    ['Metro City Dentistry', 'Our new clinic is now open in Parkdale! Book with Dr. Lee at Bright Smiles'],
    ['Metro City Dentistry', 'Grand opening of our new clinic in Parkdale. Hosted by Bright Smiles'],
    ['Metro City Dentistry', 'Our new clinic is now open in Parkdale. Proudly part of the Bright Smiles family'],
    ['Metro City Dentistry', 'We at Bright Smiles opened our 5th location in Parkdale'],
    // (ii) the lead named, with a party marker or a pronoun the lead is not the lead-in subject of
    ['Metro City Dentistry', 'Metro City Dentistry welcomes a new neighbour! Their new clinic is now open in Parkdale'],
    ['Metro City Dentistry', 'Metro City Dentistry welcomes the practice down the street. Their new clinic is now open in Parkdale'],
    ['Metro City Dentistry', 'Metro City Dentistry welcomes bright smiles to the neighbourhood! Their new clinic is now open in Parkdale'],
    ['Metro City Dentistry', 'Metro City Dentistry and bright smiles dental are growing. Their new clinic is now open in Parkdale'],
    ['Metro City Dentistry', 'Metro City Dentistry: their new clinic is now open in Parkdale, says bright smiles'],
    ['Metro City Dentistry', 'Metro City Dentistry reposted brightsmiles: new clinic now open in Parkdale'],
    ['Metro City Dentistry', 'Their new clinic is now open in Parkdale. Congrats Metro City Dentistry!'],
    // (iii) nobody named, with anything but generic tags, emoji, punctuation or a call to action
    ['Metro City Dentistry', 'New clinic now open in Parkdale. A bright smiles dental location'],
    ['Metro City Dentistry', 'New clinic now open in Parkdale, a bright smiles location'],
    ['Metro City Dentistry', 'Grand opening of their new clinic in Parkdale'],
    // a lower-case sign-off or attribution naming another practice
    ['Metro City Dentistry', 'Our new clinic is now open in Parkdale. love, bright smiles'],
    ['Metro City Dentistry', 'Our new clinic is now open in Parkdale - the bright smiles team'],
    ['Metro City Dentistry', 'Our new clinic is now open in Parkdale from all of us at bright smiles'],
    ['Metro City Dentistry', 'Our new clinic is now open in Parkdale via @brightsmiles'],
    ['Metro City Dentistry', 'Our new clinic is now open in Parkdale. xo bright smiles'],
    ['Metro City Dentistry', 'Our new clinic is now open in Parkdale. cheers, bright smiles'],
    ['Metro City Dentistry', 'Our new clinic is now open in Parkdale. hosted by bright smiles'],
    // documented fail-closed limits: the lead's own post with another name, a person or an unlisted place in it
    ['Metro City Dentistry', 'Welcome Dr. Patel to the team! Our new clinic is now open in Parkdale'],
    ['Metro City Dentistry', 'Happy Monday Parkdale! Our new clinic is now open'],
    ['Metro City Dentistry', 'Invisalign now offered. Our new clinic is now open in Parkdale'],
    ['Metro City Dentistry', 'Congrats @metrocitydentistry! Their new clinic is now open in Parkdale'],
    ['Metro City Dentistry', 'So excited! Our new clinic is now open in Parkdale. #familydentistry #smiles'],
  ]
  for (const [company, quote] of no) assert.notEqual(truthOf(DENTAL, company, quote), 'pass', quote)
  const yes: [string, string][] = [
    ['Family Dental Care', 'Family Dental Care is growing. Their new clinic is now open'],
    ['Metro City Dentistry', 'Metro City Dentistry is growing. Their new clinic is now open in Parkdale'],
    ['Metro City Dentistry', 'New dental clinic now open in Parkdale'],
    ['Metro City Dentistry', 'New dental clinic now open in Parkdale! Book now #newclinic'],
    ['Metro City Dentistry', 'Metro City Dentistry is growing! New clinic now open in Parkdale'],
    ['Metro City Dentistry', 'Congrats to us @metrocitydentistry! Our new clinic is now open'],
    ['Metro City Dentistry', 'Our new clinic is now open in Parkdale, #parkdale #torontodentist'],
    ['Kailash Dentistry', 'new dental clinic now open in parkdale'],
    ['Kailash Dentistry', 'New clinic now open - come say hi'],
    // a call to action, or the lead's own sign-off
    ['Metro City Dentistry', 'Our new clinic is now open in Parkdale! See you soon'],
    ['Metro City Dentistry', 'Our new clinic is now open in Parkdale - the Metro City Dentistry team'],
    ['Metro City Dentistry', 'Our new clinic is now open in Parkdale - the metro city dentistry team'],
    ['Metro City Dentistry', 'Our new clinic is now open in Parkdale! Stop by and say hi'],
  ]
  for (const [company, quote] of yes) assert.equal(truthOf(DENTAL, company, quote), 'pass', quote)
})

// review at e0eb5d61, design by the author: for a first-person or lead-named opening the rest of the quote may say only
// allow-listed things (function and celebration words, a call to action, thanks to patients or staff, places,
// addresses, phone numbers, hours, emoji, generic #tags); the opening's own place never hides a practice; a domain is a
// party unless it is the lead's.
test('#878 review at e0eb5d61: the rest of a first-person or lead-named opening is allow-listed; places and domains hide no practice', () => {
  const no = [
    // R13: a practice inside the opening's own place
    'Our new clinic is now open at Bright Smiles Dental in Parkdale',
    'New clinic now open at Bright Smiles Plaza, Parkdale',
    'Our new clinic is now open in Parkdale Village Bright Smiles',
    // R14: another practice's domain
    'Our new clinic is now open in Parkdale 🦷 Book now: brightsmiles.com',
    'Our new clinic is now open in Parkdale. www.brightsmiles.ca',
    'brightsmiles.ca - our new clinic is now open in Parkdale',
    // R1: anything off the allow-list
    'bright smiles: our new clinic is now open in parkdale',
    'bright smiles here! our new clinic is now open in parkdale',
    'the bright smiles crew: our new clinic is now open in Parkdale',
    "dr lee's new clinic is now open in parkdale",
    '"Our new clinic is now open," Dr. Lee of Bright Smiles told CP24',
    '"Our new clinic is now open," dr lee told reporters',
    'Our new clinic is now open in Parkdale. Owned and operated by bright smiles',
    'Our new clinic is now open in Parkdale. A member of the bright smiles network',
    'Our new clinic is now open in Parkdale. Formerly metro city dentistry',
    'Our new clinic is now open in Parkdale. Not affiliated with Metro City Dentistry',
    'Metro City Dentistry is growing. Their new clinic is now open in Parkdale. Brought to you by bright smiles',
    'Metro City Dentistry is growing. Their new clinic is now open in Parkdale under new owner bright smiles',
    'Metro City Dentistry was acquired. Their new clinic is now open in Parkdale',
    'Metro City Dentistry has a new neighbour. Their new clinic is now open in Parkdale',
    'Metro City Dentistry has new competition. Their new clinic is now open in Parkdale',
    'Metro City Dentistry is growing. They say their new clinic is now open in Parkdale',
    // documented fail-closed limits: off-list words in the lead's own post
    "We're excited to share that our new clinic is now open in Parkdale",
    'Metro City Dentistry has moved to a bigger space and opened a new clinic in Parkdale',
  ]
  for (const quote of no) assert.notEqual(truthOf(DENTAL, 'Metro City Dentistry', quote), 'pass', quote)
  const yes = [
    'Our new clinic is now open in Parkdale',
    'Our new clinic is now open in Parkdale! Come visit us',
    'Our new clinic is now open in Parkdale! Book online, link in bio 🦷✨ #newclinic #dentist',
    'Metro City Dentistry: new clinic now open in Parkdale!',
    '@metrocitydentistry new clinic now open in Parkdale',
    'Big news! Our new clinic is now open in Parkdale',
    'Our new clinic is now open in Parkdale. Thank you to our amazing patients!',
    'Our new clinic is now open in Parkdale. Thank you to all our patients and staff',
    'Our second location is now open in Parkdale. Same great team, new address',
    'Our new clinic is now open in Parkdale. Call 416-555-0100',
    'Our new clinic is now open in Parkdale. Book now: metrocitydentistry.com',
  ]
  for (const quote of yes) assert.equal(truthOf(DENTAL, 'Metro City Dentistry', quote), 'pass', quote)
})

// review at 5790121b: a practice name made of allow-listed words, the lead's words in another place name, and the lead
// named only to be set apart, all fail closed
test('#878 review at 5790121b: practice names of ordinary words, the lead inside another name, and the lead set apart fail closed', () => {
  const no = [
    // R1: a capitalised run with 2+ words or a premises / practice word is a name
    'Open Door Clinic is growing! Our new clinic is now open in Parkdale',
    'The Community Clinic is growing! Our new clinic is now open in Parkdale',
    'Grand Avenue Clinic is growing! Our new clinic is now open in Parkdale',
    'Happy Patients Clinic is open! Our new clinic is now open in Parkdale',
    'Hello Clinic! Our new clinic is now open in Parkdale',
    'Our new clinic is now open in Parkdale. Your Neighbourhood Clinic',
    'Metro City Dentistry is growing. Their new clinic is now open in Parkdale. Open Door Clinic',
    'Open Door Clinic: our new clinic is now open in Parkdale',
    'Same Day Clinic: our new clinic is now open in Parkdale',
    'Our new clinic is now open in Parkdale. We are Community Health',
    // R13: the lead's words inside another name in the opening's place
    'Our new clinic is now open at Metro City Dentistry North',
    // R15: the lead named only to set it apart
    'Our new clinic is now open in Parkdale. Not Metro City Dentistry',
    'Our new clinic is now open in Parkdale. We are not Metro City Dentistry',
    'Our new clinic is now open in Parkdale, in the same space as Metro City Dentistry',
    'Our new clinic is now open on the same street as Metro City Dentistry',
    'Our new clinic is now open in Parkdale, next door to Metro City Dentistry',
  ]
  for (const quote of no) assert.notEqual(truthOf(DENTAL, 'Metro City Dentistry', quote), 'pass', quote)
  // the lead's own posts with title-case stop words keep passing
  for (const quote of ['Metro City Dentistry is growing! Our new clinic is now open in Parkdale', 'Big News! Our new clinic is now open in Parkdale', 'Our new clinic is now open in Parkdale. Thank You! Book Now', 'Our second location is now open in Parkdale. Same Great Team, New Address']) assert.equal(truthOf(DENTAL, 'Metro City Dentistry', quote), 'pass', quote)
})

// review at 9e928898: the words inside an opening ("New Bright Smiles Clinic") are read like the rest of the quote, in
// the gate and in C1 alike; a sentence subject other than the lead is a party
test('#878 review at 9e928898: the opening\'s own words name no other practice; any other sentence subject is a party', () => {
  const both2 = (quote: string) => [quoteShowsEvent(quote, quote, false, 'Metro City Dentistry'), truthOf(DENTAL, 'Metro City Dentistry', quote)]
  for (const quote of [
    'New Bright Smiles Clinic is now open in Parkdale!',
    'Our new Bright Smiles Clinic is now open in Parkdale',
    'Brand new Bright Smiles Office is now open in Parkdale',
    'New Smile Studio is now open in Parkdale',
    'New Kids Dental Clinic is now open in Parkdale',
    'Our new Bright Smiles Clinic Is Now Open',
    'New Bright Smiles clinic now open in Parkdale',
    'Our new Bright Smiles clinic is now open in Parkdale',
    'our new bright smiles clinic is now open in parkdale',
    'OUR NEW BRIGHT SMILES CLINIC IS NOW OPEN',
    // R1: a sentence subject or "team at" someone other than the lead
    'open door clinic is growing! our new clinic is now open in parkdale',
    'the community clinic is growing! our new clinic is now open in parkdale',
    'Our new clinic is now open in Parkdale. Love, the team at grand clinic',
    'Amazing is growing! Our new clinic is now open in Parkdale',
    'Metro City Dentistry is growing! Our new clinic is now open, same as the community clinic',
    // R17 (review at 2f8eeba2): part of the lead's name in the opening is another practice
    'New Metro Dental Clinic is now open in Parkdale',
    'New City Dental Clinic is now open in Parkdale',
    'Our new Metro Dental Clinic is now open in Parkdale',
    'Our new City Dental office is now open',
    'new city dental clinic now open in parkdale',
    // in mixed-case text a capitalised fill is a name, premises adjectives included
    'Grand opening of our new Family Dental Clinic in Parkdale',
  ]) assert.deepEqual(both2(quote), [false, 'unknown'], quote)
  assert.notEqual(truthOf(DENTAL, 'Family Dental Care', 'New Family Dental Clinic is now open in Parkdale'), 'pass')
  for (const quote of [
    'Our new Metro City Dentistry clinic is now open in Parkdale',
    'New Metro City Dentistry location now open in Parkdale',
    'Our New Clinic Is Now Open In Parkdale',
    'New dental clinic now open in Parkdale',
    'Our new flagship clinic is now open in Parkdale',
    'Metro City Dentistry is growing! Our new clinic is now open in Parkdale',
    'Our new Metro City Dentistry Clinic is now open in Parkdale',
  ]) assert.deepEqual(both2(quote), [true, 'pass'], quote)
  // the lead's whole name with premises adjectives in it is the lead; "dental" alone is an adjective, not the lead's name
  // (documented limit: for a lead named only with premises adjectives, "Our new Family Dental clinic" reads as generic)
  assert.equal(truthOf(DENTAL, 'Family Dental Care', 'Our new Family Dental Care clinic is now open in Parkdale'), 'pass')
  assert.equal(truthOf(DENTAL, 'Eleven Dental', 'New dental clinic now open in Parkdale'), 'pass')
  // documented fail-closed limit: a place word before the noun is read as a name unless the request names that place
  for (const quote of ['Our new Woodbridge location is now open!', 'Our new Parkdale clinic is now open', 'New Parkdale Clinic is now open']) assert.notEqual(truthOf(DENTAL, 'Metro City Dentistry', quote), 'pass', quote)
  assert.equal(truthOf('Dental clinics in Woodbridge opening a new location', 'Metro City Dentistry', 'Our new Woodbridge location is now open!'), 'pass')
  assert.equal(truthOf('Dental clinics in Parkdale opening a new location', 'Metro City Dentistry', 'Our new Parkdale clinic is now open'), 'pass')
})

// Hermes-PC at cc18ffd5: "at <Name>" names a venue or business; after at / inside an opening may only name a street
// address, the request's own place, or the lead itself
test('#878 review (Hermes-PC) at cc18ffd5: a business named as the opening\'s place is another practice\'s opening', () => {
  const both3 = (company: string, quote: string) => [quoteShowsEvent(quote, quote, false, company), truthOf(DENTAL, company, quote)]
  for (const [company, quote] of [
    ['Metro City Dentistry', "New clinic now open at Dr Lee's in Parkdale"],
    ['Metro City Dentistry', 'New dental clinic now open at Queen West Dentists'],
    ['Metro City Dentistry', 'New clinic now open at Sunrise Wellness in Parkdale'],
    ['Metro City Dentistry', 'New clinic now open at Maple Medical in Parkdale'],
    ['Metro City Dentistry', 'New clinic now open at Dentalcorp Parkdale'],
    ['Family Dental Care', "Our new clinic is now open at Dr Lee's in Parkdale"],
    ['Metro City Dentistry', 'New clinic at Sunrise Wellness is now open'],
  ]) assert.deepEqual(both3(company, quote), [false, 'unknown'], quote)
  for (const quote of [
    'Our new clinic is now open at 123 Queen St W',
    'New dental clinic opened in Yorkville at 11 Yorkville Ave in Toronto',
    'Opened a new 5th location in Woodbridge on Hwy 27 in the GTA',
    'New dental clinic now open in Parkdale, Toronto',
    'Our new clinic is now open at Metro City Dentistry in Parkdale',
  ]) assert.equal(truthOf(DENTAL, 'Metro City Dentistry', quote), 'pass', quote)
  // the read is bounded: a very long quote is clipped, not read whole
  const long = 'New clinic now open in Parkdale. '.repeat(400)
  const t0 = Date.now()
  quoteShowsEvent(long, long, false, 'Metro City Dentistry')
  assert.ok(Date.now() - t0 < 3000, 'a 13 KB quote is read within 3 s')
})

// review round 10 (R19): a business named after "in" is a practice, not a place: same class as Hermes-PC's "at <business>" finding at cc18ffd5
test('#878 round 10: "in <business with a practice word>" is not the opening\'s place (gate and C1 fail closed); real places still pass', () => {
  for (const quote of ['New clinic now open in Sunrise Wellness', 'New clinic now open in Maple Medical in Parkdale', 'Our new clinic is now open in Queen West Dentists', 'New dental clinic now open in Parkdale Physio'])
    assert.deepEqual([quoteShowsEvent(quote, quote, false, 'Metro City Dentistry'), truthOf(DENTAL, 'Metro City Dentistry', quote)], [false, 'unknown'], quote)
  for (const quote of ['New dental clinic now open in Parkdale, Toronto', 'Our new clinic is now open at 123 Queen St W', 'New dental clinic now open in Parkdale'])
    assert.equal(truthOf(DENTAL, 'Metro City Dentistry', quote), 'pass', quote)
})
