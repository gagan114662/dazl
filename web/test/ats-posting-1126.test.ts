// #1126: a posting read through its board's API record (lib/sources/ats-posting.ts) is published by the company the board
// STATES (Greenhouse company_name; the Ashby job-board and Lever postings APIs state none), else by its slug, and either
// names the lead's company only as its whole key. Before, the page title was "<posting title> @ <slug>" and the title was
// phrase-matched, so board "acme-health" named "Health" and "Acme" alone, and the closing line of the text named the slug
// too. The socket is faked (no network); the record shapes are the live APIs' fields (checked 2026-11-13).
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import Database from 'better-sqlite3'
import { fetchPageDetailed, isFail, resetBoardMemo, type Page } from '../lib/scan/fetch-page.ts'
import { verifyEvidence, type Candidate } from '../lib/scan/evidence.ts'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { createSourceReview, migrateSourceReview } from '../lib/scan/source-review.ts'

const NOW = new Date('2026-11-13T12:00:00Z')
const AID = 'a1260000-0000-4000-8000-000000000001', LID = 'b1260000-0000-4000-8000-000000000002'
// a quote from the posting's own text that never names the employer
const QUOTE = 'You will run Salesforce, forecasting and pipeline reporting for the revenue team.'
const DESC = `We are hiring a Sales Operations Manager. ${QUOTE}`
const ashby = (desc = DESC) => ({ apiVersion: '1', jobs: [{ id: AID, title: 'Sales Operations Manager', location: 'Berlin', employmentType: 'FullTime', isListed: true, publishedAt: '2026-11-01T09:00:00.000+00:00', jobUrl: 'x', descriptionPlain: desc }] })
const gh = (company_name?: string) => ({ id: 4012345, internal_job_id: 1, title: 'Sales Operations Manager', location: { name: 'Remote' }, first_published: '2026-11-01T09:00:00-04:00', updated_at: '2026-11-12T00:00:00-04:00', content: `&lt;p&gt;${DESC}&lt;/p&gt;`, ...(company_name === undefined ? {} : { company_name }) })
const lever = { id: LID, text: 'Sales Operations Manager', createdAt: Date.parse('2026-11-01T09:00:00Z'), categories: { location: 'London' }, descriptionPlain: DESC }

function fakeHttps(serve: (url: string) => unknown) {
  const real = https.request
  resetBoardMemo()
  ;(https as { request: unknown }).request = (url: URL, _o: unknown, cb: (res: EventEmitter) => void) => {
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void }
    req.destroy = () => {}
    req.end = () => {
      const body = serve(String(url)), ok = body !== undefined
      const res = Object.assign(new EventEmitter(), { statusCode: ok ? 200 : 403, headers: { 'content-type': ok ? 'application/json' : 'text/html' }, resume() {}, destroy() {} })
      cb(res); res.emit('data', Buffer.from(ok ? JSON.stringify(body) : '')); res.emit('end')
    }
    return req
  }
  return () => { (https as { request: unknown }).request = real }
}
async function read(url: string, serve: (url: string) => unknown): Promise<Page> {
  const restore = fakeHttps(serve)
  try { const p = await fetchPageDetailed(url, async () => null); assert.ok(!isFail(p), JSON.stringify(p)); return p as Page } finally { restore() }
}
const cand = (company: string, source_url: string, excerpt = QUOTE): Candidate => ({ name: '', company, contact: null, signal: 'Posted a Sales Operations Manager role', source_url, score: 80, excerpt, event_date: null })
const verdict = (company: string, page: Page, url: string, excerpt?: string) => { const v = verifyEvidence(cand(company, url, excerpt), page, NOW); return v.ok ? 'ok' : v.reason }

test('#1126: a bare slug "acme-health" names "Acme Health" only, never "Health" or "Acme" alone (Ashby, Lever)', async () => {
  const aUrl = `https://jobs.ashbyhq.com/acme-health/${AID}`, lUrl = `https://jobs.lever.co/acme-health/${LID}`
  const a = await read(aUrl, u => u.startsWith('https://api.ashbyhq.com/posting-api/job-board/acme-health') ? ashby() : undefined)
  const l = await read(lUrl, u => u.startsWith(`https://api.lever.co/v0/postings/acme-health/${LID}`) ? lever : undefined)
  for (const [page, url] of [[a, aUrl], [l, lUrl]] as const) {
    assert.equal(verdict('Health', page, url), 'entity_mismatch', url)
    assert.equal(verdict('Acme', page, url), 'entity_mismatch', url)
    assert.equal(verdict('Health Inc', page, url), 'entity_mismatch', url)
    assert.equal(verdict('Acme Health', page, url), 'ok', url)
    assert.equal(verdict('Acme Health, Inc.', page, url), 'ok', 'legal suffixes aside, the whole key')
    assert.equal(verdict('Acme Health Group', page, url), 'entity_mismatch', 'a longer name is another company')
    // the closing line is dazl's own wording: it never carries the slug, so a quote cut to include it names nobody
    assert.ok(!page.text.includes('acme-health') && !/acme health/i.test(page.text), page.text)
  }
})

test('#1126 (owner decision): a glued slug equal to the whole key without spaces names the company; one containing it does not', async () => {
  const url = (slug: string) => `https://jobs.lever.co/${slug}/${LID}`
  const page = (slug: string) => read(url(slug), u => u.includes(`/postings/${slug}/${LID}`) ? lever : undefined)
  const glued = await page('acmehealth')
  assert.equal(verdict('Acme Health', glued, url('acmehealth')), 'ok')
  assert.equal(verdict('Acme', glued, url('acmehealth')), 'entity_mismatch')
  assert.equal(verdict('Health', glued, url('acmehealth')), 'entity_mismatch')
  // too short to be a name glued together: only the exact key
  const ab = await page('a-b')
  assert.equal(verdict('AB', ab, url('a-b')), 'entity_mismatch', '"a b" glued is 2 characters, below the 3-character floor')
})

test('#1126: the board\'s stated company name is used when present, and the slug is then ignored (Greenhouse company_name)', async () => {
  const url = 'https://boards.greenhouse.io/acme/jobs/4012345'
  const serve = (name?: string) => (u: string) => u === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345' ? gh(name) : undefined
  const stated = await read(url, serve('Zeta Labs'))
  assert.equal(verdict('Zeta Labs', stated, url), 'ok', 'the stated name names the company although the slug does not')
  assert.equal(verdict('Zeta Labs Inc', stated, url), 'ok')
  assert.equal(verdict('Acme', stated, url), 'entity_mismatch', 'the slug is only a fallback')
  assert.equal(verdict('Zeta', stated, url), 'entity_mismatch', 'a stated name names its whole key only')
  assert.equal(stated.title, 'Sales Operations Manager @ Zeta Labs', 'the display title shows the stated name')
  const multi = await read(url, serve('Acme Health'))
  assert.equal(verdict('Health', multi, url), 'entity_mismatch')
  assert.equal(verdict('Acme Health', multi, url), 'ok')
  // no stated name (an older record, or a blank one): the slug is the fallback
  for (const name of [undefined, '   ']) {
    const fallback = await read(url, serve(name))
    assert.equal(verdict('Acme', fallback, url), 'ok', String(name))
    assert.equal(verdict('Zeta Labs', fallback, url), 'entity_mismatch', String(name))
  }
})

test('#1126: a quote that names the company still verifies; the posting title still counts as the page heading', async () => {
  const url = `https://jobs.ashbyhq.com/acme-health/${AID}`
  const named = 'Acme is hiring a Sales Operations Manager to own the CRM.'
  const page = await read(url, u => u.startsWith('https://api.ashbyhq.com/') ? ashby(`${named} ${QUOTE}`) : undefined)
  assert.equal(verdict('Acme', page, url, named), 'ok', 'named in the quote')
  assert.equal(verdict('Acme', page, url), 'entity_mismatch', 'the same company from a quote that never names it, on a slug that is only part of a name')
  assert.equal(verdict('Sales Operations', page, url), 'ok', 'the posting title is the heading, as a page title is')
})

test('#1126: the source review applies the same identity (company_named) to a board record', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateSourceReview(db)
  const url = `https://jobs.ashbyhq.com/acme-health/${AID}`
  const restore = fakeHttps(u => u.startsWith('https://api.ashbyhq.com/') ? ashby() : undefined)
  try {
    const fetcher = (u: string) => fetchPageDetailed(u, async () => null)
    const base = { signal: 'Hiring a Sales Operations Manager (supplied claim)', source_url: url, excerpt: QUOTE, contact: null, event_date: null }
    const health = await createSourceReview(db, 'T1', { ...base, company: 'Health' }, fetcher)
    assert.deepEqual([health.check.quote_match, health.check.company_named], [true, false])
    resetBoardMemo()
    const whole = await createSourceReview(db, 'T1', { ...base, company: 'Acme Health' }, fetcher)
    assert.deepEqual([whole.check.quote_match, whole.check.company_named], [true, true])
  } finally { restore() }
})
