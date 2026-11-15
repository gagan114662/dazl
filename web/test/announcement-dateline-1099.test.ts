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
  assert.equal(f.day, '2026-10-12'); assert.match(f.why, /^announced 2026-10-12: the publication day of the page that announces this funding/)
  assert.match(f.why, /the event happened on or before it/); assert.match(f.why, /this funding/)
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
  assert.match(announcementDatelineDay({ ...FINMID, title: 'Top 10 fintech rounds: finmid, Pliant and more' }).why, /roundup page, not the announcement/)
  assert.match(announcementDatelineDay({ ...FINMID, title: 'finmid weekly funding roundup' }).why, /roundup page, not the announcement/)
  // review of the branch (R1, R2, R7): a profile or interview page, a recap, the wrong kind of event, and a partial-word company never get the story's day
  assert.match(announcementDatelineDay({ ...FINMID, title: 'finmid company profile' }).why, /profile, directory/)
  assert.match(announcementDatelineDay({ ...FINMID, title: 'finmid CEO interview' }).why, /interview/)
  assert.match(announcementDatelineDay({ ...FINMID, title: 'finmid launches card product' }).why, /title does not announce this funding/, 'a story about something else that mentions the round')
  assert.match(announcementDatelineDay({ ...FINMID, quote: 'finmid, which previously raised €17m, hired a CFO', pageText: `finmid, which previously raised €17m, hired a CFO. ${FINMID.pageText}` }).why, /not stated by the company itself/)
  assert.match(announcementDatelineDay({ ...FINMID, company: 'Pliant', title: 'Pliant CEO interview', quote: 'Pliant, which raised €40m, talks about cards', pageText: 'Pliant, which raised €40m, talks about cards.' }).why, /interview/)
  assert.match(announcementDatelineDay({ ...FINMID, company: 'mika', title: 'Mikael Andersen named CEO of Nordea' }).why, /title does not name the company/, 'the company as a whole word')
  assert.match(announcementDatelineDay({ ...FINMID, company: 'finmid', quote: 'finmid was acquired by Banco Example', title: 'finmid acquired by Banco Example', pageText: 'finmid was acquired by Banco Example. The deal closed.' }).why, /not stated by the company itself/, 'a passive event: the company is not its subject')
  for (const q of ['finmid will raise €17m in a Series A extension', 'finmid plans to raise €17m', 'finmid is set to close a €17m round', 'finmid is expected to raise €17m', 'finmid is in talks to raise €17m'])
    assert.match(announcementDatelineDay({ ...FINMID, quote: q, pageText: `${FINMID.pageText} ${q}.` }).why, /plan or future event/, q)
  assert.match(announcementDatelineDay({ ...FINMID, quote: 'finmid, a Berlin-based fintech company, offers payment terms to platforms', pageText: `finmid, a Berlin-based fintech company, offers payment terms to platforms. ${FINMID.pageText}` }).why, /no completed event/)
  assert.match(announcementDatelineDay({ ...FINMID, quote: 'finmid opened a plant with 2,026 employees', title: 'finmid opens a new plant', pageText: 'finmid opened a plant with 2,026 employees. More.' }).why, /^announced/, '"plant" and "2,026" are not a plan or a year (R9)')
  assert.match(announcementDatelineDay({ ...FINMID, quote: 'a Berlin-based fintech company raised €17m in a round' }).why, /quote does not name the company/)
  assert.match(announcementDatelineDay({ ...FINMID, pageText: 'x '.repeat(1400) + FINMID.pageText }).why, /does not open the story/, 'a mention deep in a long page is not the announcement')
})

test('limit 2: the day is the page\'s own, and a page that contradicts it is held', () => {
  assert.match(announcementDatelineDay({ ...FINMID, published: null }).why, /no machine-readable publication day/)
  assert.match(announcementDatelineDay({ ...FINMID, published: 'October 12' }).why, /no machine-readable publication day/)
  assert.match(announcementDatelineDay({ ...FINMID, structured: [JSON.stringify({ '@type': 'NewsArticle', datePublished: '2026-10-20' })] }).why, /gives datePublished 2026-10-20, not 2026-10-12/, 'a LATER conflicting date holds too')
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

test('through the runner: a hiring lead is never dated by the dateline (a posting is dated by its board)', async () => {
  const q = 'finmid, a Berlin, Germany-based fintech company, hired a Head of Sales'
  const k = await run({ quote: q, claimed: null, title: 'finmid hires a Head of Sales', pageText: `finmid hires a Head of Sales By FinSMEs - October 12, 2026 Facebook Twitter finmid , a Berlin, Germany-based fintech company, hired a Head of Sales.`, published: '2026-10-12', signal: 'is hiring a Head of Sales' })
  assert.ok(k); assert.equal(k!.date_basis, null); assert.equal(k!.event_date, null)
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

// Review of the branch (R4): every surface that shows the date says "announced", never "the event happened then" or "event day verified".
test('the label reaches the card, the opportunity facts, the CSV export read and the outreach provenance read', async () => {
  const { cardDate } = await import('../lib/scan/lead-card.ts')
  assert.equal(cardDate('2026-10-12', null, { basis: 'announcement_dateline', dayVerified: true }), 'announced 12 Oct 2026')
  assert.match(cardDate('2026-10-12', null, { dayVerified: true }), /verified on the cited source/, 'any other basis is unchanged')
  const { opportunityCard } = await import('../lib/scan/opportunity.ts')
  const lead = { id: 'a'.repeat(24), company: 'finmid', signal: 'raised a Series A extension', source_url: 'https://news.example/finmid', evidence_excerpt: FINMID_Q, event_date: '2026-10-12', date_status: 'verified',
    review_reason: null, fit: 5, intent: 0, why: 'x', confidence: 90, human_confirmed_at: 1, icp_match: null, company_domain: null, contact: null, currentness_held: false, window_held: false, enrichments: [],
    timing: 'proof_backed', day_verified: true, date_basis: 'announcement_dateline' }
  const facts = JSON.stringify(opportunityCard(lead as never, '', new Date('2026-11-01T00:00:00Z')))
  assert.match(facts, /The page announcing it was published 2026-10-12; the event happened on or before that day/)
  assert.doesNotMatch(facts, /dates the event to 2026-10-12/)
  // the export and provenance reads carry date_basis from the store
  const { migrateOutreach } = await import('../lib/outreach/store.ts')
  const { migrateConnectors } = await import('../lib/connectors/store.ts')
  const { exportLeads, createJob } = await import('../lib/scan/store.ts')
  const { messageProvenance } = await import('../lib/outreach/provenance.ts')
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'Seller', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(job)
  db.prepare("INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, event_date, event_date_proof, date_basis, confidence) VALUES ('L', ?, 'finmid', 'hello@finmid.example', 'raised', 'https://news.example/finmid', ?, '2026-10-12', 'page_bound', 'announcement_dateline', 90)").run(job, FINMID_Q)
  const row = (exportLeads(db, 'A', job) as { date_basis?: string | null }[])[0]
  assert.equal(row?.date_basis, 'announcement_dateline', 'the CSV export reads the basis')
  assert.equal(messageProvenance(db, 'A', 'L', 'hello@finmid.example')?.date_basis, 'announcement_dateline', 'the outreach provenance reads the basis')
  assert.match(eventDateCopy('2026-10-12', null, undefined, { basis: 'announcement_dateline' }), /^announced 2026-10-12/)
})
