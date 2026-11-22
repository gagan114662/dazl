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
import Database from 'better-sqlite3'
import { verifyEvidence } from '../lib/scan/evidence.ts'
import { evidenceRecheck } from '../lib/scan/evidence-recheck.ts'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { signalNamesBoardPosting } from '../lib/sources/ats-posting.ts'
import { verifyLeads, type LeadDraft } from '../lib/scan/runner.ts'
import { eventDayVerified, isHiringTrigger } from '../lib/scan/scoreboard.ts'
import { planObject } from './helpers/request-plan-stub.ts'

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
// #1395 SYNTHETIC request plan: REQUEST (and its revenue-operations variant) writes no place, so the profile place is used.
const PLAN = planObject([], { buyer_type: 'B2B SaaS companies', signals: [{ kind: 'hiring', text: 'hiring a sales operations manager', negated: false }] })
const fixture = (cands: { company: string; signal: string; url: string; quote: string }[]): Fixture => ({
  request: REQUEST, modelPlan: PLAN, modelIcp: ICP, reviewedIcp: ICP, icpReviewed: true, modelQueries: ['sales operations manager jobs.ashbyhq.com'],
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

// AC1 + AC3 on the same live postings: for the sales operations manager request neither title is the requested role (the synonym
// set is bounded: "Post-Sales Operations" and "Revenue Operations" are not "Sales Operations"), so both are held as hiring without the
// requested role - now dated by the board, never role-qualified. For a revenue operations manager request, voize's posting IS the
// requested role: before this fix "revenue" kept it undated, so it could never reach the screen.
test('#533 live: a revenue operations manager request puts voize on screen with its requested-role posting and board day; Rogo stays held', async () => {
  const restore = fakeHttps({ rogo: ROGO_BOARD, voize: VOIZE_BOARD })
  try {
    const revops = { ...ICP, summary: 'B2B SaaS companies hiring a revenue operations manager', signals: ['hiring a revenue operations manager'] }
    const x = await runFixture({ ...fixture([
      { company: 'Rogo', signal: ROGO_SIGNAL, url: ROGO_URL, quote: ROGO_QUOTE },
      { company: 'voize', signal: VOIZE_SIGNAL, url: VOIZE_URL, quote: VOIZE_QUOTE },
    ]), request: REQUEST.replace('sales operations manager', 'revenue operations manager'), modelIcp: revops, reviewedIcp: revops })
    const got = rows(x.db)
    assert.deepEqual(got.map(r => [r.company, r.review_reason, r.event_date, r.event_date_proof]), [['Rogo', 'no_sales_hiring_evidence', ROGO_DAY, 'ats_structured'], ['voize', null, VOIZE_DAY, 'ats_structured']], JSON.stringify(got))
    const e = x.db.prepare("SELECT e.value, e.label, e.source_url, e.source_date FROM lead_enrichments e JOIN leads l ON l.id = e.lead_id WHERE l.company = 'voize' AND e.kind = 'hiring'").all() as { value: string; label: string; source_url: string; source_date: string }[]
    assert.equal(e.length, 1, JSON.stringify(e))
    assert.match(e[0].value, new RegExp(`Senior Revenue Operations Manager \\(m/f/d\\) - Sales Ops & Strategy - posted ${VOIZE_DAY}`))
    assert.match(e[0].label, /^Requested role: revenue operations manager/)
    assert.equal(e[0].source_date, VOIZE_DAY)
  } finally { restore() }
})

test('#533 live (AC3): for the sales operations manager request both live titles are held as hiring without the requested role, dated by the board', async () => {
  const restore = fakeHttps({ rogo: ROGO_BOARD, voize: VOIZE_BOARD })
  try {
    const x = await runFixture(fixture([
      { company: 'Rogo', signal: ROGO_SIGNAL, url: ROGO_URL, quote: ROGO_QUOTE },
      { company: 'voize', signal: VOIZE_SIGNAL, url: VOIZE_URL, quote: VOIZE_QUOTE },
    ]))
    assert.deepEqual(rows(x.db).map(r => [r.company, r.review_reason, r.event_date]), [['Rogo', 'no_sales_hiring_evidence', ROGO_DAY], ['voize', 'no_sales_hiring_evidence', VOIZE_DAY]])
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

test('#533 review: a gapped board quote hands the judge only the words around each piece, never the whole record between them', async () => {
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

test('#533 review: a board-bound posting held after it is dated keeps its hiring kind on the stored row', async () => {
  const restore = fakeHttps({ rogo: ROGO_BOARD })
  try {
    // the play asks for Boston; the Rogo record says New York City, so the dated posting is held for its place
    const boston = { ...ICP, where: ['Boston'] }
    const x = await runFixture({ ...fixture([{ company: 'Rogo', signal: ROGO_SIGNAL, url: ROGO_URL, quote: ROGO_QUOTE }]), modelIcp: boston, reviewedIcp: boston })
    const [r] = rows(x.db)
    assert.ok(r && r.review_reason, `held: ${JSON.stringify(r)}`)
    assert.deepEqual([r.event_date, r.event_date_proof, r.signal_kind], [ROGO_DAY, 'ats_structured', 'hiring'], JSON.stringify(r))
    assert.equal(isHiringTrigger(r.signal, r.signal_kind), true)
  } finally { restore() }
})

test('#533 review: the evidence recheck dates a stored board-bound posting by the board, as the verifier does', async () => {
  const db = new Database(':memory:'); migrateScan(db)
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,sells TEXT,website TEXT)'); db.prepare('INSERT INTO users VALUES(?,?,?)').run('u', 'Revenue operations software', '')
  const j = createQueryJob(db, 'u', { query: REQUEST })
  db.prepare("UPDATE scan_jobs SET status='running',offer=?,icp=? WHERE id=?").run('Revenue operations software', JSON.stringify({ ...ICP, window_days: 30 }), j)
  const quote = 'voize is hiring a Senior Revenue Operations Manager to own Sales Ops and Strategy'
  // a row stored before this fix (signal_kind NULL), the same posting worded with a title the board does not give, and a stored non-hiring kind
  const cases: [string, string | null, boolean][] = [[VOIZE_SIGNAL, null, true], ['Posted a Senior Revenue Account Director job on Ashby', null, false], [VOIZE_SIGNAL, 'funding', false]]
  const ids = cases.map(([signal, kind], i) => { const id = String(i + 1).padStart(24, '0'); db.prepare('INSERT INTO leads(id,scan_job_id,company,signal,signal_kind,source_url,evidence_excerpt,event_date,review_reason) VALUES(?,?,?,?,?,?,?,?,?)').run(id, j, 'voize', signal, kind, VOIZE_URL, quote, VOIZE_DAY, 'blocked_by_site'); return id })
  const restore = fakeHttps({ voize: VOIZE_BOARD })
  try {
    for (const [i, id] of ids.entries()) {
      const p = await evidenceRecheck(db, 'u', id, undefined, new Date())
      const c = p?.checks as { event_date_bound: boolean; event_date_proof?: string | null } | null
      assert.deepEqual([c?.event_date_bound, c?.event_date_proof ?? null], cases[i][2] ? [true, 'ats_structured'] : [false, null], `${cases[i][0]} (${cases[i][1]}): ${JSON.stringify(p)}`)
    }
  } finally { restore() }
})

test('#533 review: the board binding needs a board title, the named board and a title; an inner "…" is a gap like "..."', async () => {
  assert.equal(signalNamesBoardPosting(VOIZE_SIGNAL, VOIZE_URL, 'Senior Revenue Operations Manager (m/f/d) - Sales Ops & Strategy'), true)
  for (const [s, u, t] of [[VOIZE_SIGNAL, VOIZE_URL, ''], [VOIZE_SIGNAL, VOIZE_URL, null], [VOIZE_SIGNAL, 'https://voize.example/careers/revops', 'Senior Revenue Operations Manager (Sales Ops)'], ['Posted a job on Ashby', VOIZE_URL, 'Senior Revenue Operations Manager']] as const) assert.equal(signalNamesBoardPosting(s, u, t), false, `${s} ${u} ${t}`)
  const restore = fakeHttps({ rogo: ROGO_BOARD })
  try {
    const page = await read(ROGO_URL) as Page
    const r = verifyEvidence({ company: 'Rogo', signal: ROGO_SIGNAL, source_url: ROGO_URL, excerpt: ROGO_QUOTE.replace(' ... ', ' … '), event_date: null } as never, page)
    assert.equal(r.ok, true, JSON.stringify(r))
  } finally { restore() }
})

test('#533 review: a board-bound posting the grader lists only as another event keeps that kind, so its board day is not a hiring day', async () => {
  const { boundKind } = await import('../lib/scan/runner.ts')
  const { dated } = await import('../lib/monitor-events.ts')
  // no grade, a hiring grade, or a hiring-type / graded hiring kind: a hiring posting (the graded requested-role kind is kept)
  assert.deepEqual([boundKind('hiring', null), boundKind('hiring', 'hiring'), boundKind('hiring', 'hiring_relevant_role'), boundKind('hiring', 'job_board_presence')], ['hiring', 'hiring', 'hiring_relevant_role', 'hiring'])
  // graded only as another dated event: the grade is kept, so the board's day never dates it as hiring (card, scoreboard, monitor)
  assert.equal(boundKind('hiring', 'raised_funding'), 'raised_funding')
  const row = { event_date: VOIZE_DAY, event_date_proof: 'ats_structured', signal: VOIZE_SIGNAL, signal_kind: boundKind('hiring', 'raised_funding'), signals: '["raised_funding"]' }
  assert.equal(eventDayVerified(row), false)
  assert.equal(dated(row, Math.floor(Date.now() / 1000)), false)
  // not bound: the grade alone, as before
  assert.equal(boundKind(null, 'raised_funding'), 'raised_funding'); assert.equal(boundKind(undefined, null), null)
})
