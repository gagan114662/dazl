// #1036 live check (Hermes 2026-11-13 18:43Z): on staging the real lead "Benesch" (a law firm, settled site, "Chief Marketing
// Officer" read from its own site) sat under "Needs your review" because the scan found no event date, and there the Leads page
// showed no Find work email until "Keep as research" was clicked. Shape below: that lead's stored rows (person renamed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { reviewLaneWorkEmailTargets } from '../lib/people/work-email-review-lane.ts'

const NOW = Date.parse('2026-11-13T18:40:00Z')
const row = (kind: string, value: string, over: Record<string, unknown> = {}) => ({ connector: 'sitecrawl', kind, value, label: null as string | null, source_url: 'https://www.beneschlaw.example/contact-us/', source_date: '2026-11-13', retrieved_at: Math.floor(NOW / 1000), confidence: null, ...over })
const settled = row('domain', 'beneschlaw.example|evidence_own_domain', { label: 'domain-basis-v1:evidence_own_domain', source_url: 'https://www.beneschlaw.example/' })
const lead = (over: Record<string, unknown> = {}) => ({ id: 'a1'.repeat(12), contact: null, company: 'Benesch', quarantined_at: null, source_kind: 'query', human_confirmed_from: null, review_reason: 'outside_window_undated',
  enrichments: [settled, row('person', 'Jordan Hammond, Chief Marketing Officer')], ...over })
const WHO = 'Chief Marketing Officer; Managing Partner'

test('#1036 a lead still under "Needs your review" offers Find work email for its buyer (no "Keep as research" first)', () => {
  assert.deepEqual(reviewLaneWorkEmailTargets(lead(), WHO, NOW), [{ key: 'Jordan Hammond|Chief Marketing Officer', name: 'Jordan Hammond', title: 'Chief Marketing Officer' }])
  for (const reason of ['outside_window_undated', 'quote_unconfirmed', 'event_timing_unconfirmed', 'source_review_required'])
    assert.equal(reviewLaneWorkEmailTargets(lead({ review_reason: reason }), WHO, NOW).length, 1, reason)
})

test('#1036 review lane: no block for a rejected lead, a non-company row, an unsettled site, a fixture row or a person outside the buyer roles', () => {
  assert.deepEqual(reviewLaneWorkEmailTargets(lead({ quarantined_at: 1 }), WHO, NOW), [])
  for (const reason of ['author_post', 'counterparty_signal']) assert.deepEqual(reviewLaneWorkEmailTargets(lead({ review_reason: reason }), WHO, NOW), [], reason)
  assert.deepEqual(reviewLaneWorkEmailTargets(lead({ source_kind: 'test' }), WHO, NOW), [])
  const guessed = row('domain', 'beneschlaw.example|name_probe', { label: 'domain-basis-v1:name_probe' })
  assert.deepEqual(reviewLaneWorkEmailTargets(lead({ enrichments: [guessed, row('person', 'Jordan Hammond, Chief Marketing Officer')] }), WHO, NOW), [], 'website only guessed from the name')
  assert.deepEqual(reviewLaneWorkEmailTargets(lead({ enrichments: [row('person', 'Jordan Hammond, Chief Marketing Officer')] }), WHO, NOW), [], 'no website recorded')
  assert.deepEqual(reviewLaneWorkEmailTargets(lead({ enrichments: [settled, row('person', 'Brent Richards, General Manager')] }), 'Chief Marketing Officer', NOW), [], 'not a buyer role of this play')
  assert.deepEqual(reviewLaneWorkEmailTargets(lead({ enrichments: [settled] }), WHO, NOW), [])
})

test('#1036 the Leads page renders that block on every "Needs your review" row, with the same component as a decided lead', () => {
  const src = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  const lane = src.slice(src.indexOf('{leads.filter(l => l.review_reason).map(l => ('), src.indexOf('data-testid="review-actions"'))
  assert.match(lane, /reviewLaneWorkEmailTargets\(l, icp && icp\.icp\.who\.length > 0 \? icp\.icp\.who\.join\('; '\) : ''\)/)
  assert.match(lane, /data-testid="review-work-email"><WorkEmail leadId=\{l\.id\} initial=\{workEmailInitial\(l\.id\)\} targets=\{t\} lazy \/>/)
})

// The server side (independent review): the real lookup on a lead still in review, with a stubbed provider. No network.
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { saveCredential } from '../lib/connectors/store.ts'
import { findWorkEmail } from '../lib/people/work-email.ts'

function seeded(reviewReason: string) {
  const db = new Database(':memory:'); migrateAllSqlite(db); const master = randomBytes(32)
  const job = createJob(db, 'A', { business_name: 'Seller', industry: 'legal', location: 'Chicago' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 'Chicago law firms', who: ['Chief Marketing Officer'], where: ['Chicago, IL'], signals: [] }), job)
  const id = 'b2'.repeat(12)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, confidence, review_reason) VALUES (?, ?, '', 'Benesch', 'opened an office', 'https://www.beneschlaw.example/news', 80, ?)").run(id, job, reviewReason)
  const add = (kind: string, value: string, label: string | null, url: string) => db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'sitecrawl', ?, ?, ?, 70, ?, '2026-11-13', ?)").run(randomBytes(12).toString('hex'), id, kind, value, label, url, Math.floor(NOW / 1000))
  add('domain', 'beneschlaw.example|evidence_own_domain', 'domain-basis-v1:evidence_own_domain', 'https://www.beneschlaw.example/')
  add('person', 'Jordan Hammond, Chief Marketing Officer', null, 'https://www.beneschlaw.example/contact-us/')
  saveCredential(db, 'A', 'enrich:apollo', 'test-apollo-key-1234', master)
  return { db, id, master }
}
const apollo = (calls: string[]) => (async (u: RequestInfo | URL) => { calls.push(String(u)); return new Response(JSON.stringify({ person: { name: 'Jordan Hammond', first_name: 'Jordan', last_name: 'Hammond', title: 'Chief Marketing Officer', email: 'jhammond@beneschlaw.example', email_status: 'verified', country: 'United States', organization: { primary_domain: 'beneschlaw.example' } } }), { status: 200 }) }) as typeof fetch

test('#1036 server: Find work email runs on a lead still under review, and the lead stays in review (nothing confirms or drafts it)', async () => {
  const s = seeded('outside_window_undated'); const calls: string[] = []
  const before = s.db.prepare('SELECT review_reason, human_confirmed_at, human_confirmed_from, contact FROM leads WHERE id = ?').get(s.id)
  const r = await findWorkEmail(s.db, 'A', s.id, 'Jordan Hammond|Chief Marketing Officer', { fetchImpl: apollo(calls), master: s.master, now: Math.floor(NOW / 1000) })
  assert.equal(r.status, 'verified', JSON.stringify(r)); assert.equal(calls.length, 1)
  assert.deepEqual(s.db.prepare('SELECT review_reason, human_confirmed_at, human_confirmed_from, contact FROM leads WHERE id = ?').get(s.id), before, 'still in review, no contact stored')
  assert.deepEqual(before, { review_reason: 'outside_window_undated', human_confirmed_at: null, human_confirmed_from: null, contact: null })
})
test('#1036 server: a row held as author_post / counterparty_signal is refused before any provider call (page and server agree)', async () => {
  for (const reason of ['author_post', 'counterparty_signal']) {
    const s = seeded(reason); const calls: string[] = []
    const r = await findWorkEmail(s.db, 'A', s.id, 'Jordan Hammond|Chief Marketing Officer', { fetchImpl: apollo(calls), master: s.master, now: Math.floor(NOW / 1000) })
    assert.equal(r.status, 'not_eligible', reason); assert.deepEqual(calls, [], reason)
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM work_email_lookups').get() as { n: number }).n, 0)
  }
})
