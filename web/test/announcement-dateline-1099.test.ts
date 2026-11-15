// #1099 (Hermes decision 15 Nov 00:50, reversing #460 only in this labelled form): the page that announces a completed event dates the ANNOUNCEMENT by its own
// publication day (lib/scan/announcement-date.ts). Shapes from the real main-matrix sample of 14 Nov (berlin-fintech: mika, Integral, finmid, all held undated).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { announcementDatelineDay, DATE_BASIS_DATELINE } from '../lib/scan/announcement-date.ts'
import { eventDateCopy } from '../lib/scan/date-copy.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob, listLeads } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'

const FINMID_Q = 'finmid, a Berlin, Germany-based fintech company, raised €17m in a Series A extension funding round'
const FINMID = { quote: FINMID_Q, company: 'finmid', title: 'finmid Raises €17M in Series A Extension Funding', published: '2026-10-12',
  pageText: `finmid Raises €17M in Series A Extension Funding By FinSMEs - October 12, 2026 Facebook Twitter finmid , a Berlin, Germany-based fintech company, raised €17m in a Series A extension funding round. The round, which brought total funding raised to date to €52m, saw the participation of existing investors.` }

test('the real Berlin shapes: the announcing page dates the announcement, labelled as such', () => {
  const f = announcementDatelineDay(FINMID)
  assert.equal(f.day, '2026-10-12'); assert.match(f.why, /^announced 2026-10-12: the publication day of the page that announces this event/)
  assert.match(f.why, /the event happened on or before it/)
  const integral = announcementDatelineDay({ company: 'Integral', title: "Berlin's Integral Closes €18M Series A to Build AI-Native Accounting Firm", published: '2026-09-16',
    quote: 'Integral, a Berlin-based startup offering accounting, tax, and payroll as a managed service rather than software, has closed an €18 million Series A round',
    pageText: "Berlin's Integral Closes €18M Series A 16/09/2026 Fintech News # Integral, a Berlin-based startup offering accounting, tax, and payroll as a managed service rather than software, has closed an €18 million Series A round. The raise was co-led by Reid Hoffman." })
  assert.equal(integral.day, '2026-09-16')
  const mika = announcementDatelineDay({ company: 'mika', title: 'mika erhält 6 Millionen Euro für KI-native Buchhaltung | Startbase', published: '2026-09-23',
    quote: 'Das Berliner FinTech mika hat sechs Millionen Euro in einer Seed-Finanzierungsrunde eingesammelt',
    pageText: 'News von Marc Nemitz Berlin, 23. September 2026 Das Berliner FinTech mika hat sechs Millionen Euro in einer Seed-Finanzierungsrunde eingesammelt. Angeführt wird die Runde vom Investor Smedvig Ventures.' })
  assert.equal(mika.day, '2026-09-23', 'a German announcement')
  assert.equal(DATE_BASIS_DATELINE, 'announcement_dateline')
})

test('limit 1: only the page that IS the announcement of a completed event', () => {
  assert.match(announcementDatelineDay({ ...FINMID, title: 'Fintech news this week' }).why, /title does not name the company/)
  assert.match(announcementDatelineDay({ ...FINMID, title: 'Top 10 fintech rounds: finmid, Pliant and more' }).why, /roundup or digest/)
  assert.match(announcementDatelineDay({ ...FINMID, title: 'finmid weekly funding roundup' }).why, /roundup or digest/)
  for (const q of ['finmid will raise €17m in a Series A extension', 'finmid plans to raise €17m', 'finmid is set to close a €17m round', 'finmid is expected to raise €17m', 'finmid is in talks to raise €17m'])
    assert.match(announcementDatelineDay({ ...FINMID, quote: q, pageText: `${FINMID.pageText} ${q}.` }).why, /plan or future event/, q)
  assert.match(announcementDatelineDay({ ...FINMID, quote: 'finmid, a Berlin-based fintech company, offers payment terms to platforms', pageText: `finmid, a Berlin-based fintech company, offers payment terms to platforms. ${FINMID.pageText}` }).why, /no completed event/)
  assert.match(announcementDatelineDay({ ...FINMID, quote: 'a Berlin-based fintech company raised €17m in a round' }).why, /quote does not name the company/)
  assert.match(announcementDatelineDay({ ...FINMID, pageText: 'x '.repeat(1400) + FINMID.pageText }).why, /does not open the story/, 'a mention deep in a long page is not the announcement')
})

test('limit 2: the day is the page\'s own, and a page that contradicts it is held', () => {
  assert.match(announcementDatelineDay({ ...FINMID, published: null }).why, /no publication day/)
  assert.match(announcementDatelineDay({ ...FINMID, published: 'October 12' }).why, /no publication day/)
  assert.match(announcementDatelineDay({ ...FINMID, pageText: FINMID.pageText.replace('October 12, 2026', 'October 12, 2026 (updated October 14, 2026)') }).why, /the page also prints 2026-10-14/)
  assert.match(announcementDatelineDay({ ...FINMID, structured: [JSON.stringify({ '@type': 'NewsArticle', datePublished: '2026-10-12', dateCreated: '2026-06-01' })] }).why, /earlier dateCreated 2026-06-01/)
})

test('limit 3: a quote that states its own day or period is never given the story\'s day', () => {
  for (const q of ['finmid raised €17m in March', 'finmid raised €17m in Q1', 'finmid raised €17m last year', 'finmid raised €17m in 2025', 'finmid recently raised €17m', 'finmid raised €17m earlier this month', 'finmid raised €17m on 2026-10-01', 'finmid raised €17m this summer'])
    assert.match(announcementDatelineDay({ ...FINMID, quote: q, pageText: `${q}. ${FINMID.pageText}` }).why, /states its own day or period/, q)
})

test('limit 4: the copy says "announced <date>", never that the event happened then', () => {
  const s = eventDateCopy('2026-10-12', null, 'proof_backed', { basis: 'announcement_dateline' })
  assert.match(s, /^announced 2026-10-12 \(the publication day of the page announcing it; the event happened on or before it - current need unconfirmed\)$/)
  assert.doesNotMatch(s, /event day verified/)
  assert.match(eventDateCopy('2026-10-12', null, 'proof_backed', { basis: 'announcement_dateline', windowMissed: true }), /outside the requested recency window/)
  assert.match(eventDateCopy('2026-10-12', null, 'proof_backed'), /event day verified/, 'any other basis is unchanged')
})

// Through the real runner (stubbed model and page): the lead is stored with the announcement's day, page_bound, and date_basis 'announcement_dateline'.
async function run(o: { quote: string; claimed: string | null; title: string; pageText: string; published: string | null; signal?: string }) {
  const master = randomBytes(32)
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const icp = JSON.stringify({ summary: 'x', who: [], industries: ['Fintech'], sizes: [], where: ['Berlin, Germany'], signals: ['raised a funding round'], exclude: [], window_days: 365 })
  const id = createQueryJob(db, 'A', { query: 'Fintech startups in Berlin, Germany that raised a funding round in the last 365 days', icp } as never)
  const URL_ = 'https://news.example/finmid-raises'
  const cand = { name: '', company: 'finmid', contact: null, signal: o.signal ?? 'raised a €17m Series A extension', score: 85, source_url: URL_, excerpt: o.quote, event_date: o.claimed }
  const prov = {
    anthropic: { research: async () => ({ text: JSON.stringify([cand]), citedUrls: [URL_] }), complete: async (_k: string, p: string) => (p.startsWith('You check one claim') ? 'supports' : JSON.stringify([cand])) },
    openai: { research: async () => ({ text: '[]', citedUrls: [] }), complete: async () => '[]' },
  }
  const http = async (url: string) => { const u = new URL(url); if (u.hostname === 'hn.algolia.com') return null; return { status: 404, body: '' } }
  const page = async () => ({ text: o.pageText, title: o.title, retrievedAt: Math.floor(Date.now() / 1000), ...(o.published ? { published: o.published } : {}) })
  await runJob(db, claimKeyedJob(db, id)!, { providers: prov as never, master, fetchPage: page as never, sourceHttp: http as never, crawlGet: async () => null, score: false, now: new Date('2026-11-01T12:00:00Z') })
  return (listLeads(db, 'A', id, 200, true) as unknown as { company: string; event_date: string | null; event_date_proof: string | null; event_date_proof_note: string | null; date_basis: string | null; review_reason: string | null }[]).find(r => r.company === 'finmid')
}

test('through the runner: the byline-dated announcement is stored with the announcement day and its labelled basis', async () => {
  const k = await run({ quote: FINMID_Q, claimed: '2026-10-12', title: FINMID.title, pageText: FINMID.pageText, published: '2026-10-12' })
  assert.ok(k, 'the lead was stored')
  assert.equal(k!.event_date, '2026-10-12'); assert.equal(k!.event_date_proof, 'page_bound'); assert.equal(k!.date_basis, 'announcement_dateline')
  assert.match(k!.event_date_proof_note ?? '', /^announced 2026-10-12/)
  assert.notEqual(k!.review_reason, 'outside_window_undated')
})

test('through the runner: a quote with its own period, a plan, or a page that is not the announcement stays undated', async () => {
  const inMarch = 'finmid, a Berlin, Germany-based fintech company, raised €17m in March in a Series A extension funding round'
  const a = await run({ quote: inMarch, claimed: '2026-10-12', title: FINMID.title, pageText: `finmid Raises €17M in Series A Extension Funding By FinSMEs - October 12, 2026 Facebook Twitter finmid , a Berlin, Germany-based fintech company, raised €17m in March in a Series A extension funding round. The round brought total funding to €52m.`, published: '2026-10-12' })
  assert.equal(a!.event_date, null); assert.equal(a!.date_basis, null); assert.equal(a!.review_reason, 'outside_window_undated')
  const b = await run({ quote: FINMID_Q, claimed: '2026-10-12', title: 'Berlin fintech news', pageText: FINMID.pageText, published: '2026-10-12' })
  assert.equal(b!.event_date, null); assert.equal(b!.date_basis, null)
  const c = await run({ quote: FINMID_Q, claimed: '2026-10-12', title: FINMID.title, pageText: FINMID.pageText, published: null })
  assert.equal(c!.event_date, null, 'no publication day of its own: nothing to date it by')
})
