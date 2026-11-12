// #533 live check (staging, 2026-11-12): two Ashby postings for the requested role were held as "blocked_by_site" with
// no date, because the verifier read the posting PAGE (a JavaScript app / bot wall) instead of the board's own API record,
// which states the first-published day. A posting URL is now read through the board's public API record
// (lib/sources/ats-posting.ts), and a hiring candidate cited to it is dated by the board's own publish day (#460 contract).
// Synthetic boards and companies only; the socket is faked (no network).
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import { atsPostingRef, atsRecord, atsRecordUrl, isAtsRecordUrl } from '../lib/sources/ats-posting.ts'
import { fetchPageDetailed, isFail, type Page } from '../lib/scan/fetch-page.ts'
import { verifyLeads, type LeadDraft } from '../lib/scan/runner.ts'

const NOW = Date.parse('2026-11-12T18:00:00Z')
const ID = '6514089f-0000-4000-8000-00000000a001', LID = '0f1e2d3c-0000-4000-8000-00000000b002'
const ASHBY_URL = `https://jobs.ashbyhq.com/acmeco/${ID}`
const DESC = 'Acmeco is hiring a Senior Revenue Operations Manager to own Sales Ops and CRM administration for our go-to-market team. You will run Salesforce, forecasting and pipeline reporting.'
const ASHBY_BOARD = { jobs: [
  { id: '11111111-0000-4000-8000-000000000000', title: 'AI Deployment Strategist', isListed: true, publishedAt: '2026-10-01T10:00:00.000+00:00', jobUrl: 'https://jobs.ashbyhq.com/acmeco/11111111-0000-4000-8000-000000000000', descriptionPlain: 'Another role.' },
  { id: ID, title: 'Senior Revenue Operations Manager - Sales Ops & Strategy', location: 'Berlin', isListed: true, publishedAt: '2026-10-15T14:33:00.000+00:00', updatedAt: '2026-11-10T09:00:00.000+00:00', jobUrl: ASHBY_URL, descriptionPlain: DESC },
] }

// the real fetchPageDetailed with only the socket faked; records what was asked
function fakeHttps(serve: (url: string) => { status: number; type: string; body: string }, asked: { url: string; accept: string }[] = []) {
  const real = https.request
  ;(https as { request: unknown }).request = (url: URL, opts: { headers: Record<string, string> }, cb: (res: EventEmitter) => void) => {
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void }
    req.destroy = () => {}
    req.end = () => {
      asked.push({ url: String(url), accept: opts.headers.accept })
      const r = serve(String(url)); const res = Object.assign(new EventEmitter(), { statusCode: r.status, headers: { 'content-type': r.type }, resume() {}, destroy() {} })
      cb(res); res.emit('data', Buffer.from(r.body)); res.emit('end')
    }
    return req
  }
  return () => { (https as { request: unknown }).request = real }
}
// as seen live: the posting page refuses a plain read; the board API answers with JSON
const live = (over: Record<string, { status?: number; type?: string; body?: string }> = {}) => (u: string) => {
  const o = Object.entries(over).find(([k]) => u.startsWith(k))?.[1]
  if (o) return { status: o.status ?? 200, type: o.type ?? 'application/json', body: o.body ?? '' }
  if (u.startsWith('https://api.ashbyhq.com/posting-api/job-board/acmeco')) return { status: 200, type: 'application/json; charset=utf-8', body: JSON.stringify(ASHBY_BOARD) }
  return { status: 403, type: 'text/html', body: '<html><title>Just a moment...</title></html>' }
}
const draft = (over: Partial<LeadDraft> = {}) => ({ name: '', company: 'Acmeco', contact: null, signal: 'Hiring a Senior Revenue Operations Manager (Sales Ops)', source_url: ASHBY_URL, excerpt: 'Acmeco is hiring a Senior Revenue Operations Manager to own Sales Ops and CRM administration', event_date: null, score: 80, ...over }) as LeadDraft

test('#533 posting URLs: only the documented Ashby / Greenhouse / Lever posting shapes, query strings ignored', () => {
  assert.deepEqual(atsPostingRef(ASHBY_URL), { kind: 'ashby', org: 'acmeco', id: ID })
  assert.deepEqual(atsPostingRef(`${ASHBY_URL}/application?utm_source=x`), { kind: 'ashby', org: 'acmeco', id: ID })
  assert.deepEqual(atsPostingRef('https://boards.greenhouse.io/acmeco/jobs/4012345?gh_src=x'), { kind: 'greenhouse', org: 'acmeco', id: '4012345' })
  assert.deepEqual(atsPostingRef('https://job-boards.eu.greenhouse.io/acmeco/jobs/4012345'), { kind: 'greenhouse', org: 'acmeco', id: '4012345' })
  assert.deepEqual(atsPostingRef(`https://jobs.lever.co/acmeco/${LID}/apply`), { kind: 'lever', org: 'acmeco', id: LID })
  for (const no of ['https://jobs.ashbyhq.com/acmeco', 'https://jobs.ashbyhq.com/acmeco/not-a-uuid', 'http://jobs.ashbyhq.com/acmeco/' + ID, 'https://boards.greenhouse.io/acmeco', 'https://boards.greenhouse.io/acmeco/jobs/abc',
    'https://jobs.lever.co/acmeco', 'https://evil.example/jobs.ashbyhq.com/acmeco/' + ID, 'https://jobs.ashbyhq.com.evil.example/acmeco/' + ID, 'not a url']) assert.equal(atsPostingRef(no), null, no)
  assert.equal(atsRecordUrl({ kind: 'ashby', org: 'acmeco', id: ID }), 'https://api.ashbyhq.com/posting-api/job-board/acmeco')
  assert.equal(atsRecordUrl({ kind: 'greenhouse', org: 'acmeco', id: '4012345' }), 'https://boards-api.greenhouse.io/v1/boards/acmeco/jobs/4012345')
  assert.equal(atsRecordUrl({ kind: 'lever', org: 'acmeco', id: LID }), `https://api.lever.co/v0/postings/acmeco/${LID}?mode=json`)
  assert.equal(isAtsRecordUrl('https://api.ashbyhq.com/posting-api/job-board/acmeco'), true)
  assert.equal(isAtsRecordUrl('https://jobs.ashbyhq.com/acmeco'), false)
})

test('#533 the record: exactly this posting, its first-published day only (never updated_at); closed and undated postings prove nothing', () => {
  const a = atsRecord(ASHBY_BOARD, { kind: 'ashby', org: 'acmeco', id: ID })
  assert.ok(a && a !== 'missing'); assert.equal(a.posted, '2026-10-15'); assert.equal(a.title, 'Senior Revenue Operations Manager - Sales Ops & Strategy')
  assert.equal(atsRecord({ jobs: [{ ...ASHBY_BOARD.jobs[1], isListed: false }] }, { kind: 'ashby', org: 'acmeco', id: ID }), 'missing', 'unlisted = closed')
  assert.equal(atsRecord({ jobs: [] }, { kind: 'ashby', org: 'acmeco', id: ID }), 'missing')
  assert.equal(atsRecord({ jobs: [{ ...ASHBY_BOARD.jobs[1], publishedAt: undefined }] }, { kind: 'ashby', org: 'acmeco', id: ID }), null, 'listed but undated: no record (updatedAt is not a posting date)')
  assert.equal(atsRecord({ nope: 1 }, { kind: 'ashby', org: 'acmeco', id: ID }), null)
  const gh = atsRecord({ id: 4012345, title: 'Sales Operations Manager', location: { name: 'Remote' }, first_published: '2026-10-20T12:00:00-04:00', updated_at: '2026-11-11T00:00:00-04:00', content: '&lt;p&gt;Run Sales Ops&lt;/p&gt;' }, { kind: 'greenhouse', org: 'acmeco', id: '4012345' })
  assert.ok(gh && gh !== 'missing'); assert.deepEqual([gh.posted, gh.location, gh.html], ['2026-10-20', 'Remote', true])
  assert.equal(atsRecord({ id: 999, title: 'x', first_published: '2026-10-20' }, { kind: 'greenhouse', org: 'acmeco', id: '4012345' }), null, 'another posting')
  assert.equal(atsRecord({ id: 4012345, title: 'x', updated_at: '2026-11-11' }, { kind: 'greenhouse', org: 'acmeco', id: '4012345' }), null, 'updated_at alone is no date')
  const lv = atsRecord({ id: LID, text: 'CRM Administrator', createdAt: Date.parse('2026-10-25T08:00:00Z'), categories: { location: 'London' }, descriptionPlain: 'Own the CRM.' }, { kind: 'lever', org: 'acmeco', id: LID })
  assert.ok(lv && lv !== 'missing'); assert.deepEqual([lv.posted, lv.title, lv.location], ['2026-10-25', 'CRM Administrator', 'London'])
})

test('#533 the verifier reads a posting through the board API record, never the page: readable, dated by the board, not "blocked"', async () => {
  const asked: { url: string; accept: string }[] = []
  const restore = fakeHttps(live(), asked)
  try {
    const page = await fetchPageDetailed(`${ASHBY_URL}?action=apply`, async () => { throw new Error('the rendering service is never used for a posting') })
    assert.ok(!isFail(page), JSON.stringify(page))
    assert.equal((page as Page).postedAt, '2026-10-15')
    assert.match((page as Page).text, /^Senior Revenue Operations Manager - Sales Ops & Strategy \(Berlin\)\. Job posting on the acmeco Ashby job board, first published 2026-10-15\. Acmeco is hiring/)
    assert.deepEqual(asked.map(a => [a.url, a.accept]), [['https://api.ashbyhq.com/posting-api/job-board/acmeco', 'application/json']], 'only the API host; the posting page is never requested')
    // through the verifier: the requested-role posting is a verified, dated lead (it was held "blocked_by_site", undated)
    const o = await verifyLeads([draft()], u => fetchPageDetailed(u, async () => null), new Date(NOW))
    assert.equal(o.review.length, 0, JSON.stringify(o.review))
    assert.equal(o.leads.length, 1, JSON.stringify(o))
    assert.deepEqual([o.leads[0].event_date, o.leads[0].event_date_proof], ['2026-10-15', 'ats_structured'])
    // a claimed day equal to the board's is kept with the same proof
    const same = await verifyLeads([draft({ event_date: '2026-10-15' })], u => fetchPageDetailed(u, async () => null), new Date(NOW))
    assert.deepEqual([same.leads[0]?.event_date, same.leads[0]?.event_date_proof], ['2026-10-15', 'ats_structured'])
    // the board day dates HIRING only: a funding claim cited to a posting gets no date from it
    const funding = await verifyLeads([draft({ signal: 'Raised a Series A round', excerpt: 'Acmeco is hiring a Senior Revenue Operations Manager to own Sales Ops and CRM administration' })], u => fetchPageDetailed(u, async () => null), new Date(NOW))
    assert.ok([...funding.leads, ...funding.review].every(l => l.event_date_proof !== 'ats_structured'), JSON.stringify(funding))
  } finally { restore() }
})

test('#533 a posting the board no longer lists is closed (not found); a refused or foreign answer is a failed read, never a page', async () => {
  const api = 'https://api.ashbyhq.com/posting-api/job-board/acmeco'
  const cases: [string, Record<string, { status?: number; type?: string; body?: string }>, string][] = [
    ['unlisted', { [api]: { body: JSON.stringify({ jobs: [] }) } }, 'not_found'],
    ['board gone', { [api]: { status: 404 } }, 'not_found'],
    ['rate limited', { [api]: { status: 429 } }, 'blocked'],
    ['HTML instead of JSON', { [api]: { type: 'text/html', body: '<html>hi</html>' } }, 'error'],
    ['malformed JSON', { [api]: { body: '{"jobs":' } }, 'error'],
    ['undated posting', { [api]: { body: JSON.stringify({ jobs: [{ ...ASHBY_BOARD.jobs[1], publishedAt: null }] }) } }, 'error'],
  ]
  for (const [name, over, fail] of cases) {
    const restore = fakeHttps(live(over))
    try {
      const r = await fetchPageDetailed(ASHBY_URL, async () => { throw new Error('never rendered') })
      assert.ok(isFail(r), name); assert.equal(r.fail, fail, name)
    } finally { restore() }
  }
})
