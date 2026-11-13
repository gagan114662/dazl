// #767 (Hermes-PC review at 41a445fa, finding 2): careers evidence feeds boardDates, the trusted structured-date input to verifyLeads (the date gate).
// End to end through the real runner (runJob -> collectEvidenceReport -> careers adapter -> verifyLeads) with stubbed providers and stubbed HTTP: invented
// company "Brightloop", no network, no model. Local fixture, not live proof.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob, listLeads } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { careersAdapter } from '../lib/sources/careers.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const master = randomBytes(32)
const ago = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
const POSTED = ago(9)
const LEVER = 'https://jobs.lever.co/brightloop/abc-123'
const OWN = 'https://brightloop.io/careers/ae'
const DESC = 'Brightloop is hiring an Account Executive to own the sales cycle end to end.'
const OWN_TEXT = 'Join Brightloop in London as Account Executive - London and own the full sales cycle.'
const html = (b: string) => `<html><body>${b}</body></html>`

// The company's site (robots.txt 404 = no policy). Its careers page links either to a public Lever posting (read through api.lever.co, dated by createdAt)
// or to its own job page (undated).
const http = (link: 'lever' | 'own'): SafeGet => async url => {
  const u = new URL(url)
  if (u.hostname === 'hn.algolia.com') return null
  if (u.hostname === 'api.lever.co') return { status: 200, body: JSON.stringify({ text: 'Account Executive', descriptionPlain: DESC, createdAt: Date.parse(`${POSTED}T09:00:00Z`) }) }
  if (u.hostname === 'brightloop.io' && u.pathname === '/careers') return { status: 200, body: html(link === 'lever' ? `<ul><li><a href="${LEVER}">Account Executive</a></li></ul>` : '<h2>Open roles</h2><ul><li><a href="/careers/ae">Account Executive - London</a> <a href="/careers/ae">Apply</a></li></ul>') }
  if (link === 'own' && url === OWN) return { status: 200, body: html(`<h1>Account Executive - London</h1><p>${OWN_TEXT}</p><a href="/careers/apply">Apply</a>`) }
  return { status: 404, body: '' }
}
type Row = { source_url: string; event_date: string | null; event_date_proof: string | null; review_reason: string | null }

async function run(o: { http: SafeGet; lead: { source_url: string; excerpt: string; event_date: string | null }; page: { text: string; postedAt?: string } }) {
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const icp = JSON.stringify({ summary: 'x', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] })
  const id = createQueryJob(db, 'A', { query: 'London B2B SaaS startups hiring sales staff', icp, sources: JSON.stringify({ adapters: ['careers'], pages: ['https://brightloop.io'] }) } as never)
  const prompts: string[] = []
  const cand = { name: '', company: 'Brightloop', contact: null, signal: 'hiring an Account Executive', score: 85, ...o.lead }
  const prov = {
    anthropic: { research: async () => ({ text: '[]', citedUrls: [] }), complete: async (_k: string, p: string) => { prompts.push(p); return p.startsWith('You check one claim') ? 'supports' : JSON.stringify([cand]) } },
    openai: { research: async () => ({ text: '[]', citedUrls: [] }), complete: async () => '[]' },
  }
  // the verifier's own fetch of the cited page: the posting text, never a date in it (so only a structured date can date the lead)
  const page = async () => ({ text: o.page.text, title: 'Brightloop jobs', retrievedAt: Math.floor(Date.now() / 1000), ...(o.page.postedAt ? { postedAt: o.page.postedAt } : {}) })
  const res = await runJob(db, claimKeyedJob(db, id)!, { providers: prov as never, master, fetchPage: page as never, sourceHttp: o.http, crawlGet: async () => null, score: false, now: new Date() })
  const run_ = db.prepare("SELECT status, evidence_count AS evidence FROM scan_source_runs WHERE collector = 'adapter:careers'").get() as { status: string; evidence: number } | undefined
  return { res, run: run_, prompts, rows: listLeads(db, 'A', id) as unknown as Row[] }
}

test('(a) a careers item from a public Lever posting, carrying the board\'s own publish date, dates the lead with that date (ats_structured)', async () => {
  const x = await run({ http: http('lever'), lead: { source_url: LEVER, excerpt: DESC, event_date: POSTED }, page: { text: `Account Executive\n${DESC} Apply today.` } })
  assert.equal(x.res, 'done'); assert.deepEqual(x.run, { status: 'ok', evidence: 1 })
  assert.ok(x.prompts.some(p => p.includes('"source":"careers"') && p.includes(POSTED)), 'the careers evidence (with its date) reached extraction')
  const r = x.rows.find(r => r.source_url === LEVER)
  assert.ok(r, `the posting became a lead: ${JSON.stringify(x.rows)}`)
  assert.equal(r!.event_date, POSTED, 'dated by the board\'s own publish date')
  assert.equal(r!.event_date_proof, 'ats_structured', 'the proof is the structured posting date, not the page text (which states no date)')
})

test('(b) an own-domain careers item (date null) adds no structured date: a claimed retrieval-day date is not trusted and the lead is undated', async () => {
  const today = ago(0)
  const x = await run({ http: http('own'), lead: { source_url: OWN, excerpt: OWN_TEXT, event_date: today }, page: { text: `Account Executive - London\n${OWN_TEXT} Apply today.` } })
  assert.equal(x.res, 'done'); assert.deepEqual(x.run, { status: 'ok', evidence: 1 })
  assert.ok(x.prompts.some(p => p.includes('"source":"careers"') && p.includes(OWN)), 'the careers evidence reached extraction')
  const r = x.rows.find(r => r.source_url === OWN)
  assert.ok(r, `the job page became a lead: ${JSON.stringify(x.rows)}`)
  assert.notEqual(r!.event_date, today, 'never dated by the retrieval day'); assert.equal(r!.event_date, null)
  assert.notEqual(r!.event_date_proof, 'ats_structured')
})

test('(c) a careers item whose date is not YYYY-MM-DD is ignored: it neither dates the lead nor shadows the posting\'s own structured day', async () => {
  // The adapter only ever emits YYYY-MM-DD or null, so the runner's own check is exercised with a stubbed adapter emitting a timestamp. The verifier's fetch of the
  // posting carries the board API record's own day (postedAt, #533). An ignored careers date leaves that day in force; a malformed entry in boardDates would mask it.
  const saved = careersAdapter.collect
  careersAdapter.collect = async () => [{ source: 'careers', url: LEVER, title: 'Account Executive - brightloop.io', quote: DESC, date: `${POSTED}T09:00:00Z` }]
  try {
    const x = await run({ http: http('lever'), lead: { source_url: LEVER, excerpt: DESC, event_date: null }, page: { text: `Account Executive\n${DESC} Apply today.`, postedAt: POSTED } })
    assert.equal(x.res, 'done')
    const r = x.rows.find(r => r.source_url === LEVER)
    assert.ok(r, `the posting became a lead: ${JSON.stringify(x.rows)}`)
    assert.equal(r!.event_date, POSTED, 'dated by the posting\'s own structured day, as if the malformed careers date were absent')
    assert.equal(r!.event_date_proof, 'ats_structured')
  } finally { careersAdapter.collect = saved }
})
