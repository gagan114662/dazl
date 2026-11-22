// Test-only ranking-verification fixture for the operator-designated test tenant.
// Lets the deployed fit-lane-first / evidence-tiebreak ordering be checked live on the
// designated tenant without a paid scan. Same gating as the outreach test fixtures:
// OUTREACH_TEST_TENANT_ID plus the allowlisted test inbox, checked in fixtureAvailable.
//
// Every row is visibly test-only: company names carry "(test only)", the signal and source
// URLs state dazl found and verified nothing, contacts are NULL (no real identity, nothing
// for outreach to touch), and no sequences or messages are created. Idempotent: a second
// call returns the existing fixture job unchanged.
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { fixtureAvailable, FixtureError } from '../outreach/test-fixture.ts'
import { recordCompanyEvent, companyKey, type EventType } from '../events/store.ts'

export const RANKING_FIXTURE_JOB = 'dazl ranking fixture (test only)'
const SRC = 'https://dazl.ai/test-only-ranking-fixture'
const SIGNAL = 'Test-only fixture for verifying account ordering. Not a real company. dazl did not find, scrape or verify this lead and claims no evidence for it.'

export interface RankingFixtureResult { jobId: string; created: boolean; expectedOrder: string[] }

// The ordering this fixture proves live: A (fit 5, no evidence) first - a better fit always
// outranks more evidence; then B (fit 4 + two dated events) before C (fit 4, no evidence) -
// evidence breaks ties inside a fit lane.
const LEADS = [
  { suffix: 'A', fit: 5, intent: 3, action: 3, score: 10, events: [] as { type: EventType; summary: string; url: string }[] },
  { suffix: 'B', fit: 4, intent: 5, action: 5, score: 95, events: [
    { type: 'funding_round' as EventType, summary: 'Test-only funding event for ordering verification - not a real event.', url: `${SRC}/b-funding` },
    { type: 'hiring_surge' as EventType, summary: 'Test-only hiring event for ordering verification - not a real event.', url: `${SRC}/b-hiring` },
  ] },
  { suffix: 'C', fit: 4, intent: 1, action: 1, score: 99, events: [] as { type: EventType; summary: string; url: string }[] },
]

export function createRankingFixture(db: Database.Database, tenantId: string, now = Math.floor(Date.now() / 1000)): RankingFixtureResult {
  if (!fixtureAvailable(db, tenantId)) throw new FixtureError('test_tenant_only')
  const expectedOrder = LEADS.map(l => `dazl ranking fixture ${l.suffix} (test only)`)

  const existing = db.prepare('SELECT id FROM scan_jobs WHERE user_id = ? AND business_name = ? ORDER BY created_at DESC LIMIT 1').get(tenantId, RANKING_FIXTURE_JOB) as { id: string } | undefined
  if (existing) return { jobId: existing.id, created: false, expectedOrder }

  const jobId = randomBytes(12).toString('hex')
  const today = new Date(now * 1000).toISOString().slice(0, 10)
  db.transaction(() => {
    db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, ?, 'test only', 'test only', 'running')").run(jobId, tenantId, RANKING_FIXTURE_JOB)
    for (const l of LEADS) {
      const leadId = randomBytes(12).toString('hex')
      db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, score, fit, intent, action, source_kind) VALUES (?, ?, '', ?, NULL, ?, ?, ?, ?, ?, ?, 'test')")
        .run(leadId, jobId, `dazl ranking fixture ${l.suffix} (test only)`, SIGNAL, SRC, l.score, l.fit, l.intent, l.action)
      for (const ev of l.events) {
        recordCompanyEvent(db, tenantId, {
          companyKey: companyKey(null, leadId)!, companyName: `dazl ranking fixture ${l.suffix} (test only)`,
          scope: 'account', leadId, eventType: ev.type, summary: ev.summary,
          sourceUrl: ev.url, sourcePublishedAt: today, retrievedAt: now, confidence: null,
        })
      }
    }
    db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(jobId)
  })()
  return { jobId, created: true, expectedOrder }
}
