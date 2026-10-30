import { seedOffers } from './helpers/seed-offer.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { createDraft } from '../lib/outreach/service.ts'
import { currentnessHeld, leadWindowHeld } from '../lib/outreach/currentness.ts'
import { setQuarantine } from '../lib/scan/quarantine.ts'
import { opportunityCard, type CardLead } from '../lib/scan/opportunity.ts'

// Known gap 3 (docs/STATUS.md): the card's advice and the send gate are separate code. Property: for the SAME stored
// lead, whenever the card recommends "Draft a first message", createDraft must accept it; and whenever createDraft
// refuses it for identity, window, currentness or quarantine, the card must not recommend drafting. Fixtures only.
// ONE clock for fixtures, the gates (createDraft/currentnessHeld read new Date()), quarantine and the card: Date is mocked
// to a fixed instant, so the test means the same thing on any day. Scope: card advice vs createDraft eligibility only,
// not approve/send/sequence/CSV agreement, identity correctness or delivery.
const NOW = new Date('2026-10-26T12:00:00Z')
mock.timers.enable({ apis: ['Date'], now: NOW.getTime() })
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString().slice(0, 10)
type E = { connector: string; kind: string; value: string; label: string | null; source_url: string }
const S = 'https://x.example/news'
const dom = (site: string, token: string): E => ({ connector: 'sitecrawl', kind: 'domain', value: `${site}|${token}`, label: `domain-basis-v1:${token}`, source_url: S })
const mail = (a: string, label: string | null = null): E => ({ connector: 'sitecrawl', kind: 'email', value: a, label, source_url: 'https://x.example/contact' })
const person: E = { connector: 'sitecrawl', kind: 'person', value: 'Dana Lee, Practice Owner', label: null, source_url: 'https://x.example/team' }
const privacyCtx = 'contact-context-v1:' + JSON.stringify({ excerpt: 'For privacy requests email hello@x.example', restriction: 'restricted-purpose context' })

type Scenario = { name: string; contact: string | null; date: string | null; rows: E[]; quarantine?: boolean; expectHeld?: boolean; icp?: string; query?: string }
const ICP = { summary: 's', who: ['Practice owner'], industries: [], sizes: [], where: [], signals: [], exclude: [] }
const SCENARIOS: Scenario[] = [
  { name: 'own domain crawled email, in window', contact: null, date: day(-10), rows: [dom('x.example', 'evidence_own_domain'), mail('owner@x.example'), person] },
  { name: 'name_probe crawled email', contact: null, date: day(-10), rows: [dom('x.example', 'name_probe'), mail('owner@x.example'), person] },
  { name: 'contact equals crawled name_probe address', contact: 'owner@x.example', date: day(-10), rows: [dom('x.example', 'name_probe'), mail('owner@x.example'), person] },
  { name: 'restricted context label on crawled address', contact: null, date: day(-10), rows: [dom('x.example', 'evidence_own_domain'), mail('hello@x.example', privacyCtx), person] },
  { name: 'cited-page contact only', contact: 'owner@x.example', date: day(-10), rows: [person] },
  { name: 'stale event date', contact: 'owner@x.example', date: day(-200), rows: [person] },
  { name: 'undated', contact: 'owner@x.example', date: null, rows: [person] },
  { name: 'quarantined', contact: 'owner@x.example', date: day(-10), rows: [person], quarantine: true },
  { name: 'invalid calendar date', contact: 'owner@x.example', date: '2026-02-30', rows: [person] },
  { name: 'future date', contact: 'owner@x.example', date: day(5), rows: [person] },
  { name: 'exact boundary day (inside)', contact: 'owner@x.example', date: day(-90), rows: [person] },
  { name: 'one day past the boundary (stale)', contact: 'owner@x.example', date: day(-91), rows: [person] },
  // #208: a saved window that is not an integer in [1,365] must recover the query window or hold; never waive it
  ...[0, -5, 30.5, '90', {}, 400].map(w => ({ name: `malformed saved window_days ${JSON.stringify(w)}, stale date`, contact: 'owner@x.example', date: day(-200), rows: [person], icp: JSON.stringify({ ...ICP, window_days: w }) })),
  { name: 'malformed saved window_days 0, fresh date, query has a window (recovers, draftable)', contact: 'owner@x.example', date: day(-10), rows: [person], icp: JSON.stringify({ ...ICP, window_days: 0 }) },
  { name: 'malformed saved window_days 0, query has no window (fails closed)', contact: 'owner@x.example', date: day(-10), rows: [person], icp: JSON.stringify({ ...ICP, window_days: 0 }), query: 'dental clinics in Ohio' },
  { name: 'unparseable saved profile (fails closed)', contact: 'owner@x.example', date: day(-10), rows: [person], icp: '{not json' },
  { name: 'two recorded sites', contact: null, date: day(-10), rows: [dom('x.example', 'evidence_own_domain'), dom('y.example', 'evidence_own_domain'), mail('owner@x.example'), person] },
]

async function build(s: Scenario) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateOutreach(db); seedOffers(db)
  const icp = s.icp ?? JSON.stringify({ ...ICP, window_days: 90 })
  const job = createQueryJob(db, 'A', { query: s.query ?? 'dental clinics in the past 90 days', icp })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const id = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, fit, intent, event_date, human_confirmed_at, score) VALUES (?, ?, ?, ?, ?, ?, ?, 90, 4, 2, ?, 1, 70)')
    .run(id, job, 'X Dental', s.contact, 'X Dental opened a clinic', S, 'X Dental opened a clinic', s.date)
  const ins = db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', ?, ?, ?, ?, ?, '2026-10-20', 10)")
  for (const r of s.rows) ins.run(randomBytes(8).toString('hex'), id, r.connector, r.kind, r.value, r.label, r.source_url)
  if (s.quarantine) await setQuarantine(sqliteDb(db), 'A', id, 'quarantine', 'wrong company', NOW.getTime())
  const q = db.prepare('SELECT quarantined_at FROM leads WHERE id = ?').get(id) as { quarantined_at: number | null }
  const lead: CardLead = {
    id, company: 'X Dental', signal: 'X Dental opened a clinic', source_url: S, evidence_excerpt: 'X Dental opened a clinic', event_date: s.date,
    date_status: 'verified', review_reason: null, fit: 4, intent: 2, why: null, icp_match: null, company_domain: null, contact: s.contact,
    confidence: 90, human_confirmed_at: 1, quarantined_at: q.quarantined_at,
    currentness_held: currentnessHeld(db, 'A', id), window_held: leadWindowHeld(db, 'A', id), enrichments: s.rows,
  }
  return { db, id, lead }
}

// What createDraft itself must do (so the agreement property cannot pass with both sides refusing everything).
const HELD = /stale|undated|invalid calendar|future date|quarantined|fails closed|malformed saved window_days .*stale date|two recorded|name_probe|restricted context/
const FREE = /^(own domain crawled email|cited-page contact only|exact boundary day|malformed saved window_days 0, fresh date)/
for (const s of SCENARIOS) {
  if (HELD.test(s.name)) s.expectHeld = true
  else if (FREE.test(s.name)) s.expectHeld = false
}
for (const s of SCENARIOS) {
  test(`card and createDraft agree: ${s.name}`, async () => {
    const { db, id, lead } = await build(s)
    const card = opportunityCard(lead, 'Practice owner', NOW)
    let drafted = false
    try { createDraft(db, 'A', id, 'Acme'); drafted = true } catch { /* refused */ }
    const advisesDraft = card.next.startsWith('Draft')
    // The card may be more cautious than the gate (e.g. no person named) but never advise what the gate refuses.
    if (s.expectHeld !== undefined) assert.equal(drafted, !s.expectHeld, `gate expectation for ${s.name}`)
    if (advisesDraft) assert.equal(drafted, true, `card says "${card.next}" but createDraft refused`)
    if (!drafted) assert.equal(advisesDraft, false)
  })
}

test('control: the strongest scenario is actually draftable by both (the property is not vacuous)', async () => {
  const { db, id, lead } = await build(SCENARIOS[0])
  assert.ok(opportunityCard(lead, 'Practice owner', NOW).next.startsWith('Draft'))
  assert.doesNotThrow(() => createDraft(db, 'A', id, 'Acme'))
})

// Instinct #210 recheck: a contact equal to a crawled address must be cited at the page the crawler saved it from
// (/contact), not at the signal/news URL; the saved signal excerpt stays separate; a true cited-page-only contact still
// cites the signal page. The recipient is unchanged.
import { setDomainReview } from '../lib/scan/domain-review-action.ts'
import { domainReviewFor } from '../lib/outreach/domain-review.ts'
function body(db: Database.Database, id: string): { to_email: string; body: string } {
  return db.prepare('SELECT to_email, body FROM outreach_messages WHERE lead_id = ?').get(id) as { to_email: string; body: string }
}
const CONTACT_URL = 'https://x.example/contact'
test('draft source URL: contact equal to a crawled own-domain address cites /contact; the news excerpt is separate', async () => {
  const { db, id } = await build({ name: 'eq own', contact: 'owner@x.example', date: day(-10), rows: [dom('x.example', 'evidence_own_domain'), mail('owner@x.example'), person] })
  createDraft(db, 'A', id, 'Acme')
  const m = body(db, id)
  assert.equal(m.to_email, 'owner@x.example')
  assert.ok(m.body.includes(`published on X Dental's page:\n${CONTACT_URL}\n`), m.body)
  assert.ok(m.body.includes(`Saved excerpt from this public page: "X Dental opened a clinic"\n${S}`), 'the signal excerpt keeps its own URL')
  assert.ok(!m.body.includes(`page:\n${S}`), 'the address is not attributed to the news page')
})
test('draft source URL: a website-reviewed name_probe address that equals the contact also cites /contact', async () => {
  const { db, id } = await build({ name: 'eq probe reviewed', contact: 'owner@x.example', date: day(-10), rows: [dom('x.example', 'name_probe'), mail('owner@x.example'), person] })
  assert.throws(() => createDraft(db, 'A', id, 'Acme'), /domain_unconfirmed/)
  const rows = db.prepare('SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ?').all(id) as Parameters<typeof domainReviewFor>[1] & object
  const binding = domainReviewFor({ id, contact: 'owner@x.example' }, rows).binding!
  assert.equal(setDomainReview(db, 'A', id, 'confirm', binding).status, 'confirmed')
  createDraft(db, 'A', id, 'Acme')
  const m = body(db, id)
  assert.equal(m.to_email, 'owner@x.example'); assert.ok(m.body.includes(`page:\n${CONTACT_URL}\n`), m.body); assert.ok(!m.body.includes(`page:\n${S}`))
})
test('draft source URL: cited-page-only contact (no crawl record) still cites the signal page, with no duplicate excerpt block', async () => {
  const { db, id } = await build({ name: 'cited only', contact: 'owner@x.example', date: day(-10), rows: [person] })
  createDraft(db, 'A', id, 'Acme')
  const m = body(db, id)
  assert.ok(m.body.includes(`page:\n${S}\n`), m.body); assert.ok(!m.body.includes('Saved excerpt'))
})
