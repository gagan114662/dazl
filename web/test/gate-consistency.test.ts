import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
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
const NOW = new Date('2026-10-26T12:00:00Z')
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
type E = { connector: string; kind: string; value: string; label: string | null; source_url: string }
const S = 'https://x.example/news'
const dom = (site: string, token: string): E => ({ connector: 'sitecrawl', kind: 'domain', value: `${site}|${token}`, label: `domain-basis-v1:${token}`, source_url: S })
const mail = (a: string, label: string | null = null): E => ({ connector: 'sitecrawl', kind: 'email', value: a, label, source_url: 'https://x.example/contact' })
const person: E = { connector: 'sitecrawl', kind: 'person', value: 'Dana Lee, Practice Owner', label: null, source_url: 'https://x.example/team' }
const privacyCtx = 'contact-context-v1:' + JSON.stringify({ excerpt: 'For privacy requests email hello@x.example', restriction: 'restricted-purpose context' })

type Scenario = { name: string; contact: string | null; date: string | null; rows: E[]; quarantine?: boolean; window?: number }
const SCENARIOS: Scenario[] = [
  { name: 'own domain crawled email, in window', contact: null, date: day(-10), rows: [dom('x.example', 'evidence_own_domain'), mail('owner@x.example'), person] },
  { name: 'name_probe crawled email', contact: null, date: day(-10), rows: [dom('x.example', 'name_probe'), mail('owner@x.example'), person] },
  { name: 'contact equals crawled name_probe address', contact: 'owner@x.example', date: day(-10), rows: [dom('x.example', 'name_probe'), mail('owner@x.example'), person] },
  { name: 'restricted context label on crawled address', contact: null, date: day(-10), rows: [dom('x.example', 'evidence_own_domain'), mail('hello@x.example', privacyCtx), person] },
  { name: 'cited-page contact only', contact: 'owner@x.example', date: day(-10), rows: [person] },
  { name: 'stale event date', contact: 'owner@x.example', date: day(-200), rows: [person] },
  { name: 'undated', contact: 'owner@x.example', date: null, rows: [person] },
  { name: 'quarantined', contact: 'owner@x.example', date: day(-10), rows: [person], quarantine: true },
  { name: 'two recorded sites', contact: null, date: day(-10), rows: [dom('x.example', 'evidence_own_domain'), dom('y.example', 'evidence_own_domain'), mail('owner@x.example'), person] },
]

function build(s: Scenario) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateOutreach(db); seedOffers(db)
  const icp = JSON.stringify({ summary: 's', who: ['Practice owner'], industries: [], sizes: [], where: [], signals: [], exclude: [], window_days: 90 })
  const job = createQueryJob(db, 'A', { query: 'dental clinics in the past 90 days', icp })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const id = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, fit, intent, event_date, human_confirmed_at, score) VALUES (?, ?, ?, ?, ?, ?, ?, 90, 4, 2, ?, 1, 70)')
    .run(id, job, 'X Dental', s.contact, 'X Dental opened a clinic', S, 'X Dental opened a clinic', s.date)
  const ins = db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', ?, ?, ?, ?, ?, '2026-10-20', 10)")
  for (const r of s.rows) ins.run(randomBytes(8).toString('hex'), id, r.connector, r.kind, r.value, r.label, r.source_url)
  if (s.quarantine) setQuarantine(db, 'A', id, 'quarantine', 'wrong company', Date.now())
  const q = db.prepare('SELECT quarantined_at FROM leads WHERE id = ?').get(id) as { quarantined_at: number | null }
  const lead: CardLead = {
    id, company: 'X Dental', signal: 'X Dental opened a clinic', source_url: S, evidence_excerpt: 'X Dental opened a clinic', event_date: s.date,
    date_status: 'verified', review_reason: null, fit: 4, intent: 2, why: null, icp_match: null, company_domain: null, contact: s.contact,
    confidence: 90, human_confirmed_at: 1, quarantined_at: q.quarantined_at,
    currentness_held: currentnessHeld(db, 'A', id), window_held: leadWindowHeld(db, 'A', id), enrichments: s.rows,
  }
  return { db, id, lead }
}

for (const s of SCENARIOS) {
  test(`card and createDraft agree: ${s.name}`, () => {
    const { db, id, lead } = build(s)
    const card = opportunityCard(lead, 'Practice owner', NOW)
    let drafted = false
    try { createDraft(db, 'A', id, 'Acme'); drafted = true } catch { /* refused */ }
    const advisesDraft = card.next.startsWith('Draft')
    // The card may be more cautious than the gate (e.g. no person named) but never advise what the gate refuses.
    if (advisesDraft) assert.equal(drafted, true, `card says "${card.next}" but createDraft refused`)
    if (!drafted) assert.equal(advisesDraft, false)
  })
}

test('control: the strongest scenario is actually draftable by both (the property is not vacuous)', () => {
  const { db, id, lead } = build(SCENARIOS[0])
  assert.ok(opportunityCard(lead, 'Practice owner', NOW).next.startsWith('Draft'))
  assert.doesNotThrow(() => createDraft(db, 'A', id, 'Acme'))
})
