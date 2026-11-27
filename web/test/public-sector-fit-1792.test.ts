// #1792 regression (test-only): lead fit must hold official public bodies out of Ready and out of drafting, while real
// private buyers with the same evidence stay Ready and draftable. Runs the real fit gate (applyBuyerFitGate, #1825) on a
// scan of 5 public bodies (town, school board, hospital, provincial ministry, library) plus 2 private buyers, then reads each
// lead the way Home does (discoverState / discoverApprove) and tries createDraft. Synthetic records, no network, nothing sent.
// If a public body is still Ready or gets a draft, this fails and the bug belongs on #1792 (no lead-fit code is edited here).
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { addEnrichment } from '../lib/connectors/store.ts'
import { applyBuyerFitGate } from '../lib/scan/buyer-fit.ts'
import { discoverState, discoverApprove, discoverReady } from '../lib/discover/card.ts'
import { createDraft } from '../lib/outreach/service.ts'
import type { Provider } from '../lib/llm/provider.ts'

type Rec = { key: string; company: string; domain: string; mailDomain: string; public: boolean }
const RECS: Rec[] = [
  { key: 'town', company: 'Town of Oakville', domain: 'oakville.ca', mailDomain: 'oakville.ca', public: true },
  { key: 'school board', company: 'Toronto District School Board', domain: 'tdsb.on.ca', mailDomain: 'tdsb.on.ca', public: true },
  { key: 'hospital', company: 'Hamilton General Hospital', domain: 'hhsc.ca', mailDomain: 'hhsc.ca', public: true },
  { key: 'provincial ministry', company: 'Ministry of Education', domain: 'edu.ontario.ca', mailDomain: 'edu.ontario.ca', public: true },
  { key: 'library', company: 'Hamilton Public Library', domain: 'hpl.ca', mailDomain: 'hpl.ca', public: true },
  { key: 'private buyer: dental group', company: 'Northwind Dental', domain: 'northwind-dental.example', mailDomain: 'northwind-dental.example', public: false },
  { key: 'private buyer: logistics', company: 'Acme Logistics', domain: 'acme-logistics.example', mailDomain: 'acme-logistics.example', public: false },
]
const HOME = 'Our team runs the business every day and serves our customers with care. We are expanding and updating our finance and operations software this year. '.repeat(3)
const prov: Provider = { research: async () => ({ text: '', citedUrls: [] }), complete: async () => RECS.map((_, i) => `COMPANY ${i + 1} | fit yes | quote expanding and updating our finance and operations software`).join('\n') }
const page = async () => ({ text: HOME, title: 'Home', retrievedAt: 1 })

function build() {
  process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
  const db = new Database(':memory:'); migrateAllSqlite(db)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller, created_at) VALUES ('J','T','Ledgerly','software','Ontario','running','Finance software buyers','Accounting software for private companies',1000)").run()
  const ids: Record<string, string> = {}
  for (const r of RECS) {
    const id = randomBytes(12).toString('hex'); ids[r.key] = id
    db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, evidence_excerpt, event_date, date_status, confidence, fit, intent, why, source_kind, company_domain, human_confirmed_at, human_confirmed_from) VALUES (?, 'J', 'Dana Ruiz', ?, 'Replacing its finance system', ?, 85, ?, '2026-11-10', 'verified', 85, 5, 5, 'expanding', 'discover', ?, 1800000000, 'test_review')")
      .run(id, r.company, `https://${r.domain}/news`, `${r.company} is replacing its finance system`, r.domain)
    for (const e of [
      { connector: 'discover', kind: 'person', value: 'Dana Ruiz, Finance Lead', label: 'named on a public page', source_url: `https://${r.domain}/team` },
      { connector: 'discover', kind: 'email', value: `dana@${r.mailDomain}`, label: 'published on a public page', source_url: `https://${r.domain}/contact` },
    ]) addEnrichment(db, 'T', id, { ...e, confidence: null, source_date: '2026-11-22', retrieved_at: Math.floor(Date.now() / 1000) })
  }
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'J'").run()
  return { db, ids }
}
const asLead = (db: Database.Database, id: string) => {
  const l = db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as Record<string, unknown>
  const enrichments = db.prepare('SELECT connector, kind, value, label, source_url FROM lead_enrichments WHERE lead_id = ?').all(id)
  return { ...l, enrichments } as never
}
const refusal = (fn: () => unknown): string | null => { try { fn(); return null } catch (e) { return (e as { code?: string; message?: string }).code ?? (e as Error).message } }

// One shared scan, one test per record. The hospital case is expected to be RED on main until #1792 covers hospitals:
// Gagan's requirement is that this fails if any public body reaches Ready or gets a draft, so nothing here suppresses it.
let shared: Promise<{ db: Database.Database; ids: Record<string, string> }> | null = null
const scanned = () => shared ??= (async () => {
  const b = build()
  await applyBuyerFitGate(b.db, 'J', prov, 'k', 'Accounting software for private companies', { fetchPage: page })
  return b
})()

for (const r of RECS) {
  test(`#1792: ${r.key} (${r.company}) ${r.public ? 'never reaches Ready or a draft' : 'still reaches Ready and a draft'}`, async () => {
    const { db, ids } = await scanned()
    const lead = asLead(db, ids[r.key])
    const state = discoverState(lead)
    const err = refusal(() => createDraft(db, 'T', ids[r.key], 'Ledgerly', { manual: true }))
    if (r.public) {
      assert.equal(discoverReady(state), false, `${r.company} must not be Ready, got ${state}`)
      assert.equal(discoverApprove(lead).ok, false, 'Approve must be off')
      assert.notEqual(err, null, 'createDraft must refuse a public body')
    } else {
      assert.equal(state, 'ready_email', 'a real private buyer stays Ready')
      assert.equal(err, null, `a real private buyer can still be drafted to, got ${err}`)
    }
  })
}

test('#1792: an existing municipality without a recorded fit hold cannot get a manual draft', () => {
  const { db, ids } = build()
  try {
    assert.equal(refusal(() => createDraft(db, 'T', ids.town, 'Ledgerly', { manual: true })), 'public_sector_non_buyer')
    const drafts = db.prepare('SELECT COUNT(*) FROM outreach_messages WHERE lead_id = ?').pluck()
    assert.equal(drafts.get(ids.town), 0)
  } finally { db.close() }
})

test('#1792: a private buyer without a recorded fit hold remains draftable', () => {
  const { db, ids } = build()
  try {
    assert.ok(createDraft(db, 'T', ids['private buyer: logistics'], 'Ledgerly', { manual: true }))
  } finally { db.close() }
})

test('#1792: an explicitly public-sector offer can still draft to a municipality', () => {
  const { db, ids } = build()
  try {
    db.prepare('UPDATE scan_jobs SET seller = ? WHERE id = ?').run('Budgeting software for municipalities', 'J')
    assert.ok(createDraft(db, 'T', ids.town, 'Ledgerly', { manual: true }))
  } finally { db.close() }
})
