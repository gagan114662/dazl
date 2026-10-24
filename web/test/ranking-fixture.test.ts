import { migrateConnectors } from '../lib/connectors/store.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, listLeads } from '../lib/scan/store.ts'
import { migrateEvents, eventsForLeads } from '../lib/events/store.ts'
import { leadPriorities, rankLeads } from '../lib/events/prioritize.ts'
import { createRankingFixture, RANKING_FIXTURE_JOB } from '../lib/scan/ranking-fixture.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateSequences } from '../lib/outreach/sequences.ts'
import { TEST_INBOX } from '../lib/outreach/service.ts'

const TENANT = 'test-tenant-ranking'

function db() {
  const d = new Database(':memory:')
  migrateScan(d); migrateEvents(d); migrateOutreach(d); migrateConnectors(d); migrateSequences(d)
  d.prepare("INSERT INTO sequence_settings (tenant_id, test_addresses) VALUES (?, ?)").run(TENANT, JSON.stringify([TEST_INBOX]))
  return d
}

function withTenant<T>(fn: () => T): T {
  process.env.OUTREACH_TEST_TENANT_ID = TENANT
  try { return fn() } finally { delete process.env.OUTREACH_TEST_TENANT_ID }
}

test('fixture is gated to the designated tenant with the allowlisted inbox', () => {
  const d = db()
  delete process.env.OUTREACH_TEST_TENANT_ID
  assert.throws(() => createRankingFixture(d, TENANT), /test_tenant_only/)
  process.env.OUTREACH_TEST_TENANT_ID = 'someone-else'
  assert.throws(() => createRankingFixture(d, TENANT), /test_tenant_only/)
})

test('fixture creates 3 labelled leads + 2 events, and the live ranking order matches the fixture claim', () => {
  const d = db()
  const r = withTenant(() => createRankingFixture(d, TENANT))
  assert.equal(r.created, true)
  // idempotent
  const r2 = withTenant(() => createRankingFixture(d, TENANT))
  assert.equal(r2.created, false)
  assert.equal(r2.jobId, r.jobId)

  const leads = listLeads(d, TENANT, r.jobId, 200, false) as { id: string; company: string; contact: string | null; signal: string; source_url: string; company_domain: string | null; fit: number | null; intent: number | null; action: number | null; score: number }[]
  assert.equal(leads.length, 3)
  // every row visibly test-only, no contact, no real source
  for (const l of leads) {
    assert.match(l.company, /\(test only\)/)
    assert.equal(l.contact, null)
    assert.match(l.signal, /did not find, scrape or verify/)
    assert.match(l.source_url, /test-only-ranking-fixture/)
  }
  const evts = eventsForLeads(d, TENANT, leads)
  const pri = leadPriorities(d, TENANT, leads, evts)
  const ranked = rankLeads(leads, pri)
  assert.deepEqual(ranked.map(l => l.company), [
    'dazl ranking fixture A (test only)', // fit 5 beats B's evidence
    'dazl ranking fixture B (test only)', // fit 4 + evidence beats C
    'dazl ranking fixture C (test only)',
  ])
  const b = ranked[1]
  assert.equal(pri[b.id].evidence_score, 0) // synthetic publication days are not event-time proof
  assert.equal(pri[ranked[0].id].evidence_score, 0)
  // no outreach rows created
  assert.equal((d.prepare('SELECT COUNT(*) n FROM outreach_messages').get() as { n: number }).n, 0)
})
