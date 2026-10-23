import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateEvents, recordCompanyEvent, companyKey } from '../lib/events/store.ts'
import { groupUnderlyingEvents, scoreEvidence, leadPriorities, rankLeads, EVENT_WEIGHT, EVIDENCE_CAP } from '../lib/events/prioritize.ts'

const NOW = 1_800_000_000
const setup = () => { const db = new Database(':memory:'); migrateEvents(db); return db }
const ev = (over: Record<string, unknown> = {}) => ({
  companyKey: 'acme.example', companyName: 'Acme', scope: 'account' as const, leadId: 'l1',
  eventType: 'funding_round' as const, summary: 'SEC Form D filed 2026-10-01', detail: 'Acme, Inc.', // real EDGAR rows always carry the filing entity; entity-unconfirmed rows are excluded from ranking
  sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/2/x.htm', sourcePublishedAt: '2026-10-01' as string | null,
  retrievedAt: NOW, confidence: 80, ...over,
})
const rowsFor = (db: Database.Database, key = 'acme.example') =>
  (db.prepare('SELECT *, 1 AS fresh FROM company_events WHERE company_key = ?').all(key) as unknown as import('../lib/events/store.ts').CompanyEventRow[])

test('same dated event from two sources is ONE event with corroboration, not two events', () => {
  const db = setup()
  recordCompanyEvent(db, 'T1', ev())
  recordCompanyEvent(db, 'T1', ev({ summary: 'Press: Acme raises', sourceUrl: 'https://news.example/acme' }))
  const groups = groupUnderlyingEvents(rowsFor(db), NOW)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].sources.length, 2)
  const s = scoreEvidence(groups)
  assert.equal(s.evidence_score, EVENT_WEIGHT.funding_round + 2) // one unit + 1 corroboration point x2
  assert.ok(s.reasons[0].includes('2 sources'))
})

test('two genuinely distinct dated events of one type both count, third is capped and visible', () => {
  const db = setup()
  recordCompanyEvent(db, 'T1', ev({ sourcePublishedAt: '2026-10-01' }))
  recordCompanyEvent(db, 'T1', ev({ sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/2/y.htm', sourcePublishedAt: '2026-04-01', summary: 'Earlier round' }))
  recordCompanyEvent(db, 'T1', ev({ sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/2/z.htm', sourcePublishedAt: '2025-06-01', summary: 'Oldest round' }))
  const s = scoreEvidence(groupUnderlyingEvents(rowsFor(db), NOW))
  assert.equal(s.evidence_score, EVENT_WEIGHT.funding_round * 2)
  assert.equal(s.reasons.length, 2)
  assert.ok(s.uncounted.some(u => u.includes('2025-06-01') && u.includes('cap')))
})

test('undated same-type reports score as a single unit: no fake multiplicity, sources pool', () => {
  const db = setup()
  recordCompanyEvent(db, 'T1', ev({ eventType: 'hiring_surge', summary: 'Hiring', sourcePublishedAt: null, sourceUrl: 'https://jobs.example/1' }))
  recordCompanyEvent(db, 'T1', ev({ eventType: 'hiring_surge', summary: 'Hiring more', sourcePublishedAt: null, sourceUrl: 'https://jobs.example/2' }))
  recordCompanyEvent(db, 'T1', ev({ eventType: 'hiring_surge', summary: 'Still hiring', sourcePublishedAt: null, sourceUrl: 'https://jobs.example/3' }))
  const groups = groupUnderlyingEvents(rowsFor(db), NOW)
  assert.equal(groups.length, 3) // identity unknown: groups stay separate, no false merge
  const s = scoreEvidence(groups)
  assert.equal(s.evidence_score, EVENT_WEIGHT.hiring_surge + 2 * 2) // one unit, corroboration capped at 2 extra sources
  assert.ok(s.reasons[0].includes('counted once'))
  assert.ok(s.reasons[0].includes('3 sources'))
})

test('undated reports do not add points on top of a dated event of the same type', () => {
  const db = setup()
  recordCompanyEvent(db, 'T1', ev())
  recordCompanyEvent(db, 'T1', ev({ sourceUrl: 'https://jobs.example/1', sourcePublishedAt: null, summary: 'Rumored round' }))
  const s = scoreEvidence(groupUnderlyingEvents(rowsFor(db), NOW))
  assert.equal(s.evidence_score, EVENT_WEIGHT.funding_round)
  assert.ok(s.uncounted.some(u => u.includes('without a source-stated date')))
})

test('stale events score nothing and remain visible as uncounted', () => {
  const db = setup()
  const old = NOW - 40 * 86400 // hiring window is 30 days
  db.prepare("INSERT INTO company_events (id, tenant_id, company_key, company_name, scope, lead_id, event_type, summary, source_url, source_published_at, retrieved_at, first_seen_at, last_seen_at) VALUES ('e1','T1','acme.example','Acme','account','l1','hiring_surge','Old roles','https://jobs.example/old','2026-09-01',?,?,?)").run(old, old, old)
  const s = scoreEvidence(groupUnderlyingEvents(rowsFor(db), NOW))
  assert.equal(s.evidence_score, 0)
  assert.ok(s.uncounted.some(u => u.includes('30-day freshness window')))
})

test('cross-key duplicate: same source observation under lead key and domain key is one source', () => {
  const db = setup()
  recordCompanyEvent(db, 'T1', ev({ companyKey: 'lead:l1', leadId: 'l1' }))
  recordCompanyEvent(db, 'T1', ev({ companyKey: 'acme.example', leadId: 'l1', retrievedAt: NOW + 5 }))
  const both = [...rowsFor(db, 'lead:l1'), ...rowsFor(db)]
  const groups = groupUnderlyingEvents(both, NOW)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].sources.length, 1)
})

test('leadPriorities: graded ICP axes are the base, evidence adds, tenant-scoped', () => {
  const db = setup()
  recordCompanyEvent(db, 'T1', ev({ companyKey: companyKey(null, 'l1')!, leadId: 'l1' }))
  recordCompanyEvent(db, 'T2', ev({ companyKey: 'acme.example', leadId: 'l1', summary: 'other tenant' }))
  const out = leadPriorities(db, 'T1', [{ id: 'l1', company_domain: 'acme.example', fit: 4, intent: 3, action: 4 }], { now: NOW })
  assert.equal(out.l1.graded, true)
  assert.deepEqual([out.l1.fit, out.l1.intent, out.l1.action], [4, 3, 4])
  assert.equal(out.l1.evidence_score, EVENT_WEIGHT.funding_round)
  // The other tenant's domain-keyed row never contributes.
  assert.ok(!out.l1.reasons.join(' ').includes('other tenant'))
})

test('ungraded lead: no composite priority - the raw candidate score is not a verified fit', () => {
  const db = setup()
  recordCompanyEvent(db, 'T1', ev({ companyKey: companyKey(null, 'l2')!, leadId: 'l2' }))
  const out = leadPriorities(db, 'T1', [{ id: 'l2', company_domain: null, fit: null, intent: null, action: null }], { now: NOW })
  assert.equal(out.l2.graded, false)
  assert.equal(out.l2.fit, null)
  assert.equal(out.l2.evidence_score, EVENT_WEIGHT.funding_round) // evidence still reported on its own
})

test('no events: evidence zero, reasons empty, grade-based priority unchanged', () => {
  const db = setup()
  const out = leadPriorities(db, 'T1', [{ id: 'l9', company_domain: null, fit: 2, intent: 2, action: 2 }], { now: NOW })
  assert.equal(out.l9.evidence_score, 0)
  assert.deepEqual(out.l9.reasons, [])
  assert.equal(out.l9.graded, true)
})

test('rankLeads: fit lane outranks evidence, evidence breaks ties, ungraded last', () => {
  const pri = (e: number) => ({ graded: true, fit: 0, intent: 0, action: 0, evidence_score: e, reasons: [], uncounted: [] })
  const leads = [
    { id: 'low-fit-rich-evidence', score: 90, fit: 2, intent: 5, action: 5 },
    { id: 'high-fit-some-evidence', score: 50, fit: 4, intent: 2, action: 2 },
    { id: 'high-fit-no-evidence', score: 99, fit: 4, intent: 2, action: 2 },
    { id: 'ungraded', score: 100, fit: null, intent: null, action: null },
  ]
  const ranked = rankLeads(leads, {
    'low-fit-rich-evidence': pri(40),
    'high-fit-some-evidence': pri(15),
    'high-fit-no-evidence': pri(0),
    'ungraded': pri(40),
  })
  // fit 4 lane first; within it, evidence outranks the raw candidate score
  assert.deepEqual(ranked.map(l => l.id), ['high-fit-some-evidence', 'high-fit-no-evidence', 'low-fit-rich-evidence', 'ungraded'])
})

test('evidence score is capped and the cap is visible', () => {
  const db = setup()
  recordCompanyEvent(db, 'T1', ev({ sourcePublishedAt: '2026-10-01' }))
  recordCompanyEvent(db, 'T1', ev({ sourceUrl: 'https://news.example/a', sourcePublishedAt: '2026-10-01' }))
  recordCompanyEvent(db, 'T1', ev({ sourceUrl: 'https://news.example/b', sourcePublishedAt: '2026-10-01' }))
  recordCompanyEvent(db, 'T1', ev({ sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/2/y.htm', sourcePublishedAt: '2026-04-01' }))
  recordCompanyEvent(db, 'T1', ev({ eventType: 'hiring_surge', summary: 'Hiring', sourceUrl: 'https://jobs.example/1', sourcePublishedAt: null }))
  recordCompanyEvent(db, 'T1', ev({ eventType: 'hiring_surge', summary: 'Hiring2', sourceUrl: 'https://jobs.example/2', sourcePublishedAt: null }))
  recordCompanyEvent(db, 'T1', ev({ eventType: 'tech_stack', summary: 'Uses Postgres', sourceUrl: 'https://stack.example/1', sourcePublishedAt: '2026-09-15' }))
  recordCompanyEvent(db, 'T1', ev({ eventType: 'competitor_mention', summary: 'vs Gojiberry', sourceUrl: 'https://forum.example/1', sourcePublishedAt: '2026-10-10' }))
  const s = scoreEvidence(groupUnderlyingEvents(rowsFor(db), NOW))
  assert.ok(s.evidence_score <= EVIDENCE_CAP)
  // 2 funding units (15+15) + corroboration 4 + hiring 10+2 + tech 5 + competitor 5 = 56 raw, capped at 40
  assert.equal(s.evidence_score, EVIDENCE_CAP)
  assert.ok(s.uncounted.some(u => u.includes('exceed the 40-point cap')))
})
