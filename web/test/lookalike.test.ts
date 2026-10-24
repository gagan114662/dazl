import { migrateConnectors } from '../lib/connectors/store.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { lookalikeSignals, referenceCohort, tokens, MIN_COHORT } from '../lib/scan/lookalike.ts'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateReplies } from '../lib/outreach/replies.ts'

const TENANT = 'tenant-a'
const OTHER = 'tenant-b'

function db() {
  const d = new Database(':memory:')
  migrateScan(d); migrateOutreach(d); migrateConnectors(d); migrateReplies(d)
  return d
}

function addJob(d: Database.Database, id: string, tenant: string, industry = 'sales tech', location = 'Toronto') {
  d.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, 'co', ?, ?, 'running')").run(id, tenant, industry, location)
}

function addLead(d: Database.Database, id: string, jobId: string, signal: string, fit: number | null, opts: { source_kind?: string; company?: string; contact?: string } = {}) {
  d.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, score, fit, source_kind) VALUES (?, ?, '', ?, ?, ?, 'https://example.com/x', 50, ?, ?)")
    .run(id, jobId, opts.company ?? `Co ${id}`, opts.contact ?? null, signal, fit, opts.source_kind ?? 'search:tinyfish')
}

function seedCohort(d: Database.Database) {
  addJob(d, 'j1', TENANT)
  for (let i = 1; i <= 4; i++) addLead(d, `c${i}`, 'j1', `company hiring sales operations manager for crm administration rollout ${i}`, 4)
}

test('reference cohort is fit-4+/interested leads, excluding test rows, opt-outs, other tenants', () => {
  const d = db()
  seedCohort(d)
  addLead(d, 't1', 'j1', 'synthetic row should never count', 5, { source_kind: 'test' })
  addLead(d, 't2', 'j1', 'labelled test company should never count', 5, { company: 'Acme (test only)' })
  addLead(d, 's1', 'j1', 'opted out contact should never count', 5, { contact: 'opt@example.com' })
  d.prepare("INSERT INTO suppressions (tenant_id, email, reason, created_at) VALUES (?, 'opt@example.com', 'unsubscribe', 1)").run(TENANT)
  addJob(d, 'j9', OTHER); addLead(d, 'o1', 'j9', 'other tenant lead must be invisible', 5)
  addLead(d, 'low', 'j1', 'fit 2 is not cohort', 2)
  const cohort = referenceCohort(d, TENANT, [])
  assert.deepEqual(cohort.map(c => c.id).sort(), ['c1', 'c2', 'c3', 'c4'])
})

test('interested-reply leads join the cohort', () => {
  const d = db()
  addJob(d, 'j1', TENANT)
  addLead(d, 'r1', 'j1', 'ungraded lead with an interested reply', null)
  for (let i = 1; i <= 3; i++) addLead(d, `c${i}`, 'j1', 'plain cohort lead with signal', 4)
  d.prepare("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES ('g1', ?, 'th', 'r1', 'a@b.co', 'sounds good', 'positive', 1)").run(TENANT)
  const ids = referenceCohort(d, TENANT, []).map(c => c.id).sort()
  assert.deepEqual(ids, ['c1', 'c2', 'c3', 'r1'])
})

test('insufficient cohort yields an explicit insufficient state, never a quiet zero', () => {
  const d = db()
  addJob(d, 'j1', TENANT)
  addLead(d, 'c1', 'j1', 'only one past lead', 4)
  const m = lookalikeSignals(d, TENANT, [{ id: 'x', signal: 'anything at all' }])
  const s = m.get('x')!
  assert.equal(s.state, 'insufficient')
  assert.equal(s.cohort_size, 1)
  assert.equal(s.matches, 0)
})

test('scored: keyword/industry/location overlap counted honestly, candidates excluded from cohort', () => {
  const d = db()
  seedCohort(d)
  const m = lookalikeSignals(d, TENANT, [
    { id: 'x', signal: 'company hiring sales operations manager', industry: 'sales tech', location: 'Toronto' },
    { id: 'y', signal: 'unrelated maritime shipping logistics', industry: 'other', location: 'Oslo' },
  ])
  const x = m.get('x')!
  assert.equal(x.state, 'scored')
  assert.equal(x.cohort_size, 4)
  assert.ok(x.matches >= 3, `expected most cohort to match, got ${x.matches}`)
  assert.ok(x.matched_on.includes('signal keywords'))
  assert.ok(x.matched_on.includes('industry'))
  assert.ok(x.matched_on.includes('location'))
  const y = m.get('y')!
  assert.equal(y.matches, 0)
  assert.deepEqual(y.matched_on, [])
})

test('tokens drops stopwords and short words', () => {
  const t = tokens('Hiring sales ops, the team will use CRM tools')
  assert.ok(t.has('hiring') === false) // stopword
  assert.ok(t.has('sales'))
  assert.ok(t.has('tools'))
  assert.ok(!t.has('the'))
})
