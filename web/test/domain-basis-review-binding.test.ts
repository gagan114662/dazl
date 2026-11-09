// #915: the lower-level identity helpers (domainRelationship / domainConfirmed) honor a user's domain review only while its canonical
// binding (outreach/domain-review.ts) still matches. Writer = the real setDomainReview; readers = domainReviewFor, domainRelationship,
// domainConfirmed. They must agree before and after every change the binding covers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, addEnrichment } from '../lib/connectors/store.ts'
import { domainReviewFor } from '../lib/outreach/domain-review.ts'
import { setDomainReview } from '../lib/scan/domain-review-action.ts'
import { domainRelationship, domainConfirmed } from '../lib/signals/domain-basis.ts'

const LEAD = 'a'.repeat(24)
type Row = { connector: string; kind: string; value: string; label: string | null; source_url: string | null; retrieved_at: number | null }

function setup(contact: string | null = null) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,company_domain) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(LEAD, job, 'Acme', contact, 's', 'https://jobs.test/a', 'q', 90, 50, 'acme.example')
  const put = (kind: string, value: string, source_url: string, label = '', at = 10) =>
    addEnrichment(db, 'A', LEAD, { connector: 'sitecrawl', kind, value, label, confidence: null, source_url, source_date: '2026-10-24', retrieved_at: at })
  put('domain', 'acme.example|name_probe', 'https://acme.example/', 'domain-basis-v1:name_probe')
  put('email', 'hello@acme.example', 'https://acme.example/contact')
  const rows = () => db.prepare("SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ? AND tenant_id = 'A'").all(LEAD) as Row[]
  const canonical = () => domainReviewFor({ id: LEAD, contact }, rows()).state
  const read = () => ({ canonical: canonical(), rel: domainRelationship(db, 'A', LEAD, 'acme.example'), confirmed: domainConfirmed(db, 'A', LEAD, 'acme.example') })
  const confirm = () => setDomainReview(db, 'A', LEAD, 'confirm', domainReviewFor({ id: LEAD, contact }, rows()).binding!)
  return { db, put, rows, read, confirm }
}
const CONFIRMED = { canonical: 'confirmed', rel: 'established', confirmed: true }
const STALE = { canonical: 'required', rel: 'heuristic', confirmed: false }

test('#915 audit reproduction: changing the reviewed address leaves the canonical gate required AND the helpers unconfirmed', () => {
  const s = setup()
  assert.deepEqual(s.read(), STALE, 'before review')
  assert.deepEqual(s.confirm(), { status: 'confirmed', domain: 'acme.example' })
  assert.deepEqual(s.read(), CONFIRMED, 'a valid unchanged confirmation is still supported')
  s.db.prepare("UPDATE lead_enrichments SET value = 'someoneelse@acme.example' WHERE kind = 'email'").run()
  assert.deepEqual(s.read(), STALE, 'stale review: domainRelationship/domainConfirmed agree with domainReviewFor')
})

test('#915 every binding change de-establishes; re-confirming the new binding restores it', () => {
  const changes: [string, (s: ReturnType<typeof setup>) => void][] = [
    ['address page changed', s => s.db.prepare("UPDATE lead_enrichments SET source_url = 'https://acme.example/about' WHERE kind = 'email'").run()],
    ['domain basis changed (weaker row added)', s => s.put('domain', 'acme.example|evidence_link_text', 'https://x.test/p', 'domain-basis-v1:evidence_link_text', 30)],
    ['domain provenance page changed', s => s.db.prepare("UPDATE lead_enrichments SET source_url = 'https://acme.example/home' WHERE kind = 'domain'").run()],
    ['second company domain recorded', s => s.put('domain', 'acme-other.example|evidence_link_text', 'https://x.test/q', 'domain-basis-v1:evidence_link_text')],
    ['second crawled address recorded', s => s.put('email', 'sales@acme.example', 'https://acme.example/team', '', 5)],
  ]
  for (const [name, change] of changes) {
    const s = setup(); s.confirm(); assert.deepEqual(s.read(), CONFIRMED, name)
    change(s)
    assert.deepEqual(s.read(), STALE, name)
    assert.deepEqual(s.confirm().status, 'confirmed', name + ': a fresh review of the new binding')
    assert.equal(s.read().canonical, 'confirmed', name)
  }
})

test('#915 withdrawal, malformed/missing label, wrong value, wrong connector and other tenants cannot establish', () => {
  const s = setup(); s.confirm(); assert.deepEqual(s.read(), CONFIRMED)
  assert.deepEqual(setDomainReview(s.db, 'A', LEAD, 'withdraw'), { status: 'withdrawn' })
  assert.deepEqual(s.read(), STALE, 'withdrawn')
  const raw = (id: string, tenant: string, connector: string, value: string, label: string | null) => (s.db.prepare("DELETE FROM lead_enrichments WHERE kind = 'domain_review'").run(), s.db.prepare("INSERT INTO lead_enrichments (id, tenant_id, lead_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES (?, ?, ?, ?, 'domain_review', ?, ?, 'https://acme.example/', '2026-10-20', 0)").run(id, tenant, LEAD, connector, value, label))
  raw('m1', 'A', 'user', 'acme.example', 'confirmed'); assert.deepEqual(s.read(), STALE, 'malformed label')
  raw('m2', 'A', 'user', 'acme.example', null); assert.deepEqual(s.read(), STALE, 'missing label')
  raw('m3', 'A', 'user', 'acme.example', 'domain-review-v1:' + 'f'.repeat(64)); assert.deepEqual(s.read(), STALE, 'label for another binding')
  const binding = domainReviewFor({ id: LEAD, contact: null }, s.rows()).binding!
  raw('m4', 'A', 'sitecrawl', 'acme.example', 'domain-review-v1:' + binding); assert.deepEqual(s.read(), STALE, 'not a user review')
  raw('m5', 'B', 'user', 'acme.example', 'domain-review-v1:' + binding); assert.deepEqual(s.read(), STALE, 'another tenant\u2019s row')
  assert.equal(domainRelationship(s.db, 'B', LEAD, 'acme.example'), 'heuristic', 'another tenant reading the lead')
  raw('m6', 'A', 'user', 'other.example', 'domain-review-v1:' + binding); assert.deepEqual(s.read(), STALE, 'wrong domain value')
})

test('#915 a review is not widened to a different domain; own-domain and domain_check paths keep their own scope', () => {
  const s = setup(); s.confirm()
  assert.equal(domainRelationship(s.db, 'A', LEAD, 'acme-other.example'), 'heuristic')
  assert.equal(domainConfirmed(s.db, 'A', LEAD, 'acme-other.example'), false)
  const own = setup(); own.db.prepare("DELETE FROM lead_enrichments WHERE kind = 'domain'").run()
  own.put('domain', 'acme.example|evidence_own_domain', 'https://acme.example/careers/1', 'domain-basis-v1:evidence_own_domain')
  assert.equal(domainRelationship(own.db, 'A', LEAD, 'acme.example'), 'established', 'own domain needs no review')
  const chk = setup(); chk.put('domain_check', 'acme.example|homepage names company; place agrees', 'https://acme.example/')
  assert.equal(domainRelationship(chk.db, 'A', LEAD, 'acme.example'), 'heuristic', 'domain_check is not ownership')
  assert.equal(domainConfirmed(chk.db, 'A', LEAD, 'acme.example'), true, 'but it is confirmed for contact/score')
})
