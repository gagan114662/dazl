// #1099 re-review (R4, R8/R14): the announcement day is labelled "announced" on the prospect-facing proof preview, the first-run list and the
// timing note, and the evidence recheck re-derives it with the same rule (bound only while the page still gives the same day).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { buildProofPreview, type ProofLeadRow } from '../lib/scan/proof-preview.ts'
import { first5LeadOf } from '../lib/scan/first5.ts'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { evidenceRecheck } from '../lib/scan/evidence-recheck.ts'
import { finishUndatedLeads } from '../lib/scan/structured-date.ts'

const FINMID_Q = 'finmid, a Berlin, Germany-based fintech company, raised €17m in a Series A extension funding round'
const TITLE = 'finmid Raises €17M in Series A Extension Funding'
const TEXT = `${TITLE} By FinSMEs Facebook Twitter finmid , a Berlin, Germany-based fintech company, raised €17m in a Series A extension funding round. The round was led by Example Ventures.`
const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

test('proof preview: a dateline lead carries its basis and every preview page prints "announced <date>"', () => {
  const NOW = Date.UTC(2026, 9, 30)
  const row: ProofLeadRow = { id: 'l1', company: 'finmid', signal: 'raised a €17m Series A extension', source_url: 'https://news.test/finmid', evidence_excerpt: FINMID_Q,
    event_date: '2026-10-12', date_status: 'unverified', event_date_proof: 'page_bound', review_reason: null, quarantined_at: null, evidence_purged_at: null, confidence: 80, score: 70,
    date_basis: 'announcement_dateline' }
  const p = buildProofPreview({ run: { jobId: 'j', tenantId: 't', status: 'done', finishedAt: NOW, spendUsd: 0.1 }, inferredOffer: { text: 'Card issuing for fintechs', sourceUrl: 'https://seller.test/about' }, leads: [row, { ...row, id: 'l2', company: 'Other Co', source_url: 'https://news.test/other', date_basis: null }] }, NOW)
  assert.equal(p.status, 'ready')
  const cos = (p as { companies: { company: string; dateBasis?: string }[] }).companies
  assert.equal(cos.find(c => c.company === 'finmid')!.dateBasis, 'announcement_dateline')
  assert.equal(cos.find(c => c.company === 'Other Co')!.dateBasis, undefined, 'an event-day lead has no basis')
  for (const page of ['../app/preview/[token]/page.tsx', '../app/app/preview/[id]/page.tsx', '../app/preview/claim/page.tsx'])
    assert.match(src(page), /\{co\.dateBasis === 'announcement_dateline' \? 'announced ' : ''\}\{co\.eventDate\}/, page)
  assert.match(src('../lib/scan/proof-preview.ts'), /l\.event_date, l\.date_basis,/, 'the preview read selects the basis')
})

test('first-run list: the basis is read with the lead and the day prints as "announced <day>"', () => {
  const base = { id: 'l1', name: '', company: 'finmid', signal: 's', source_url: 'https://news.test/finmid', event_date: '2026-10-12', published_at: null, fit: 4 }
  assert.equal(first5LeadOf({ ...base, date_basis: 'announcement_dateline' }).date_basis, 'announcement_dateline')
  assert.equal('date_basis' in first5LeadOf({ ...base, date_basis: null }), false, 'no basis, no field')
  assert.match(src('../lib/scan/first5.ts'), /l\.event_date, l\.date_basis,/)
  assert.match(src('../app/app/first-run.tsx'), /l\.date_basis === 'announcement_dateline' \? `announced \$\{day\(l\.event_date\)\}`/)
})

test('timing note: a dateline day is written as "announced <day>", never as "event date"', async () => {
  const l = { company: 'finmid', signal: 'raised a €17m Series A extension', excerpt: FINMID_Q, source_url: 'https://news.test/finmid', event_date: null as string | null,
    event_date_proof: null as string | null, event_date_proof_note: null as string | null, timing_note: null as string | null, date_basis: null as string | null, review_reason: null }
  await finishUndatedLeads([l] as never, (async () => ({ text: TEXT, title: TITLE, published: '2026-10-12', structured: [], retrievedAt: 1 })) as never)
  assert.equal(l.event_date, '2026-10-12'); assert.equal(l.date_basis, 'announcement_dateline')
  assert.match(l.timing_note!, /^announced 2026-10-12: /); assert.doesNotMatch(l.timing_note!, /event date/)
})

test('evidence recheck: a stored dateline day is bound while the page still gives it, and unbound when its publication day changed', async () => {
  const db = new Database(':memory:'); migrateScan(db)
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,sells TEXT,website TEXT)'); db.prepare('INSERT INTO users VALUES(?,?,?)').run('u', 'Card issuing for fintechs', '')
  const job = createQueryJob(db, 'u', { query: 'Fintech startups in Berlin, Germany that raised a funding round in the last 365 days' })
  db.prepare("UPDATE scan_jobs SET status='running',seller=?,offer=?,icp=? WHERE id=?").run('Card issuing for fintechs', 'Card issuing for fintechs',
    JSON.stringify({ summary: 'Berlin fintech', who: [], industries: ['Fintech'], sizes: [], where: ['Berlin', 'Germany'], signals: ['raised a funding round'], exclude: [], window_days: 365 }), job)
  db.prepare('INSERT INTO leads(id,scan_job_id,company,signal,source_url,evidence_excerpt,event_date,event_date_proof,date_basis,review_reason) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'finmid', 'Raised a Series A extension', 'https://news.test/finmid', FINMID_Q, '2026-10-12', 'page_bound', 'announcement_dateline', null)
  const NOW = new Date('2026-10-30T12:00:00Z')
  const page = (published: string) => async () => ({ text: TEXT, title: TITLE, published, structured: [], retrievedAt: 1 })
  const same = await evidenceRecheck(db, 'u', 'L1', page('2026-10-12') as never, NOW)
  assert.equal(same?.status, 'checked'); assert.equal(same?.checks?.event_date_bound, true)
  const moved = await evidenceRecheck(db, 'u', 'L1', page('2026-10-13') as never, NOW)
  assert.equal(moved?.checks?.event_date_bound, false, 'the page now gives another day: the stored one is not re-proven')
})
