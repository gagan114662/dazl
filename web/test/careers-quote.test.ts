// #767 live check (Hermes-PC, staging at 194e9ada): a careers lead from a public Ashby posting was held as quote_unconfirmed. The quote was built across
// `${title} ${description}` ("Sales Assist Representative AI AT ZAPIER At Zapier ...": the title glued onto the description's boilerplate preamble), a string that is on
// no page. These fixtures are real-shaped (the Ashby / Lever public API records, a descriptionPlain that opens with a company preamble, modelled on the live
// Zapier "Sales Assist Representative" posting) for an invented company, Brightloop. The verifier's page is the REAL rendering of the same board record
// (atsRecord + atsPageText, lib/sources/ats-posting.ts); no network, no model. Local fixture, not live proof.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob, listLeads } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { careersSalesVacancy } from '../lib/signals/careers-page.ts'
import { atsPageText, atsPostingRef, atsRecord } from '../lib/sources/ats-posting.ts'
import { htmlToText } from '../lib/scan/fetch-page.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const master = randomBytes(32)
const ago = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
const POSTED = ago(9)
const ID = '6adee270-03bf-4b1b-915b-eba5fb56d1b6'
const ASHBY = `https://jobs.ashbyhq.com/brightloop/${ID}`
const LEVER_ID = '3f1c2b9a-7d4e-4c1a-9b2f-5e6d7c8b9a01'
const LEVER = `https://jobs.lever.co/brightloop/${LEVER_ID}`
const PREAMBLE = 'AI AT BRIGHTLOOP\n\nAt Brightloop https://brightloop.io/about, we build and use automation every day to make work more efficient, creative, and human. So if you’re using AI tools while applying here - that’s great! We just ask that you use them responsibly and transparently.\n\nCheck out our guidance on How to Collaborate with AI During Brightloop’s Hiring Process https://brightloop.io/l/jobs/ai-at-brightloop, including how to use AI tools during our hiring process - and when not to.\n\n \n\nAI Fluency Assessment https://ai-fluency.example\nTake our 10 minute AI Fluency Assessment by clicking the link above. See how your skills stack up against our sales bar.\n\n\n\nJob Posted: June 2026\n\nLocation: India\n\n\n\n'
const ROLE = 'Hi there!\n\nWe’re looking for a new Sales-Assist Representative to join the Sales-Assist Motion at Brightloop.\n\nBrightloop’s on a mission to make everyone more productive at work. The Sales Assist group serves customers as they evaluate and buy Brightloop’s offers, through a high-velocity sales motion.\n\nABOUT YOU\n\n - You are located in India and able to work within the hours of ~9:00 pm - 7:00 am IST.'
const ASHBY_DESC = PREAMBLE + ROLE
const LEVER_DESC = 'About Brightloop\nBrightloop builds workflow software for finance teams. Our customers include hundreds of mid-market companies across Europe, and we are backed by leading investors.\n\nThe opportunity\nWe are hiring an Account Executive to own the full sales cycle for new mid-market customers in London, from first call to signed contract.'
const LEVER_PREAMBLE = 'About Brightloop\nBrightloop builds workflow software for finance teams. Our customers include hundreds of mid-market companies across Europe, and we are backed by leading investors.\n\nBenefits\nPrivate health cover, a learning budget and 30 days of holiday.'
const ashbyBoard = (desc: string) => JSON.stringify({ jobs: [{ id: ID, title: 'Sales Assist Representative', location: 'APAC', isListed: true, publishedAt: `${POSTED}T21:00:14.036+00:00`, jobUrl: ASHBY, descriptionPlain: desc, descriptionHtml: `<p>${desc}</p>` }] })
const leverRecord = (desc: string) => JSON.stringify({ id: LEVER_ID, text: 'Account Executive', descriptionPlain: desc, description: `<div>${desc}</div>`, additionalPlain: 'Brightloop is an equal opportunity employer.', categories: { location: 'London' }, createdAt: Date.parse(`${POSTED}T09:00:00Z`) })
const GH = 'https://boards.greenhouse.io/brightloop/jobs/4012345'
// Greenhouse sends content as escaped HTML and the record also carries company_name: the old text was `${title} ${company_name} ${content}`
const GH_DESC = '<h2>About Brightloop</h2><p>Brightloop builds workflow software for finance teams across Europe &amp; the UK.</p><h2>The role</h2><p>We are hiring an Account Executive to own the full sales cycle for new mid-market customers in London.</p>'
const GH_PREAMBLE = '<h2>About Brightloop</h2><p>Brightloop builds workflow software for finance teams across Europe &amp; the UK.</p><h2>Benefits</h2><p>Private health cover and 30 days of holiday.</p>'
const ghRecord = (desc: string) => JSON.stringify({ id: 4012345, title: 'Account Executive', company_name: 'Brightloop', first_published: `${POSTED}T09:00:00Z`, location: { name: 'London' }, content: desc.replace(/</g, '&lt;').replace(/>/g, '&gt;') })
const html = (b: string) => `<html><body>${b}</body></html>`
type Board = 'ashby' | 'lever' | 'greenhouse'
const http = (board: Board, desc: string): SafeGet => async url => {
  const u = new URL(url)
  if (u.hostname === 'hn.algolia.com') return null
  if (u.hostname === 'api.ashbyhq.com') return { status: 200, body: ashbyBoard(desc) }
  if (u.hostname === 'api.lever.co') return { status: 200, body: leverRecord(desc) }
  if (u.hostname === 'boards-api.greenhouse.io') return { status: 200, body: ghRecord(desc) }
  if (u.hostname === 'brightloop.io' && u.pathname === '/careers') return { status: 200, body: html(board === 'ashby' ? `<ul><li><a href="${ASHBY}">Sales Assist Representative</a></li></ul>` : `<ul><li><a href="${board === 'lever' ? LEVER : GH}">Account Executive</a></li></ul>`) }
  return { status: 404, body: '' }
}
const get = (board: Board, desc: string) => async (url: string) => { const r = await http(board, desc)(url); return r ? { ...r, finalUrl: url } : null }
// the verifier's page: the board record rendered exactly as lib/scan/fetch-page.ts renders it (title line, then the posting's own text), dated by postedAt
const verifierPage = (board: Board, desc: string) => async (url: string) => {
  const ref = atsPostingRef(url); if (!ref) return { fail: 'error' }
  const rec = atsRecord(JSON.parse(board === 'ashby' ? ashbyBoard(desc) : board === 'lever' ? leverRecord(desc) : ghRecord(desc)), ref)
  if (!rec || rec === 'missing') return { fail: 'not_found' }
  const p = atsPageText(rec, rec.html ? ghText(rec.description) : rec.description)
  return { text: p.text, title: p.title, retrievedAt: Math.floor(Date.now() / 1000), published: rec.posted, postedAt: rec.posted, structured: [] }
}
// the Greenhouse content as the verifier reads it (fetch-page: htmlToText of the unescaped content)
const ghText = (escaped: string) => htmlToText(escaped.replace(/&lt;/g, '<').replace(/&gt;/g, '>')).text
const NOW = Date.now()
const vacancy = (board: Board, desc: string) => careersSalesVacancy('brightloop.io', get(board, desc), { now: NOW, company: 'Brightloop', namedQuote: true })
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

test('Ashby: the quote is a verbatim passage of descriptionPlain that states the vacancy, never the title glued onto the preamble', async () => {
  const r = await vacancy('ashby', ASHBY_DESC)
  assert.equal(r.reason, 'found'); const q = r.vacancy!.quote
  assert.ok(q.length >= 20 && q.length <= 300, q)
  assert.ok(flat(ASHBY_DESC).includes(q), `the quote is a verbatim substring of descriptionPlain: ${q}`)
  assert.ok(!q.startsWith('Sales Assist Representative AI AT'), 'never across the title / description join')
  assert.ok(!/AI AT BRIGHTLOOP|automation every day|Hiring Process/i.test(q), `not the boilerplate preamble: ${q}`)
  assert.match(q, /looking for a new Sales-Assist Representative/, 'the sentence naming the role')
})
test('Ashby: a preamble-only descriptionPlain (it never names the role or the hiring) gives no quote', async () => {
  const r = await vacancy('ashby', PREAMBLE + 'ABOUT YOU\n\n - You are located in India.')
  assert.equal(r.reason, 'found'); assert.equal(r.vacancy!.quote, '', `no quote: ${r.vacancy!.quote}`)
})
test('Lever: the quote is a verbatim passage of descriptionPlain stating the hiring; a preamble-only posting gives no quote', async () => {
  const r = await vacancy('lever', LEVER_DESC)
  assert.equal(r.reason, 'found'); const q = r.vacancy!.quote
  assert.ok(flat(LEVER_DESC).includes(q), `the quote is a verbatim substring of descriptionPlain: ${q}`)
  assert.ok(!q.startsWith('Account Executive About'), 'never across the title / description join')
  assert.match(q, /We are hiring an Account Executive/)
  const none = await vacancy('lever', LEVER_PREAMBLE)
  assert.equal(none.reason, 'found'); assert.equal(none.vacancy!.quote, '', `no quote: ${none.vacancy!.quote}`)
})

test('Greenhouse: the quote is a verbatim passage of the posting content as the verifier reads it, never across `title company_name content`; a preamble-only posting gives no quote', async () => {
  const r = await vacancy('greenhouse', GH_DESC)
  assert.equal(r.reason, 'found'); const q = r.vacancy!.quote
  assert.ok(ghText(JSON.parse(ghRecord(GH_DESC)).content).includes(q), `the quote is on the posting's own text: ${q}`)
  assert.ok(!/^Account Executive Brightloop/.test(q), 'never across the title / company_name / content join')
  assert.match(q, /We are hiring an Account Executive/)
  const none = await vacancy('greenhouse', GH_PREAMBLE)
  assert.equal(none.reason, 'found'); assert.equal(none.vacancy!.quote, '', `no quote: ${none.vacancy!.quote}`)
})

async function run(board: Board, desc: string, query = 'London B2B SaaS startups hiring sales staff') {
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const icp = JSON.stringify({ summary: 'x', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] })
  const id = createQueryJob(db, 'A', { query, icp, sources: JSON.stringify({ adapters: ['careers'], pages: ['https://brightloop.io'] }) } as never)
  const url = board === 'ashby' ? ASHBY : board === 'lever' ? LEVER : GH
  // the stubbed extraction model cites the careers item it was given, quoting that item's text (the evidence quote) verbatim, as the source prompt asks
  const extract = (p: string) => {
    const quotes = [...p.matchAll(/\{[^{}]*"source":"careers"[^{}]*\}/g)].map(m => { try { return JSON.parse(m[0]).text as string } catch { return '' } }).filter(Boolean)
    return quotes.length ? JSON.stringify([{ name: '', company: 'Brightloop', contact: null, signal: board === 'ashby' ? 'hiring a Sales Assist Representative' : 'hiring an Account Executive', score: 85, source_url: url, excerpt: quotes[0], event_date: POSTED }]) : '[]'
  }
  const prov = {
    anthropic: { research: async () => ({ text: '[]', citedUrls: [] }), complete: async (_k: string, p: string) => p.startsWith('You check one claim') ? 'supports' : extract(p) },
    openai: { research: async () => ({ text: '[]', citedUrls: [] }), complete: async () => '[]' },
  }
  const res = await runJob(db, claimKeyedJob(db, id)!, { providers: prov as never, master, fetchPage: verifierPage(board, desc) as never, sourceHttp: http(board, desc), crawlGet: async () => null, score: false, now: new Date() })
  const src = db.prepare("SELECT status, evidence_count AS evidence FROM scan_source_runs WHERE collector = 'adapter:careers'").get() as { status: string; evidence: number } | undefined
  return { res, src, rows: listLeads(db, 'A', id) as unknown as { source_url: string; review_reason: string | null; evidence_excerpt: string; event_date: string | null; event_date_proof: string | null }[] }
}
for (const [board, desc, url, onPage] of [['ashby', ASHBY_DESC, ASHBY, flat(ASHBY_DESC)], ['lever', LEVER_DESC, LEVER, flat(LEVER_DESC)], ['greenhouse', GH_DESC, GH, ghText(JSON.parse(ghRecord(GH_DESC)).content)]] as const) {
  test(`runner (${board}): the careers lead is verified through runJob / verifyLeads, not held as quote_unconfirmed, and dated ats_structured`, async () => {
    const x = await run(board, desc)
    assert.equal(x.res, 'done'); assert.deepEqual(x.src, { status: 'ok', evidence: 1 })
    const r = x.rows.find(r => r.source_url === url)
    assert.ok(r, `the posting became a lead: ${JSON.stringify(x.rows)}`)
    assert.equal(r!.review_reason, null, `verified, not held: ${JSON.stringify(r)}`)
    assert.ok(onPage.includes(r!.evidence_excerpt), 'the saved quote is on the posting')
    assert.equal(r!.event_date, POSTED); assert.equal(r!.event_date_proof, 'ats_structured')
  })
}
test('runner: a preamble-only posting yields no careers evidence (quote_too_short), so no lead is made from it', async () => {
  const x = await run('ashby', PREAMBLE + 'ABOUT YOU\n\n - You are located in India.')
  assert.deepEqual(x.src, { status: 'partial', evidence: 0 }, 'the careers source ran, skipped the posting (quote_too_short) and gave no evidence')
  assert.equal(x.rows.filter(r => r.source_url === ASHBY).length, 0)
})
