// #533 live check FAIL on staging at 4a6c4d7d (Hermes-PC, after PR #1128): the exact signals and quote the live model wrote.
// (1) "Revenue" and "Post" were stop words, so "Posted a Senior Revenue Operations Manager (Sales Ops) job on Ashby" and
// "Posted a Post-Sales Operations Manager job on Ashby" were not hiring wording and the board's day never dated them.
// (2) The live quote is cut the way a search snippet writes the header ("Title. Location. New York City. ...") and elides with
// "...": it was quote_unconfirmed although every word is on the board record. Postings rebuilt from the live fields; the
// descriptions are synthetic. The socket is faked (no network).
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import { fetchPageDetailed, resetBoardMemo } from '../lib/scan/fetch-page.ts'
import { verifyLeads, type LeadDraft } from '../lib/scan/runner.ts'
import { isHiringTrigger } from '../lib/scan/scoreboard.ts'

const NOW = new Date('2026-11-13T12:00:00Z')
const ROGO_ID = 'a8715a30-0000-4000-8000-0000000000e3', VOIZE_ID = '6514089f-0000-4000-8000-0000000000f4'
const ROGO_URL = `https://jobs.ashbyhq.com/rogo/${ROGO_ID}`, VOIZE_URL = `https://jobs.ashbyhq.com/voize/${VOIZE_ID}`
const ROGO_SIGNAL = 'Posted a Post-Sales Operations Manager job on Ashby'
const VOIZE_SIGNAL = 'Posted a Senior Revenue Operations Manager (Sales Ops) job on Ashby'
const ROGO_QUOTE = 'Post-Sales Operations Manager. Location. New York City. Employment Type. Full ... 4–6 years of experience in B2B SaaS or Fintech, with 3+ years in Customer'
const ROGO_BOARD = { jobs: [{ id: ROGO_ID, title: 'Post-Sales Operations Manager', location: 'New York City', employmentType: 'FullTime', workplaceType: 'OnSite', department: 'GTM', isListed: true, publishedAt: '2026-10-19T21:18:00.000+00:00', jobUrl: ROGO_URL, descriptionPlain: 'Rogo is hiring a Post-Sales Operations Manager. You have 4–6 years of experience in B2B SaaS or Fintech, with 3+ years in Customer Success or Sales Operations.' }] }
const VOIZE_BOARD = { jobs: [{ id: VOIZE_ID, title: 'Senior Revenue Operations Manager (m/f/d) - Sales Ops & Strategy', location: 'Berlin', employmentType: 'FullTime', department: 'Revenue', isListed: true, publishedAt: '2026-10-15T14:33:00.000+00:00', jobUrl: VOIZE_URL, descriptionPlain: 'voize is hiring a Senior Revenue Operations Manager to own sales ops and strategy across the revenue team.' }] }

function fakeHttps() {
  const real = https.request
  resetBoardMemo()
  ;(https as { request: unknown }).request = (url: URL, _o: unknown, cb: (res: EventEmitter) => void) => {
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void }
    req.destroy = () => {}
    req.end = () => {
      const u = String(url)
      const body = u.startsWith('https://api.ashbyhq.com/posting-api/job-board/rogo') ? JSON.stringify(ROGO_BOARD) : u.startsWith('https://api.ashbyhq.com/posting-api/job-board/voize') ? JSON.stringify(VOIZE_BOARD) : null
      const res = Object.assign(new EventEmitter(), { statusCode: body ? 200 : 403, headers: { 'content-type': body ? 'application/json' : 'text/html' }, resume() {}, destroy() {} })
      cb(res); res.emit('data', Buffer.from(body ?? '')); res.emit('end')
    }
    return req
  }
  return () => { (https as { request: unknown }).request = real }
}
const draft = (o: Partial<LeadDraft>) => ({ name: '', contact: null, event_date: null, score: 80, ...o }) as LeadDraft
const read = (u: string) => fetchPageDetailed(u, async () => null)

test('#533 r3 (1): job titles with Revenue / Post / Release / Press / Video / Story / Record / Note / Update / Paper / of / in / for are hiring wording', () => {
  for (const yes of [ROGO_SIGNAL, VOIZE_SIGNAL, 'Posted a Senior Revenue Operations Manager job on Ashby', 'Posted a Release Manager role on Lever', 'Posted a Press Officer role on Greenhouse',
    'Posted a Video Producer job on Lever', 'Posted a Story Editor role on Ashby', 'Posted a Medical Record Coordinator job on Lever', 'Posted a Head of Sales Operations role on Ashby',
    'Posted a Director of Revenue Operations job on Greenhouse', 'Posted a Paper Sales Rep role on Lever', 'Posted an Account Executive in Sales role on Lever', 'Posted a VP for Sales role on Ashby'])
    assert.equal(isHiringTrigger(yes, null), true, yes)
  // still never: a non-hire state, a sentence break, no board, or another stored kind
  for (const no of ['Posted a press release about the new CRO role', 'Posted a hiring freeze position on Lever', 'Posted a filled Sales Ops role on Lever', 'Posted a VP Sales. Announced bankruptcy. Sales role on Lever', 'Posted a Revenue Operations Manager role', 'Posted a record quarter, strengthening its market position', 'Posted a layoff notice affecting the sales ops role', 'Posted a farewell note about leaving her role on Lever'])
    assert.equal(isHiringTrigger(no, null), false, no)
  assert.equal(isHiringTrigger(VOIZE_SIGNAL, 'funding'), false)
})

test('#533 r3 (1+2) through the verifier: both live Ashby postings are dated by the board, the snippet-style header quote is found', async () => {
  const restore = fakeHttps()
  try {
    const o = await verifyLeads([
      draft({ company: 'Rogo', signal: ROGO_SIGNAL, source_url: ROGO_URL, excerpt: ROGO_QUOTE }),
      draft({ company: 'voize', signal: VOIZE_SIGNAL, source_url: `${VOIZE_URL}?action=apply`, excerpt: 'Senior Revenue Operations Manager (m/f/d) - Sales Ops & Strategy. Location. Berlin' }),
    ], read, NOW)
    assert.deepEqual(o.review.map(r => [r.company, r.review_reason]), [], 'nothing held')
    assert.deepEqual(o.leads.map(l => [l.company, l.event_date, l.event_date_proof]).sort(), [['Rogo', '2026-10-19', 'ats_structured'], ['voize', '2026-10-15', 'ats_structured']])
  } finally { restore() }
})

test('#533 r3 (2): the loose header match is in order, every segment long enough, and only on a board record', async () => {
  const restore = fakeHttps()
  try {
    for (const excerpt of [
      '4–6 years of experience in B2B SaaS or Fintech ... Post-Sales Operations Manager. Location. New York City', // out of order
      'Post-Sales Operations Manager. Location. New York City ... Fintech', // a segment too short to count
      'Post-Sales Operations Manager. Location. Boston. Employment Type. Full time', // words not on the record
    ]) {
      const o = await verifyLeads([draft({ company: 'Rogo', signal: ROGO_SIGNAL, source_url: ROGO_URL, excerpt })], read, NOW)
      assert.equal(o.leads.length, 0, excerpt)
    }
  } finally { restore() }
})
