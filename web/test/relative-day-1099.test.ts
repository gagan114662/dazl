// #1099 (matrix holds, Hermes 20:50): on main every real matrix lead but one was held "needs your review". 11 of 20 were outside_window_undated:
// the model proposed a day, and the date binding (#460) rightly refused a byline as the event's day. One of them, a real one, said its own day:
// "German packaging and bottling equipment major Krones on Wednesday inaugurated its new manufacturing facility" on a page published Wednesday
// 2026-08-19. relativeEventDay (lib/scan/page-timing.ts) resolves that weekday from the publication day; the publication day alone still dates nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { relativeEventDay } from '../lib/scan/page-timing.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob, listLeads } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'

const KRONES = 'German packaging and bottling equipment major Krones on Wednesday inaugurated its new manufacturing facility at Vemagal Industrial Area'

test('a weekday, "today" or "yesterday" in the quote is counted back from the page\'s own publication day', () => {
  assert.equal(relativeEventDay(KRONES, 'Krones', '2026-08-19')?.day, '2026-08-19', 'published on the Wednesday itself')
  assert.equal(relativeEventDay(KRONES, 'Krones', '2026-08-21')?.day, '2026-08-19', 'published the Friday after: that same week\'s Wednesday')
  assert.equal(relativeEventDay(KRONES, 'Krones', '2026-08-18')?.day, '2026-08-12', 'published on a Tuesday: the Wednesday before, never after publication')
  assert.equal(relativeEventDay('Acme Dental today opened its second clinic in Toronto', 'Acme Dental', '2026-10-05')?.day, '2026-10-05')
  assert.equal(relativeEventDay('Acme Dental yesterday opened its second clinic in Toronto', 'Acme Dental', '2026-10-01')?.day, '2026-09-30', 'across a month boundary')
  assert.match(relativeEventDay(KRONES, 'Krones', '2026-08-19')!.why, /"on Wednesday" in the evidence sentence naming this company, counted from the page's own publication day 2026-08-19/)
})

test('nothing is dated without a stated relative day, a publication day, the company in the quote, or a past event', () => {
  assert.equal(relativeEventDay('Integral, a Berlin-based startup, has closed an €18 million Series A round', 'Integral', '2026-09-16'), null, 'a byline alone dates nothing (#460 stands)')
  assert.equal(relativeEventDay(KRONES, 'Krones', null), null, 'no publication day')
  assert.equal(relativeEventDay(KRONES, 'Krones', 'Aug 19'), null, 'a malformed publication day')
  assert.equal(relativeEventDay('The minister on Wednesday inaugurated a new facility', 'Krones', '2026-08-19'), null, 'the quote does not name the company')
  for (const q of ['Krones will on Wednesday open its new facility', 'Krones plans to open on Friday', 'Krones is set to open on Friday', 'Krones is preparing to open on Friday', 'Krones opens next week, on Friday', 'Krones is expected to open on Friday'])
    assert.equal(relativeEventDay(q, 'Krones', '2026-08-19'), null, `a future or planned event: ${q}`)
  assert.equal(relativeEventDay('Krones last Wednesday inaugurated its facility', 'Krones', '2026-08-19'), null, '"last Wednesday" does not settle the week')
  assert.equal(relativeEventDay('Krones inaugurated its facility this week', 'Krones', '2026-08-19'), null, '"this week" is not a day')
})

// Through the real runner (stubbed model and page, the careers-runner-dates pattern): the claimed byline day is refused by the binding as before,
// and the weekday in the quote then dates the lead page_bound, so the window rule sees a date and the lead is not outside_window_undated.
async function run(o: { quote: string; claimed: string | null; published: string | null; pageText: string }) {
  const master = randomBytes(32)
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const icp = JSON.stringify({ summary: 'x', who: [], industries: ['Manufacturing'], sizes: [], where: ['Bangalore, India'], signals: ['opened a new plant'], exclude: [], window_days: 365 })
  const id = createQueryJob(db, 'A', { query: 'Manufacturing firms in Bangalore, India that opened a new plant in the last 365 days', icp } as never)
  const URL_ = 'https://news.example/krones-opens-plant'
  const cand = { name: '', company: 'Krones', contact: null, signal: 'inaugurated a new manufacturing facility near Bengaluru', score: 85, source_url: URL_, excerpt: o.quote, event_date: o.claimed }
  const prov = {
    anthropic: { research: async () => ({ text: JSON.stringify([cand]), citedUrls: [URL_] }), complete: async (_k: string, p: string) => (p.startsWith('You check one claim') ? 'supports' : JSON.stringify([cand])) },
    openai: { research: async () => ({ text: '[]', citedUrls: [] }), complete: async () => '[]' },
  }
  const http = async (url: string) => { const u = new URL(url); if (u.hostname === 'hn.algolia.com') return null; return { status: 404, body: '' } }
  const page = async () => ({ text: o.pageText, title: 'Krones opens plant', retrievedAt: Math.floor(Date.now() / 1000), ...(o.published ? { published: o.published } : {}) })
  await runJob(db, claimKeyedJob(db, id)!, { providers: prov as never, master, fetchPage: page as never, sourceHttp: http as never, crawlGet: async () => null, score: false, now: new Date('2026-09-01T12:00:00Z') })
  return listLeads(db, 'A', id, 200, true) as unknown as { company: string; event_date: string | null; event_date_proof: string | null; event_date_proof_note: string | null; review_reason: string | null; date_basis?: string | null }[]
}
const pageText = (q: string) => `Krones opens Rs 315-crore bottling machinery plant near Bengaluru Rakesh Prakash / Aug 19, 2026, 16:57 IST Bengaluru: ${q}, marking the company's latest expansion in India.`

test('through the runner: the weekday in the quote dates the lead page_bound (it was outside_window_undated)', async () => {
  const rows = await run({ quote: KRONES, claimed: '2026-08-19', published: '2026-08-19', pageText: pageText(KRONES) })
  const k = rows.find(r => r.company === 'Krones')
  assert.ok(k, `the lead was stored: ${JSON.stringify(rows)}`)
  assert.equal(k!.event_date, '2026-08-19'); assert.equal(k!.event_date_proof, 'page_bound')
  assert.match(k!.event_date_proof_note ?? '', /"on Wednesday" in the evidence sentence/)
  assert.notEqual(k!.review_reason, 'outside_window_undated')
})

test('through the runner: without the weekday the byline dates the page as an ANNOUNCEMENT only (labelled), never as the event day', async () => {
  // Hermes decision 15 Nov (announcement-date.ts): the page that announces a completed event dates the announcement, with date_basis 'announcement_dateline'
  const q = 'German packaging and bottling equipment major Krones inaugurated its new manufacturing facility at Vemagal Industrial Area'
  const rows = await run({ quote: q, claimed: '2026-08-19', published: '2026-08-19', pageText: pageText(q) })
  const k = rows.find(r => r.company === 'Krones') as unknown as { event_date: string | null; date_basis: string | null; event_date_proof_note: string | null }
  assert.ok(k, JSON.stringify(rows)); assert.equal(k.event_date, '2026-08-19'); assert.equal(k.date_basis, 'announcement_dateline')
  assert.match(k.event_date_proof_note ?? '', /^announced 2026-08-19/)
  // the weekday version is the event's own day, not an announcement: no announcement basis
  const withDay = (await run({ quote: KRONES, claimed: '2026-08-19', published: '2026-08-19', pageText: pageText(KRONES) })).find(r => r.company === 'Krones') as unknown as { date_basis: string | null }
  assert.equal(withDay.date_basis, null)
})
