import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateEvents, recordCompanyEvent, companyKey } from '../lib/events/store.ts'
import { leadPriorities } from '../lib/events/prioritize.ts'

const TENANT = 'u1'

function dbWithEvent(ev: { companyName: string; eventType: 'funding_round' | 'sec_filing' | 'hiring_surge'; summary: string; detail: string | null; url: string; publishedAt: string | null }) {
  const db = new Database(':memory:')
  migrateEvents(db)
  recordCompanyEvent(db, TENANT, {
    companyKey: companyKey(null, 'lead-vesta')!, companyName: ev.companyName, scope: 'account', leadId: 'lead-vesta',
    eventType: ev.eventType, summary: ev.summary, detail: ev.detail, sourceUrl: ev.url,
    sourcePublishedAt: ev.publishedAt, retrievedAt: Math.floor(Date.now() / 1000), confidence: 80,
  })
  return db
}

const LEAD = { id: 'lead-vesta', company: 'Vesta', company_domain: null, event_date: '2026-10-14', fit: 3, intent: 3, action: 3 }

test('entity-collided signal events (same-named fund filing) are excluded from ranking evidence', () => {
  const db = dbWithEvent({ companyName: 'Vesta', eventType: 'funding_round', summary: 'SEC Form D filed 2026-07-01', detail: 'Vesta Ventures Fund II, LP', url: 'https://www.sec.gov/Archives/edgar/data/2139575/000213957526000001/primary_doc.xml', publishedAt: '2026-07-01' })
  const pri = leadPriorities(db, TENANT, [LEAD])
  assert.equal(pri['lead-vesta'].evidence_score, 0)
  assert.deepEqual(pri['lead-vesta'].reasons, [])
})

test('off-window filings do not corroborate the claimed round even when the entity matches', () => {
  const db = dbWithEvent({ companyName: 'Vesta', eventType: 'sec_filing', summary: 'SEC Form D filed 2026-07-01', detail: 'Vesta, Inc.', url: 'https://www.sec.gov/Archives/edgar/data/1/0001/primary_doc.xml', publishedAt: '2026-07-01' })
  const pri = leadPriorities(db, TENANT, [LEAD])
  assert.equal(pri['lead-vesta'].evidence_score, 0)
})

test('entity-matched in-window filings still count as heuristic evidence, never as claim proof', () => {
  const db = dbWithEvent({ companyName: 'Vesta', eventType: 'sec_filing', summary: 'SEC Form D filed 2026-10-10', detail: 'Vesta, Inc.', url: 'https://www.sec.gov/Archives/edgar/data/1/0001/primary_doc.xml', publishedAt: '2026-10-10' })
  const pri = leadPriorities(db, TENANT, [LEAD])
  assert.ok(pri['lead-vesta'].evidence_score > 0)
})

test('a stale-dated filing re-seen today does not score: freshness is the event date, not the re-crawl', () => {
  const db = dbWithEvent({ companyName: 'Vesta', eventType: 'sec_filing', summary: 'SEC Form D filed 2019-10-10', detail: 'Vesta, Inc.', url: 'https://www.sec.gov/Archives/edgar/data/1/0001/primary_doc.xml', publishedAt: '2019-10-10' })
  const pri = leadPriorities(db, TENANT, [{ ...LEAD, event_date: null }])
  assert.equal(pri['lead-vesta'].evidence_score, 0)
  assert.ok(pri['lead-vesta'].uncounted.some(u => u.includes('older than')))
})

test('legacy funding_round rows sourced from the SEC score at filing weight, not round weight', () => {
  const db = dbWithEvent({ companyName: 'Vesta', eventType: 'funding_round', summary: 'SEC Form D filed 2026-10-10', detail: 'Vesta, Inc.', url: 'https://www.sec.gov/Archives/edgar/data/1/0001/primary_doc.xml', publishedAt: '2026-10-10' })
  const pri = leadPriorities(db, TENANT, [LEAD])
  assert.equal(pri['lead-vesta'].evidence_score, 8)
  assert.ok(pri['lead-vesta'].reasons.join(' ').includes('sec_filing'))
})
