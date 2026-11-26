import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { addEnrichment, enrichmentsForLeads } from '../lib/connectors/store.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { discoverJobCounts } from '../lib/discover/state-db.ts'
import { heldState } from '../lib/lead-state.ts'
import { historyCampaigns } from '../lib/outreach/campaigns.ts'
import { approveBlockReason, createDraft, OutreachError } from '../lib/outreach/service.ts'
import { leadCardSummary } from '../lib/scan/lead-card.ts'
import { listLeads } from '../lib/scan/store.ts'

const tenant = 'research-fixture'
const scan = 'a'.repeat(24)
const mailbox = 'lee@publisher.example'
const day = new Date(Date.now() - 86400_000).toISOString().slice(0, 10)

function fixture(t: { after(fn: () => void): void }) {
  const db = new Database(':memory:')
  t.after(() => db.close())
  migrateAllSqlite(db)
  db.prepare(`INSERT INTO scan_jobs
    (id, user_id, business_name, industry, location, query, status, seller)
    VALUES (?, ?, 'Workspace', 'services', '-', 'Companies opening another site', 'running', 'Commercial fit-outs')`).run(scan, tenant)

  for (const [id, company, proof] of [
    ['index-dated', 'Publisher', null],
    ['page-dated', 'Operator', 'page_bound'],
  ] as const) {
    db.prepare(`INSERT INTO leads
      (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt,
       event_date, event_date_proof, date_status, source_kind, score, confidence, fit, intent)
      VALUES (?, ?, 'Lee Rivera', ?, ?, 'Opening another site', ?, 'Opening another site',
        ?, ?, ?, 'discover', 85, 85, 4, 4)`)
      .run(id, scan, company, `${company.toLowerCase()}.example`, `https://${company.toLowerCase()}.example/news`,
        day, proof, proof ? 'verified' : 'unverified')
    const enrich = (kind: string, value: string) => addEnrichment(db, tenant, id, {
      connector: 'discover', kind, value, label: null, confidence: null,
      source_url: `https://${company.toLowerCase()}.example/team`, source_date: day, retrieved_at: 1,
    })
    enrich('person', 'Lee Rivera, Owner')
    if (proof) enrich('linkedin', 'https://www.linkedin.com/in/lee-rivera/')
    else enrich('email', mailbox)
  }
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(scan)
  return db
}

test('index-only date is research on the card', t => {
  const db = fixture(t)
  const rows = listLeads(db, tenant, scan, 20, true) as (Parameters<typeof heldState>[0] & { id: string })[]
  const enrichments = enrichmentsForLeads(db, tenant, rows.map(row => row.id))
  const cards = rows.map(row => ({ ...row, enrichments: enrichments[row.id] ?? [] }))
  const index = cards.find(card => card.id === 'index-dated')
  assert.ok(index)
  assert.equal(heldState(index)?.state, 'research')
  assert.equal(leadCardSummary(index as Parameters<typeof leadCardSummary>[0]).approve.ok, false)
  assert.equal(cards.filter(card => !heldState(card)).length, 1)
})

test('the scan and past scans count the index-only lead as research and the dated lead as Ready', async t => {
  const db = fixture(t)
  const expected = { found: 2, ready: 1, ready_email: 0, ready_linkedin: 1, no_contact: 0, research: 1, rejected: 0, review: 0 }
  assert.deepEqual(await discoverJobCounts(sqliteDb(db), tenant, scan), expected)
  assert.deepEqual((await historyCampaigns(db, sqliteDb(db), tenant, [scan]))[0].qualification.discover, expected)
})

test('research-only lead cannot create a manual draft', t => {
  const db = fixture(t)
  assert.throws(() => createDraft(db, tenant, 'index-dated', 'Workspace', { manual: true }),
    (error: unknown) => error instanceof OutreachError && error.code === 'lead_currentness_unconfirmed')
  assert.equal(db.prepare('SELECT count(*) FROM outreach_messages').pluck().get(), 0)
})

test('an existing draft is held if its lead has only an index date', t => {
  const db = fixture(t)
  db.prepare(`INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body)
    VALUES ('saved-draft', ?, 'index-dated', ?, 'Opening a site', 'A saved draft for an opening that was never dated on the page.')`)
    .run(tenant, mailbox)
  assert.equal(approveBlockReason(db, tenant, 'saved-draft', { skipAccount: true }), 'lead_currentness_unconfirmed')
})
