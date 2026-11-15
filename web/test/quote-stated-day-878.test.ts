// #878 (prod matrix 14 Nov, berlin-fintech): "Pliant" was held outside_window_undated although its quote says when the event happened ("... announced an
// $80 million Series C on Nov. 4, 2026"). The model claimed the story's publication day (2026-11-05); the binder rightly refused that day, and nothing then
// tried the day the quote itself states. Now the quote's own day is kept when the same binding rule ties it to this company and event on the page.
// SYNTHETIC pages (invented companies and URLs) through the real runner, verifier and window gate; no network, no key.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture, type Cand } from './helpers/acceptance-harness.ts'
import { dayStatedForEvent } from '../lib/scan/event-date-binding.ts'

const REQUEST = 'Find fintech companies in Berlin that raised a funding round in the past 90 days.'
const ICP = { summary: 'Berlin fintech companies', who: ['CFO'], industries: ['fintech'], sizes: [], where: ['Berlin'], signals: ['raised a funding round'], exclude: [], country: 'DE', language: 'en', window_days: 90 }
const filler = ' The round will fund hiring across product and engineering, the company said in a statement to customers and partners.'.repeat(6)
const MON = ['Jan.', 'Feb.', 'March', 'April', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.']
const written = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return `${MON[m - 1]} ${d}, ${y}` }   // "Nov. 4, 2026", as the page wrote it
const EVENT = daysAgo(10), PUB = daysAgo(9)
const URL_ = 'https://financenews.example/article/kestrel-pay-series-c'

async function lead(quote: string, text: string, claim: string | null, signal = 'raised a funding round') {
  const c: Cand = { company: 'Kestrel Pay', signal, source_url: URL_, excerpt: quote, event_date: claim }
  const f: Fixture = { request: REQUEST, modelIcp: ICP, modelQueries: ['berlin fintech series c'], hits: [{ url: URL_, title: 'Kestrel Pay raises Series C', snippet: quote, date: null }], tfPages: {},
    own: { [URL_]: { title: 'Kestrel Pay raises $80 million', text: text + filler } }, extraction: [c] }
  const x = await runFixture(f)
  return x.db.prepare('SELECT event_date, event_date_proof, event_date_proof_note, review_reason, timing_note FROM leads').get() as { event_date: string | null; event_date_proof: string | null; event_date_proof_note: string | null; review_reason: string | null; timing_note: string | null }
}

test('the model claimed the publication day; the quote states the event day: the lead is dated by the quote\'s day and is not held', async () => {
  const q = `BERLIN - Berlin-based fintech Kestrel Pay announced an $80 million Series C on ${written(EVENT)}`
  const r = await lead(q, `Published ${written(PUB)}. ${q}.`, PUB)
  assert.equal(r.event_date, EVENT, JSON.stringify(r))
  assert.equal(r.event_date_proof, 'page_bound')
  assert.match(r.event_date_proof_note ?? '', new RegExp(`^the day the quote states .*; the claimed ${PUB} is not this event's day$`))
  assert.equal(r.review_reason, null)
})

test('no day claimed at all, the quote states one: dated by it', async () => {
  const q = `Kestrel Pay raised an $80 million Series C on ${written(EVENT)} to expand in Berlin`
  const r = await lead(q, `${q}.`, null)
  assert.equal(r.event_date, EVENT, JSON.stringify(r))
  assert.equal(r.review_reason, null)
})

test('never a guess: a quote with no day, or a day the page gives to another company, stays undated and held', async () => {
  const none = `Kestrel Pay raised an $80 million Series C to expand in Berlin`
  const a = await lead(none, `Published ${written(PUB)}. ${none}.`, PUB)
  assert.equal(a.event_date, null); assert.equal(a.review_reason, 'outside_window_undated')
  const other = `Kestrel Pay raised an $80 million Series C, while Zenith Bank launched a card on ${written(EVENT)}`
  const b = await lead(other, `${other}.`, PUB)
  assert.equal(b.event_date, null, JSON.stringify(b)); assert.equal(b.review_reason, 'outside_window_undated')
})

test('fail closed: a quote whose only day is background, another event, a plan or a deadline gives no day (council review)', () => {
  const day = (q: string) => dayStatedForEvent(`${q}.`, q, 'Kestrel Pay')?.day ?? null
  const Y = EVENT.slice(0, 4)
  // the event's own day is refused for naming an older year, so the founding day would be the only bound one
  assert.equal(day(`Kestrel Pay, founded on March 3, 2020, announced an $80 million Series C on ${written(EVENT)}`), null)
  assert.equal(day('Kestrel Pay, founded on March 3, 2020, announced an $80 million Series C'), null)
  assert.equal(day(`Kestrel Pay raised $80 million, up from the $20 million it raised on ${written(daysAgo(40))}`), null)
  assert.equal(day(`Kestrel Pay raised $80 million, twice the round it closed on ${written(daysAgo(40))} last year`), null)
  assert.equal(day(`Kestrel Pay closed its Series C on ${written(EVENT)}, its first round since 2024`), null)
  // another event of the SAME company: the day is the CFO hire's, not the round's; the round's, not the hiring's; a start day
  assert.equal(day(`Kestrel Pay hired a new CFO on ${written(EVENT)}, months after it raised an $80 million Series C`), null)
  assert.equal(day(`Kestrel Pay is hiring three Account Executives after closing a Series C on ${written(EVENT)}`), null)
  assert.equal(day(`Kestrel Pay is hiring an Account Executive to start on ${written(EVENT)}`), null)
  // a plan or a deadline is not the day something happened
  assert.equal(day(`Kestrel Pay will close its Series C on ${written(daysAgo(-20))}, a round led by Acme Capital`), null)
  assert.equal(day(`Kestrel Pay is hiring a CFO in Berlin, apply before ${written(EVENT)}`), null)
  // a day plus an ambiguous numeric day: the quote does not settle which is the event's
  assert.equal(day(`Kestrel Pay closed its Series C on ${written(EVENT)} (filed 04/11/${Y})`), null)
  // the quote names the event's year and states only ANOTHER event's day (one year back, which the binder's older-year rule lets through)
  assert.equal(day(`Kestrel Pay raised its ${Y} Series C, matching the seed it raised on ${written(`${+Y - 1}-03-03`)}`), null)
})

test('two different days in the quote, both bound: neither is chosen', () => {
  const q = `Kestrel Pay signed the term sheet on ${written(daysAgo(20))} and closed its Series C on ${written(EVENT)}`
  assert.equal(dayStatedForEvent(`${q}.`, q, 'Kestrel Pay'), null)
  const one = `Kestrel Pay closed its Series C on ${written(EVENT)}`
  assert.deepEqual(dayStatedForEvent(`${one}.`, one, 'Kestrel Pay')?.day, EVENT)
})

test('through the runner: a funding lead whose quote dates another event of the company stays undated and held', async () => {
  const q = `Kestrel Pay hired a new CFO on ${written(EVENT)}, months after it raised an $80 million Series C`
  const r = await lead(q, `${q}.`, null)
  assert.equal(r.event_date, null, JSON.stringify(r)); assert.equal(r.review_reason, 'outside_window_undated')
})

test('a hiring lead is dated by the job board only, never by a day in its text', async () => {
  const q = `Kestrel Pay posted a Head of Finance role in Berlin on ${written(EVENT)}`
  const r = await lead(q, `${q}.`, null, 'hiring a Head of Finance')
  assert.equal(r.event_date, null, JSON.stringify(r))
})

test('a claimed day the date rules reject (stale) keeps its hold: the quote\'s day never replaces it', async () => {
  const q = `Kestrel Pay announced an $80 million Series C on ${written(EVENT)}`
  const r = await lead(q, `${q}.`, '2019-03-01')
  assert.equal(r.event_date, '2019-03-01', JSON.stringify(r))
  assert.equal(r.review_reason, 'event_date_stale')
})

test('a quote day older than the window is still judged by the window: held, never passed', async () => {
  const old = daysAgo(200)
  const q = `Kestrel Pay announced an $80 million Series C on ${written(old)}`
  const r = await lead(q, `Published ${written(PUB)}. ${q}.`, PUB)
  assert.equal(r.event_date === null || r.event_date === old, true, JSON.stringify(r))
  assert.notEqual(r.review_reason, null, 'out of the 90-day window: held')
})
