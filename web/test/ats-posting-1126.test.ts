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
import { createHiringFeedIntake } from '../lib/scan/job-feed.ts'
import { verifyLeads, type LeadDraft } from '../lib/scan/runner.ts'
import { ownPlaceAgreement } from '../lib/scan/own-block.ts'

const NOW = new Date('2026-11-13T12:00:00Z')
const AID = 'a1260000-0000-4000-8000-000000000001', LID = 'b1260000-0000-4000-8000-000000000002'
// a quote from the posting's own text that never names the employer
const QUOTE = 'You will run Salesforce, forecasting and pipeline reporting for the revenue team.'
const DESC = `We are hiring a Sales Operations Manager. ${QUOTE}`
const ashby = (desc = DESC, title = 'Sales Operations Manager') => ({ apiVersion: '1', jobs: [{ id: AID, title, location: 'Berlin', employmentType: 'FullTime', isListed: true, publishedAt: '2026-11-01T09:00:00.000+00:00', jobUrl: 'x', descriptionPlain: desc }] })
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
  // review R3 at 10fe3f7c: the slug follows companyOwnsDomain's domain-label rule, with no legal-suffix stripping on the
  // slug: "acme-co" / "the-acme-company" are not "Acme" (only a stated name could say so); separators are spacing only
  for (const slug of ['acme-co', 'the-acme-company', 'acme-inc']) assert.equal(verdict('Acme', await page(slug), url(slug)), 'entity_mismatch', slug)
  assert.equal(verdict('Acme Co', await page('acme-co'), url('acme-co')), 'entity_mismatch', 'as companyOwnsDomain: the lead\'s key is "acme" (suffix set aside), the slug spells "acmeco"')
  for (const slug of ['acme_health', 'acme.health', 'AcmeHealth']) assert.equal(verdict('Acme Health', await page(slug), url(slug)), 'ok', slug)
  assert.equal(verdict('Go', await page('go'), url('go')), 'entity_mismatch', 'a 2-character name never comes from a slug (the domain-label floor)')
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
  const statedCo = await read(url, serve('Acme Co'))
  assert.equal(verdict('Acme', statedCo, url), 'ok', 'a stated name is a company name: its legal suffix is set aside, as for the lead')
  const multi = await read(url, serve('Acme Health'))
  assert.equal(verdict('Health', multi, url), 'entity_mismatch')
  assert.equal(verdict('Acme Health', multi, url), 'ok')
  // no stated name (an older record, or a blank one): the slug is the fallback
  for (const name of [undefined, '   ']) {
    const fallback = await read(url, serve(name))
    assert.equal(fallback.title, 'Sales Operations Manager', 'review R4: no stated name, the posting title alone; never the slug')
    assert.equal(verdict('Acme', fallback, url), 'ok', String(name))
    assert.equal(verdict('Zeta Labs', fallback, url), 'entity_mismatch', String(name))
  }
})

test('#1126: a quote that names the company still verifies; the posting\'s job title never names the employer', async () => {
  const url = `https://jobs.ashbyhq.com/acme-health/${AID}`
  const named = 'Acme is hiring a Sales Operations Manager to own the CRM.'
  const page = await read(url, u => u.startsWith('https://api.ashbyhq.com/') ? ashby(`${named} ${QUOTE}`) : undefined)
  assert.equal(verdict('Acme', page, url, named), 'ok', 'named in the quote')
  assert.equal(verdict('Acme', page, url), 'entity_mismatch', 'the same company from a quote that never names it, on a slug that is only part of a name')
  // review R1 at 10fe3f7c: the job title is the role, not the employer
  assert.equal(verdict('Sales Operations', page, url), 'entity_mismatch')
  for (const [company, title, slug] of [['Salesforce', 'Salesforce Administrator', 'acme-health'], ['Go', 'Senior Go Engineer', 'acme'], ['Health', 'Health and Safety Officer', 'acme-health']]) {
    const u = `https://jobs.ashbyhq.com/${slug}/${AID}`
    const p = await read(u, x => x.startsWith(`https://api.ashbyhq.com/posting-api/job-board/${slug}`) ? ashby(DESC, title) : undefined)
    const q = 'forecasting and pipeline reporting for the revenue team.' // QUOTE without its "Salesforce"
    assert.equal(verdict(company, p, u, q), 'entity_mismatch', `${company} on "${title}" @ ${slug}`)
    assert.equal(verdict(slug === 'acme' ? 'Acme' : 'Acme Health', p, u, q), 'ok', `the board itself still names its company: ${slug}`)
  }
})

test('#1126 review R4: the runner\'s quote_unconfirmed routing and the own-block place check read the board identity, not the slug', async () => {
  const url = `https://jobs.ashbyhq.com/acme-health/${AID}`
  const serve = (u: string) => u.startsWith('https://api.ashbyhq.com/posting-api/job-board/acme-health') ? ashby() : undefined
  const restore = fakeHttps(serve)
  try {
    const draft = (company: string) => ({ name: '', contact: null, event_date: null, score: 80, company, signal: 'Posted a Sales Operations Manager role on Ashby', source_url: url, excerpt: 'A paraphrase of the posting that is not on the page at all.' }) as LeadDraft
    const fetch = (u: string) => fetchPageDetailed(u, async () => null)
    const health = await verifyLeads([draft('Health')], fetch, NOW)
    assert.deepEqual([health.review.map(r => r.review_reason), health.dropped], [[], { excerpt_not_on_page: 1 }], 'a slug word does not make the page "about" Health')
    resetBoardMemo()
    const whole = await verifyLeads([draft('Acme Health')], fetch, NOW)
    assert.deepEqual(whole.review.map(r => r.review_reason), ['quote_unconfirmed'])
  } finally { restore() }
  const page = await read(url, serve)
  assert.equal(ownPlaceAgreement(page, ['Berlin'], 'Health', QUOTE), 'unconfirmed', 'the slug word does not make the whole page Health\'s own block')
  assert.equal(ownPlaceAgreement(page, ['Berlin'], 'Acme Health', QUOTE), 'agrees')
})

test('#1126 review R2: the job-feed intake marks a board record "company named" only by the board\'s whole name', async () => {
  const url = `https://jobs.ashbyhq.com/acme-health/${AID}`
  const role = 'Sales Development Representative'
  const intake = async (company: string) => {
    const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db)
    const xml = `<rss><channel><item><title>${company}: ${role}</title><pubDate>Fri, 23 Oct 2026 09:48:36 +0000</pubDate><guid>https://weworkremotely.com/remote-jobs/x-sdr</guid><description>x</description></item></channel></rss>`
    // the posting page is the Ashby board's record (the feed item's page, read through the board API)
    const page = await read(url, u => u.startsWith('https://api.ashbyhq.com/posting-api/job-board/acme-health') ? ashby(DESC, role) : undefined)
    const r = await createHiringFeedIntake(db, 'T1', 'sales-and-marketing', 'sales development', { fetchFeed: async () => xml, fetchPage: async () => page, get: async u => ({ status: 404, body: '', finalUrl: u }), gapMs: 0, env: {}, now: 1800000000 })
    await r.crawl
    assert.equal(r.leads.length, 1, JSON.stringify(r))
    return (db.prepare('SELECT company_named FROM source_reviews').get() as { company_named: number }).company_named
  }
  assert.equal(await intake('Health'), 0)
  assert.equal(await intake('Acme Health'), 1)
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

test('#1126 (XHawk on #1143): a TinyFish copy held for a blocked board read is still a board posting, never title-matched', async () => {
  const { HeldText } = await import('../lib/scan/held-text.ts')
  const named = 'Acme Health is hiring a Sales Operations Manager to own the CRM.'
  const filler = ' The role partners with sales leadership on territory planning, quota setting and the weekly forecast call.'.repeat(5)
  const body = `Sales Operations Manager Location Berlin ${QUOTE} ${named}${filler} Apply for this job.`
  const blocked = async () => ({ fail: 'blocked' as const })
  const run = async (company: string, url: string, title: string, excerpt = QUOTE) => {
    const text = HeldText.seal('job1:1', [url], [{ url, title, text: body }])
    const draft = { name: '', contact: null, event_date: null, score: 80, company, signal: 'Posted a Sales Operations Manager role', source_url: url, excerpt } as LeadDraft
    const o = await verifyLeads([draft], blocked, NOW, undefined, null, { text, attempt: 'job1:1' })
    return o.leads.length ? `ok:${o.leads[0].evidence_origin}` : o.review.length ? `review:${o.review[0].review_reason}` : Object.keys(o.dropped).join(',')
  }
  // Ashby / Lever: the URL's slug, as a whole name; the copy's page title ("... @ acme-health") is never phrase-matched
  for (const url of [`https://jobs.ashbyhq.com/acme-health/${AID}`, `https://jobs.lever.co/acme-health/${LID}`]) {
    const title = 'Sales Operations Manager @ acme-health'
    assert.equal(await run('Health', url, title), 'review:blocked_by_site', `${url}: "Health" is not bound by the copy, so the block stands`)
    assert.equal(await run('Acme', url, title), 'review:blocked_by_site', url)
    assert.equal(await run('Acme Health', url, title), 'ok:tinyfish_copy', url)
  }
  // Greenhouse: no slug identity from a copy; only a quote naming the company binds it
  const gh = 'https://boards.greenhouse.io/acme-health/jobs/4012345', ghTitle = 'Job Application for Sales Operations Manager at Acme Health'
  assert.equal(await run('Health', gh, ghTitle), 'review:blocked_by_site')
  assert.equal(await run('Acme Health', gh, ghTitle), 'review:blocked_by_site', 'neither the slug nor the copy title binds a Greenhouse copy')
  assert.equal(await run('Acme Health', gh, ghTitle, named), 'ok:tinyfish_copy', 'a quote naming the company still verifies')
  // an ordinary (non-board) page keeps the title rule
  assert.equal(await run('Acme Health', 'https://acmehealth.example/careers/sales-ops', 'Careers at Acme Health'), 'ok:tinyfish_copy')
})
