// #1062 route seam: GET /api/leads (real handler, stubbed session, no network) carries the draft guard's required-gate verdict
// (gate_held), and Home's / the Leads view's one verdict (lib/lead-state.ts heldState via reviewIsActionable) reads it: a lead whose
// required check has not passed is research, never a review item or an opportunity - including one with a reviewable review_reason.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { heldState } from '../../lib/lead-state.ts'
import { previewSplit, type PreviewLead } from '../../lib/journey.ts'
import { reviewAction } from '../../lib/scan/review-action.ts'
import { GET as leadsGET } from '../../app/api/leads/route.ts'

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch

test('#1062 GET /api/leads: gate_held is the draft guard verdict, and Home/Leads count a gate-held lead as research', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  setScanDb(db); setUser({ id: 'A', business_name: 'Acme' })
  const job = 'a'.repeat(24)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, status, candidates, created_at) VALUES (?, 'A', 'x', '(from request)', '-', ?, ?, 'running', 3, 1000)")
    .run(job, 'Find London UK companies hiring sales account executives.', JSON.stringify({ signals: ['hiring sales account executives'] }))
  const add = (id: string, machine: boolean, review: string | null) => db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, review_reason) VALUES (?, ?, ?, 'hiring an account executive', 'https://jobs.example/x', ?, ?, ?)")
    .run(id, job, `Co ${id}`, machine ? 80 : null, machine ? `Co ${id} is hiring an account executive` : null, review)
  const mark = (id: string, kind: string) => db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'scan:gate', ?, 'requested_role_v1', 'gate', 1, 'https://jobs.example/x', '2026-11-01', 1)").run(`${id}-${kind}`, id, kind)
  add('deny', true, null)                                            // DEFAULT-DENY: machine-verified, no pass record
  add('reviewheld', false, 'quote_unconfirmed'); mark('reviewheld', 'gate_failed')   // reviewable reason, failed required check
  add('review', false, 'quote_unconfirmed'); mark('review', 'gate_passed')           // control: ordinary review
  const res = await leadsGET(new NextRequest(`http://test/api/leads?job_id=${job}&all=1`))
  assert.equal(res.status, 200)
  const rows = (await res.json() as { leads: (PreviewLead & { review_reason?: string | null; gate_held?: boolean })[] }).leads
  const by = Object.fromEntries(rows.map(r => [r.id, r]))
  assert.deepEqual([by.deny?.gate_held, by.reviewheld?.gate_held, by.review?.gate_held], [true, true, false], JSON.stringify(rows.map(r => [r.id, r.gate_held])))
  assert.deepEqual(heldState(by.reviewheld), { state: 'research', cause: 'unsupported' }, 'a reviewable reason does not outrank a failed required check')
  assert.deepEqual(heldState(by.review), { state: 'review', cause: null }, 'control')
  assert.equal(reviewAction(by.reviewheld).label, 'Keep as research', 'the Leads review card offers research, never "use it"')
  assert.equal(reviewAction(by.review).label, 'I checked the source - use it', 'control')
  const split = previewSplit(rows)
  assert.deepEqual(split.review.map(l => l.id), ['review'])
  assert.ok(!split.opportunities.some(l => l.id === 'deny'), 'the DEFAULT-DENY lead is never an opportunity')
  assert.deepEqual(split.research.map(r => r.lead.id).sort(), ['deny', 'reviewheld'])
})
