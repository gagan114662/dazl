// #533 live check FAIL on staging at 4a6c4d7d (Hermes-PC, issue comment 6851100450, job ed3af87d32892dfd6a085217).
// Request: "B2B SaaS companies hiring a sales operations manager in the last 30 days (job posts on Greenhouse, Lever or
// Ashby)". Both candidates were requested-role Ashby postings, read through the board's own API record, and neither got
// the board's day:
//   Rogo  - signal "Posted a Post-Sales Operations Manager job on Ashby", quote cut the way search snippets write the page
//           header ("Post-Sales Operations Manager. Location. New York City. Employment Type. Full ... 4–6 years ..."):
//           event_date NULL, review_reason quote_unconfirmed.
//   voize - signal "Posted a Senior Revenue Operations Manager (Sales Ops) job on Ashby": event_date NULL, undated,
//           review_reason outside_window_undated.
// Cause 1: the posted-role wording rule decided from the model's free wording with a stop list that holds real title words
// ("revenue", "post"). The posting is bound by the board instead: the source URL is the posting record whose title the
// board returned, and every word of the title the signal names is in that board title.
// Cause 2: on a board record, a header quote with the snippet's ". " between fields, or an inner "..." gap, was not found.
// Signals, quotes, titles, slugs and published days (shifted to stay inside the window) are the live ones; the descriptions
// are rebuilt from the live quote. The whole scan runs through runJob into the SQLite store; only the socket is faked.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import { fetchPageDetailed, resetBoardMemo, type Page } from '../lib/scan/fetch-page.ts'
import { verifyEvidence } from '../lib/scan/evidence.ts'
import { verifyLeads, type LeadDraft } from '../lib/scan/runner.ts'
import { eventDayVerified, isHiringTrigger } from '../lib/scan/scoreboard.ts'

const REQUEST = 'B2B SaaS companies hiring a sales operations manager in the last 30 days (job posts on Greenhouse, Lever or Ashby)'
const ICP = { summary: 'B2B SaaS companies hiring a sales operations manager', who: ['VP Sales'], industries: ['B2B SaaS'], sizes: [], where: [], signals: ['hiring a sales operations manager'], exclude: [], country: 'US', language: 'en' }
const ROGO_ID = 'a8715a30-0000-4000-8000-000000000533', VOIZE_ID = '6514089f-0000-4000-8000-000000000533'
const ROGO_URL = `https://jobs.ashbyhq.com/rogo/${ROGO_ID}`, VOIZE_URL = `https://jobs.ashbyhq.com/voize/${VOIZE_ID}?action=apply`
// the live signals and quotes, verbatim
const ROGO_SIGNAL = 'Posted a Post-Sales Operations Manager job on Ashby'
const VOIZE_SIGNAL = 'Posted a Senior Revenue Operations Manager (Sales Ops) job on Ashby'
const ROGO_QUOTE = 'Post-Sales Operations Manager. Location. New York City. Employment Type. Full ... 4–6 years of experience in B2B SaaS or Fintech, with 3+ years in Customer'
const VOIZE_QUOTE = 'Senior Revenue Operations Manager (m/f/d) - Sales Ops & Strategy. Location. Berlin. Employment Type. Full time'
const ROGO_DAY = daysAgo(12), VOIZE_DAY = daysAgo(16)
const ROGO_BOARD = { jobs: [{ id: ROGO_ID, title: 'Post-Sales Operations Manager', location: 'New York City', employmentType: 'FullTime', workplaceType: 'OnSite', department: 'GTM', isListed: true, publishedAt: `${ROGO_DAY}T21:18:00.000+00:00`, jobUrl: ROGO_URL, descriptionPlain: 'Rogo is hiring a Post-Sales Operations Manager to run onboarding and renewals operations. 4–6 years of experience in B2B SaaS or Fintech, with 3+ years in Customer Success or Revenue Operations.' }] }
const VOIZE_BOARD = { jobs: [{ id: VOIZE_ID, title: 'Senior Revenue Operations Manager (m/f/d) - Sales Ops & Strategy', location: 'Berlin', employmentType: 'FullTime', department: 'Revenue', isListed: true, publishedAt: `${VOIZE_DAY}T14:33:00.000+00:00`, jobUrl: VOIZE_URL.split('?')[0], descriptionPlain: 'voize is hiring a Senior Revenue Operations Manager to own Sales Ops and Strategy across its B2B SaaS sales team.' }] }

function fakeHttps(boards: Record<string, unknown>) {
  const real = https.request
  resetBoardMemo()
  ;(https as { request: unknown }).request = (url: URL, _o: unknown, cb: (res: EventEmitter) => void) => {
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void }
    req.destroy = () => {}
    req.end = () => {
      const u = String(url), slug = Object.keys(boards).find(s => u.startsWith(`https://api.ashbyhq.com/posting-api/job-board/${s}`))
      const body = slug ? JSON.stringify(boards[slug]) : ''
      const res = Object.assign(new EventEmitter(), { statusCode: slug ? 200 : 403, headers: { 'content-type': slug ? 'application/json' : 'text/html' }, resume() {}, destroy() {} })
      cb(res); res.emit('data', Buffer.from(body)); res.emit('end')
    }
    return req
  }
  return () => { (https as { request: unknown }).request = real }
}
const read = (u: string) => fetchPageDetailed(u, async () => null)
const fixture = (cands: { company: string; signal: string; url: string; quote: string }[]): Fixture => ({
  request: REQUEST, modelIcp: ICP, reviewedIcp: ICP, icpReviewed: true, modelQueries: ['sales operations manager jobs.ashbyhq.com'],
  hits: cands.map(c => ({ url: c.url, title: `${c.company} job`, snippet: c.quote, date: null })),
  tfPages: {}, own: {},
  extraction: cands.map(c => ({ company: c.company, signal: c.signal, source_url: c.url, excerpt: c.quote, event_date: null })),
  deps: { fetchPage: read },
})
type Row = { company: string; signal: string; signal_kind: string | null; event_date: string | null; event_date_proof: string | null; review_reason: string | null }
const rows = (db: import('better-sqlite3').Database) => db.prepare('SELECT company, signal, signal_kind, event_date, event_date_proof, review_reason FROM leads ORDER BY company').all() as Row[]

test('#533 live (4a6c4d7d): Rogo and voize board postings are dated by the board through the whole scan, and the stored day counts as verified', async () => {
  const restore = fakeHttps({ rogo: ROGO_BOARD, voize: VOIZE_BOARD })
  try {
    const x = await runFixture(fixture([
      { company: 'Rogo', signal: ROGO_SIGNAL, url: ROGO_URL, quote: ROGO_QUOTE },
      { company: 'voize', signal: VOIZE_SIGNAL, url: VOIZE_URL, quote: VOIZE_QUOTE },
    ]))
    const got = rows(x.db)
    assert.deepEqual(got.map(r => r.company), ['Rogo', 'voize'], JSON.stringify(got))
    for (const r of got) {
      assert.ok(!['quote_unconfirmed', 'outside_window_undated', 'event_date_stale'].includes(r.review_reason ?? ''), `${r.company}: ${JSON.stringify(r)}`)
      assert.equal(r.event_date_proof, 'ats_structured', `${r.company}: ${JSON.stringify(r)}`)
      assert.equal(r.event_date, r.company === 'Rogo' ? ROGO_DAY : VOIZE_DAY, `${r.company}: ${JSON.stringify(r)}`)
      // the stored row (signal + signal_kind as the store keeps them) is what every reader judges the day on
      assert.equal(eventDayVerified(r), true, `${r.company}: stored day not verified ${JSON.stringify(r)}`)
    }
  } finally { restore() }
})

const draft = (o: Partial<LeadDraft>) => ({ name: '', contact: null, event_date: null, score: 80, ...o }) as LeadDraft

test('#533 live: the posting is bound by the board title, not by the free wording; anything else cited to the posting takes no board day', async () => {
  const restore = fakeHttps({ rogo: ROGO_BOARD, voize: VOIZE_BOARD })
  const NOW = new Date()
  try {
    const plainQuote = 'voize is hiring a Senior Revenue Operations Manager to own Sales Ops and Strategy'
    for (const [signal, dated] of [
      [VOIZE_SIGNAL, true],
      ['Posted a Senior Revenue Operations Manager job on Ashby', true],
      ['Posted a Revenue Operations Manager role on Ashby', true],
      // a title the board does not give this posting ("revenue" stays refused by the wording rule), a sentence about
      // something else, another board, a non-hire state
      ['Posted a Senior Revenue Account Director job on Ashby', false],
      ['Posted a press release about the revenue operations role on Ashby', false],
      ['Posted a Senior Revenue Operations Manager job on Lever', false],
      ['Posted a Senior Revenue Operations Manager (filled) job on Ashby', false],
      ['Raised a Series B round', false],
    ] as const) {
      const o = await verifyLeads([draft({ company: 'voize', signal, source_url: VOIZE_URL, excerpt: plainQuote })], read, NOW)
      const proofs = [...o.leads, ...o.review].map(l => l.event_date_proof ?? null)
      assert.deepEqual(proofs.includes('ats_structured'), dated, `${signal}: ${JSON.stringify(o)}`)
    }
    // a stored non-hiring kind still wins over the board, as it does over the wording
    const funding = await verifyLeads([draft({ company: 'voize', signal: VOIZE_SIGNAL, source_url: VOIZE_URL, excerpt: plainQuote, signal_kind: 'funding' } as Partial<LeadDraft>)], read, NOW)
    assert.ok([...funding.leads, ...funding.review].every(l => l.event_date_proof !== 'ats_structured'), JSON.stringify(funding))
    // the free-wording rule itself is unchanged: without the board record these stay non-hiring (no loosened word list)
    for (const s of ['Posted a press release about the revenue operations role on Ashby', 'Posted a record quarter, strengthening its market position']) assert.equal(isHiringTrigger(s, null), false, s)
  } finally { restore() }
})

test('#533 live: on a board record a snippet-punctuated header quote and an inner "..." gap are found; every piece must still be there, in order', async () => {
  const restore = fakeHttps({ rogo: ROGO_BOARD })
  try {
    const page = await read(ROGO_URL) as Page
    const v = (excerpt: string, p: Page = page) => verifyEvidence({ company: 'Rogo', signal: ROGO_SIGNAL, source_url: ROGO_URL, excerpt, event_date: null } as never, p)
    // the live quotes (Hermes-PC probe at 4a6c4d7d): both used to be quote_unconfirmed
    assert.equal(v(ROGO_QUOTE).ok, true, JSON.stringify(v(ROGO_QUOTE)))
    assert.equal(v('Post-Sales Operations Manager. Location. New York City. Employment Type. Full time').ok, true)
    // pieces out of order, a piece the record does not have, or a piece too short to count: still not on the page
    for (const no of [
      '4–6 years of experience in B2B SaaS or Fintech ... Post-Sales Operations Manager. Location. New York City',
      'Post-Sales Operations Manager. Location. New York City ... 10+ years of experience leading a global sales team',
      'Post-Sales Operations Manager. Location. New York City ... Fintech',
      'Post-Sales Operations Manager. Location. Boston. Employment Type. Full time',
    ]) assert.equal((v(no) as { reason?: string }).reason, 'excerpt_not_on_page', no)
    // an ordinary page (no board record) keeps the strict rule: an inner gap still fails
    const plain: Page = { text: page.text, title: page.title, retrievedAt: page.retrievedAt }
    assert.equal((v(ROGO_QUOTE, plain) as { reason?: string }).reason, 'excerpt_not_on_page')
    // ...and so does a held copy of the posting page (board identity from the URL, not the board's API record)
    const copy: Page = { ...plain, board: { title: page.title, company: null, slug: 'rogo' } }
    assert.equal((v(ROGO_QUOTE, copy) as { reason?: string }).reason, 'excerpt_not_on_page')
    // more than four pieces is not a quote
    const five = 'Post-Sales Operations Manager. Location ... New York City. Employment Type ... Full time Location Type On-site ... Department GTM Rogo is hiring ... a Post-Sales Operations Manager to run'
    assert.equal((v(five) as { reason?: string }).reason, 'excerpt_not_on_page')
  } finally { restore() }
})

test('#533 review: a gapped board quote hands the judge only the words around each piece, never the record text between them', async () => {
  const filler = 'Unquoted record text about benefits and perks. '.repeat(2000)
  const board = { jobs: [{ ...ROGO_BOARD.jobs[0], descriptionPlain: `Post-Sales Operations Manager for the onboarding team. ${filler} Full time role based in New York City with renewals scope.` }] }
  const restore = fakeHttps({ rogo: board })
  try {
    const read1 = await read(ROGO_URL) as Page
    // the board states its employer name (as a Greenhouse record does), so the judge is given the matched quote
    const page: Page = { ...read1, board: { ...read1.board!, company: 'Rogo' } }
    // the quote does not name the company, so the board's identity binds it and the judge gets a matched quote
    const r = verifyEvidence({ company: 'Rogo', signal: ROGO_SIGNAL, source_url: ROGO_URL, excerpt: 'Post-Sales Operations Manager for the onboarding team ... Full time role based in New York City', event_date: null } as never, page)
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300))
    const ok = r as { passage: string; judgeAttribution?: { matchedQuote: string } }
    assert.ok(ok.passage.length < 4000, `passage ${ok.passage.length} chars`)
    assert.equal(ok.judgeAttribution?.matchedQuote, 'post sales operations manager for the onboarding team ... full time role based in new york city')
  } finally { restore() }
})
