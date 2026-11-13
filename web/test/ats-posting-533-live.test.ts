// #533 live check FAIL on staging at 1e250f76 (Hermes-PC, issue comment 6841835996): the exact strings the live model and
// boards produced. (1) A board posting worded "Posted a <role> role on Ashby/Lever" was not counted as hiring, so the
// board's day never dated it. (2) The candidate quote was cut from the posting PAGE's header ("<title> Location <x>
// Employment Type Full time"), which the record text did not carry. (3) Left undated, a Sydney postcode ("NSW 2000") in the
// quote read as the year 2000 and held the lead as stale. Postings are rebuilt from the live fields; the descriptions are
// synthetic. The socket is faked (no network).
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import { fetchPageDetailed, isFail, resetBoardMemo, type Page } from '../lib/scan/fetch-page.ts'
import { verifyLeads, type LeadDraft } from '../lib/scan/runner.ts'
import { isHiringTrigger } from '../lib/scan/scoreboard.ts'

const NOW = new Date('2026-11-12T18:00:00Z')
const TEKION_ID = 'b1f00000-0000-4000-8000-0000000000c1', MACQ_ID = 'c2e00000-0000-4000-8000-0000000000d2'
// (the live Lever board slug was not captured; a hyphenated slug is used here, see the identity note in the last test)
const TEKION_URL = `https://jobs.ashbyhq.com/tekion/${TEKION_ID}`, MACQ_URL = `https://jobs.lever.co/macquarie-technology-group/${MACQ_ID}`
// the live signals and quotes, verbatim
const TEKION_SIGNAL = 'Posted a Sales Operations Manager - Deal Desk role on Ashby'
const MACQ_SIGNAL = 'Posted a Sales Operations Manager role on Lever'
const TEKION_QUOTE = 'Sales Operations Manager - Deal Desk Location Virtual - California (Bay Area) Employment Type Full time'
const MACQ_QUOTE = 'Sales Operations Manager Sydney, NSW 2000 / Melbourne, VIC 3000 Government – Sales / Hybrid Apply for this job'
// the boards' records with the live fields (Ashby publishedAt 2026-11-11T18:56:50Z, Lever createdAt 1793071124902)
const TEKION_BOARD = { jobs: [{ id: TEKION_ID, title: 'Sales Operations Manager - Deal Desk', location: 'Virtual - California (Bay Area)', employmentType: 'FullTime', department: 'Sales', isListed: true, publishedAt: '2026-11-11T18:56:50.000+00:00', jobUrl: TEKION_URL, descriptionPlain: 'Tekion is hiring a Sales Operations Manager for the Deal Desk to run quoting and approvals.' }] }
const MACQ_POSTING = { id: MACQ_ID, text: 'Sales Operations Manager', createdAt: 1793071124902, workplaceType: 'hybrid', categories: { location: 'Sydney, NSW 2000', allLocations: ['Sydney, NSW 2000', 'Melbourne, VIC 3000'], department: 'Government', team: 'Sales' }, descriptionPlain: 'Macquarie Technology Group is hiring a Sales Operations Manager for its Government team.' }

function fakeHttps(serve: (url: string) => { status: number; type: string; body: string }) {
  const real = https.request
  resetBoardMemo()
  ;(https as { request: unknown }).request = (url: URL, _o: unknown, cb: (res: EventEmitter) => void) => {
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void }
    req.destroy = () => {}
    req.end = () => { const r = serve(String(url)); const res = Object.assign(new EventEmitter(), { statusCode: r.status, headers: { 'content-type': r.type }, resume() {}, destroy() {} }); cb(res); res.emit('data', Buffer.from(r.body)); res.emit('end') }
    return req
  }
  return () => { (https as { request: unknown }).request = real }
}
const boards = (u: string) => u.startsWith('https://api.ashbyhq.com/posting-api/job-board/tekion') ? { status: 200, type: 'application/json', body: JSON.stringify(TEKION_BOARD) }
  : /^https:\/\/api\.lever\.co\/v0\/postings\/[a-z-]+\//.test(u) && u.includes(MACQ_ID) ? { status: 200, type: 'application/json', body: JSON.stringify(MACQ_POSTING) }
  : { status: 403, type: 'text/html', body: '' }
const draft = (o: Partial<LeadDraft>) => ({ name: '', contact: null, event_date: null, score: 80, ...o }) as LeadDraft
const read = (u: string) => fetchPageDetailed(u, async () => null)

test('#533 live 1: "Posted a <role> role on Ashby/Lever" is hiring wording; a posted anything-else is not', () => {
  assert.equal(isHiringTrigger(TEKION_SIGNAL, null), true)
  assert.equal(isHiringTrigger(MACQ_SIGNAL, null), true)
  assert.equal(isHiringTrigger('Posted an Account Executive job on Greenhouse', null), true)
  for (const no of ['Posted record revenue for Q3', 'Posted a Series A announcement', 'Posted a blog about its new office', 'Raised a Series A round']) assert.equal(isHiringTrigger(no, null), false, no)
})

test('#533 live 2: the record text carries the posting page header in page order, so a header quote is found', async () => {
  const restore = fakeHttps(boards)
  try {
    const t = await read(`${TEKION_URL}?action=apply`); assert.ok(!isFail(t), JSON.stringify(t))
    assert.ok((t as Page).text.startsWith(`${TEKION_QUOTE} Department Sales Tekion is hiring`), (t as Page).text)
    const m = await read(MACQ_URL); assert.ok(!isFail(m), JSON.stringify(m))
    assert.ok((m as Page).text.startsWith(`${MACQ_QUOTE} Macquarie Technology Group is hiring`), (m as Page).text)
  } finally { restore() }
})

test('#533 live 1+2+3 through the verifier: both requested-role postings are verified, dated by the board, never "quote unconfirmed" or stale', async () => {
  const restore = fakeHttps(boards)
  try {
    const o = await verifyLeads([
      draft({ company: 'Tekion', signal: TEKION_SIGNAL, source_url: TEKION_URL, excerpt: TEKION_QUOTE }),
      draft({ company: 'Macquarie Technology Group', signal: MACQ_SIGNAL, source_url: MACQ_URL, excerpt: MACQ_QUOTE }),
    ], read, NOW)
    assert.deepEqual(o.review.map(r => [r.company, r.review_reason]), [], 'nothing held: not quote_unconfirmed, not event_date_stale')
    assert.deepEqual(o.leads.map(l => [l.company, l.event_date, l.event_date_proof]).sort(), [['Macquarie Technology Group', '2026-10-27', 'ats_structured'], ['Tekion', '2026-11-11', 'ats_structured']])
    // a funding claim cited to the same posting still takes no date from it
    const f = await verifyLeads([draft({ company: 'Tekion', signal: 'Raised a Series B round', source_url: TEKION_URL, excerpt: TEKION_QUOTE })], read, NOW)
    assert.ok([...f.leads, ...f.review].every(l => l.event_date_proof !== 'ats_structured'), JSON.stringify(f))
    // Identity is a separate open issue (#1126): a quote that never names the company, on a board whose slug is the name
    // glued together, is still dropped as entity_mismatch (never stale, never quote_unconfirmed)
    const glued = await verifyLeads([draft({ company: 'Macquarie Technology Group', signal: MACQ_SIGNAL, source_url: `https://jobs.lever.co/macquarietechnologygroup/${MACQ_ID}`, excerpt: MACQ_QUOTE })], read, NOW)
    assert.deepEqual([glued.leads.length, glued.review.length, glued.dropped], [0, 0, { entity_mismatch: 1 }])
  } finally { restore() }
})
