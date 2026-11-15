// #381 (the rrdiag lane on main ac46e456: 4 real scans, 18 saved leads, 0 ready, ALL 18 with confidence NULL): the review-lane INSERT
// hardcoded confidence = NULL and retrieved_at = NULL, so a lead the verifier PASSED and the window gate then moved to review lost its
// confidence, and heldReason (lib/journey.ts) holds it as "source not verified" even after its review reason is cleared. A verified lead now
// keeps the verifier's own confidence, read time and date state; a lead the verifier never passed stays NULL (nothing is invented).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { finishJob, createJob } from '../lib/scan/store-db.ts'
import { sqliteDb } from '../lib/db/client.ts'
import type { Provider } from '../lib/llm/provider.ts'

const NOW = new Date('2026-10-26T12:00:00Z')
const Q = 'Find independent dental practices in New York City that opened a new location in the past 90 days.'
type Row = { company: string; review_reason: string | null; confidence: number | null; retrieved_at: number | null; date_status: string | null }

test('#381 through the runner: verified leads the window gate holds keep the verifier confidence; an unverified review lead stays NULL', async () => {
  const master = randomBytes(32)
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const icp = { summary: 'Independent NYC dental practices that recently expanded', who: ['Practice owner'], industries: ['dental'], sizes: [], where: ['New York City'], signals: ['new location'], exclude: [] }
  const id = createQueryJob(db, 'A', { query: Q, icp: JSON.stringify(icp) } as never)
  const quote = (c: string) => `${c} opened a new practice in Brooklyn`
  const url = (c: string) => `https://news.example/${c.replace(/\s/g, '')}`
  const names = ['Undated Dental', 'Old Smile Dental', 'Ghost Dental']
  const lead = (company: string, date: string | null) => ({ name: '', company, contact: null, signal: 'Opened a new practice', source_url: url(company), excerpt: quote(company), event_date: date, score: 85 })
  const prov: Record<'anthropic' | 'openai', Provider> = {
    anthropic: { research: async () => ({ text: JSON.stringify([lead(names[0], null), lead(names[1], '2026-04-15'), lead(names[2], null)]), citedUrls: names.map(url) }) },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  // Undated Dental: its quote is on its page, no date (held outside_window_undated). Old Smile Dental: quote and an April date (held
  // outside_window). Ghost Dental: its page does not carry the quote (quote_unconfirmed: the verifier never passed it).
  const page = async (u: string) => {
    const n = names.find(x => u === url(x))!
    if (n === 'Ghost Dental') return { text: 'Ghost Dental. Welcome to our practice. Book an appointment today and meet the team.', title: n, retrievedAt: 1_700_000_100 }
    return { text: `News. ${n === 'Old Smile Dental' ? 'On 2026-04-15, ' : ''}${quote(n)}. More.`, title: n, retrievedAt: 1_700_000_100 }
  }
  assert.equal(await runJob(db, claimKeyedJob(db, id)!, { providers: prov, master, fetchPage: page, judge: null, score: false, ground: false, now: NOW }), 'done')
  const rows = db.prepare('SELECT company, review_reason, confidence, retrieved_at, date_status FROM leads WHERE scan_job_id = ? ORDER BY company').all(id) as Row[]
  const by = Object.fromEntries(rows.map(r => [r.company, r]))
  assert.equal(by['Undated Dental'].review_reason, 'outside_window_undated', JSON.stringify(rows))
  assert.ok(typeof by['Undated Dental'].confidence === 'number' && by['Undated Dental'].confidence > 0, `a verified lead held for its date keeps its confidence: ${JSON.stringify(by['Undated Dental'])}`)
  assert.equal(by['Undated Dental'].retrieved_at, 1_700_000_100)
  assert.equal(by['Undated Dental'].date_status, 'undated')
  assert.equal(by['Old Smile Dental'].review_reason, 'outside_window')
  assert.ok(typeof by['Old Smile Dental'].confidence === 'number' && by['Old Smile Dental'].confidence > 0, JSON.stringify(by['Old Smile Dental']))
  // never invented: a lead the verifier did not pass has no confidence, whatever lane it is in
  assert.ok(by['Ghost Dental'], `the unverified lead is kept for review: ${JSON.stringify(rows)}`)
  assert.notEqual(by['Ghost Dental'].review_reason, null)
  assert.deepEqual([by['Ghost Dental'].confidence, by['Ghost Dental'].retrieved_at], [null, null])
})

test('#381 store-db finishJob: a review row with the verifier values keeps them; one without stays NULL (Postgres-ready Db layer)', async () => {
  const raw = new Database(':memory:'); migrateScan(raw)
  const db = sqliteDb(raw)
  const job = await createJob(db, 'A', { business_name: 'B', industry: 'dental', location: 'NYC' })
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?", [job])
  const base = { name: '', signal: 'Opened a new practice', score: 80, evidence_excerpt: 'X opened a new practice in Brooklyn', event_date: null, review_reason: 'outside_window_undated' }
  const r = await finishJob(db, { id: job, attempts: 1 }, { status: 'done', error: null, review: [
    { ...base, company: 'Verified Dental', source_url: 'https://a.example/v', dedup_key: 'v', confidence: 72, retrieved_at: 1_700_000_200, date_status: 'undated' },
    { ...base, company: 'Unverified Dental', source_url: 'https://a.example/u', dedup_key: 'u', review_reason: 'quote_unconfirmed' },
  ] })
  assert.equal(r.owned, true)
  const rows = raw.prepare('SELECT company, confidence, retrieved_at, date_status FROM leads WHERE scan_job_id = ? ORDER BY company').all(job)
  assert.deepEqual(rows, [{ company: 'Unverified Dental', confidence: null, retrieved_at: null, date_status: 'undated' }, { company: 'Verified Dental', confidence: 72, retrieved_at: 1_700_000_200, date_status: 'undated' }])
})
