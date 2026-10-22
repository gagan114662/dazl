import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { companyKey, eventsForLeads, listCompanyEvents, migrateEvents, recordCompanyEvent } from '../lib/events/store.ts'

const NOW = 1_800_000_000
const setup = () => { const db = new Database(':memory:'); migrateEvents(db); return db }
const ev = (over: Record<string, unknown> = {}) => ({
  companyKey: 'acme.example', companyName: 'Acme', scope: 'account' as const, leadId: 'lead1',
  eventType: 'funding_round' as const, summary: 'SEC Form D filed 2026-10-01', detail: null,
  sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/2/x.htm', sourcePublishedAt: '2026-10-01',
  retrievedAt: NOW, confidence: 80, ...over,
})

test('records an event with full provenance', () => {
  const db = setup()
  assert.equal(recordCompanyEvent(db, 'T1', ev()), true)
  const rows = listCompanyEvents(db, 'T1', { now: NOW })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source_url, 'https://www.sec.gov/Archives/edgar/data/1/2/x.htm')
  assert.equal(rows[0].source_published_at, '2026-10-01')
  assert.equal(rows[0].first_seen_at, NOW)
  assert.equal(rows[0].fresh, true)
})

test('tenant isolation: other tenants see nothing', () => {
  const db = setup()
  recordCompanyEvent(db, 'T1', ev())
  assert.equal(listCompanyEvents(db, 'T2', { now: NOW }).length, 0)
})

test('dedup: same source refreshes last_seen, keeps first_seen, no duplicate row', () => {
  const db = setup()
  recordCompanyEvent(db, 'T1', ev())
  const created = recordCompanyEvent(db, 'T1', ev({ retrievedAt: NOW + 100 }))
  assert.equal(created, false)
  const rows = listCompanyEvents(db, 'T1', { now: NOW + 100 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].first_seen_at, NOW)
  assert.equal(rows[0].last_seen_at, NOW + 100)
})

test('unknown published date stays NULL', () => {
  const db = setup()
  recordCompanyEvent(db, 'T1', ev({ sourcePublishedAt: null, confidence: null }))
  const rows = listCompanyEvents(db, 'T1', { now: NOW })
  assert.equal(rows[0].source_published_at, null)
  assert.equal(rows[0].confidence, null)
})

test('freshness: hiring_surge goes stale after 30 days, funding_round stays fresh', () => {
  const db = setup()
  recordCompanyEvent(db, 'T1', ev({ eventType: 'hiring_surge', sourceUrl: 'https://jobs.example/board', summary: '5 open roles' }))
  recordCompanyEvent(db, 'T1', ev())
  const later = NOW + 31 * 86400
  const rows = listCompanyEvents(db, 'T1', { now: later })
  const hiring = rows.find(r => r.event_type === 'hiring_surge')!
  const funding = rows.find(r => r.event_type === 'funding_round')!
  assert.equal(hiring.fresh, false)
  assert.equal(funding.fresh, true)
  assert.deepEqual(listCompanyEvents(db, 'T1', { now: later, freshOnly: true }).map(r => r.event_type), ['funding_round'])
})

test('source_url must be http(s), summary capped at 300 chars', () => {
  const db = setup()
  assert.throws(() => recordCompanyEvent(db, 'T1', ev({ sourceUrl: 'not-a-url' })))
  recordCompanyEvent(db, 'T1', ev({ summary: 'x'.repeat(500) }))
  assert.equal(listCompanyEvents(db, 'T1', { now: NOW })[0].summary.length, 300)
})

test('unknown event type rejected; market scope accepted', () => {
  const db = setup()
  assert.throws(() => recordCompanyEvent(db, 'T1', ev({ eventType: 'person_job_change' as never })))
  recordCompanyEvent(db, 'T1', ev({ scope: 'market', leadId: null }))
  assert.equal(listCompanyEvents(db, 'T1', { now: NOW, scope: 'market' }).length, 1)
})

test('companyKey: domain is identity; without one the lead record is, never the name', () => {
  assert.equal(companyKey('https://www.Acme.example/path', 'lead1'), 'acme.example')
  assert.equal(companyKey(null, 'lead1'), 'lead:lead1')
  assert.equal(companyKey(null, null), null)
  assert.equal(companyKey(undefined, undefined), null)
})

test('two distinct same-name companies never share a history', () => {
  const db = setup()
  // "Acme Corp" in two cities, no domain for either: different leads, different keys.
  recordCompanyEvent(db, 'T1', ev({ companyKey: companyKey(null, 'lead-a')!, companyName: 'Acme Corp', leadId: 'lead-a' }))
  recordCompanyEvent(db, 'T1', ev({ companyKey: companyKey(null, 'lead-b')!, companyName: 'Acme Corp', leadId: 'lead-b', sourceUrl: 'https://www.sec.gov/Archives/edgar/data/9/9/y.htm' }))
  const a = listCompanyEvents(db, 'T1', { companyKey: 'lead:lead-a', now: NOW })
  const b = listCompanyEvents(db, 'T1', { companyKey: 'lead:lead-b', now: NOW })
  assert.equal(a.length, 1)
  assert.equal(b.length, 1)
  assert.notEqual(a[0].source_url, b[0].source_url)
  assert.equal(listCompanyEvents(db, 'T1', { now: NOW }).length, 2)
  // Same lead re-observed from the same source still dedups within its own history.
  assert.equal(recordCompanyEvent(db, 'T1', ev({ companyKey: 'lead:lead-a', companyName: 'Acme Corp', leadId: 'lead-a', retrievedAt: NOW + 5 })), false)
  assert.equal(listCompanyEvents(db, 'T1', { now: NOW }).length, 2)
})

test('eventsForLeads: lead-keyed and domain-keyed histories surface per lead, tenant-scoped', () => {
  const db = setup()
  recordCompanyEvent(db, 'T1', ev({ companyKey: 'lead:l1', leadId: 'l1', summary: 'SEC Form D filed 2026-10-01' }))
  recordCompanyEvent(db, 'T1', ev({ companyKey: 'acme.example', leadId: 'l1', eventType: 'hiring_surge', summary: '5 open roles', sourceUrl: 'https://jobs.example/board' }))
  recordCompanyEvent(db, 'T1', ev({ companyKey: 'lead:l2', leadId: 'l2', summary: 'SEC Form D filed 2026-09-15', sourceUrl: 'https://www.sec.gov/Archives/edgar/data/3/4/z.htm' }))
  recordCompanyEvent(db, 'T2', ev({ companyKey: 'lead:l1', leadId: 'l1', summary: 'other tenant event', sourceUrl: 'https://www.sec.gov/Archives/edgar/data/5/6/w.htm' }))
  const out = eventsForLeads(db, 'T1', [{ id: 'l1', company_domain: 'acme.example' }, { id: 'l2', company_domain: null }, { id: 'l3', company_domain: null }], { now: NOW })
  assert.deepEqual(out.l1.map(e => e.summary).sort(), ['5 open roles', 'SEC Form D filed 2026-10-01'])
  assert.deepEqual(out.l2.map(e => e.summary), ['SEC Form D filed 2026-09-15'])
  assert.equal(out.l3, undefined)
  // The other tenant's row for the same lead id never crosses over.
  assert.ok(!out.l1.some(e => e.summary === 'other tenant event'))
})
