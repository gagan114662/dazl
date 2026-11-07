// #910: completion facts and the evidence score use ONE public-suffix-aware identity. A contact at another company under the same multi-label suffix
// (co.uk, com.au) or another tenant of a private suffix (github.io) never fills the lead's route/person; same-company subdomains still do. Real
// snapshotLeads / completeLeads on migrated in-memory SQLite; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { snapshotLeads, completeLeads, evidenceScore, reg, emailReg } from '../lib/scan/completion.ts'

let k = 0
function lead(domain: string) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, confidence, score) VALUES ('L1', ?, '', 'Alpha', ?, 'opened a new office', 'https://news.example/1', 0.9, 55)").run(jobId, domain)
  // the domain was established from the company's own site (the crawl's identity check)
  enr(db, 'domain', `${domain}|evidence_own_domain`, `https://${domain}/`)
  return { db, jobId }
}
function enr(db: Database.Database, kind: string, value: string, source: string) {
  db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, 'L1', 'u1', 'sitecrawl', ?, ?, 'x', NULL, ?, '2026-11-01', 1)").run(`E${++k}`, kind, value, source)
}
const snap = (db: Database.Database, jobId: string) => { const [s] = snapshotLeads(db, 'u1', jobId); return { domain: s.domain, person: s.person, route: s.route } }

test('alpha.co.uk vs unrelated.co.uk: another company\u2019s email/phone/person never fills the route or person; the record keeps them missing and the score unchanged', () => {
  const { db, jobId } = lead('alpha.co.uk')
  const before = snapshotLeads(db, 'u1', jobId)
  assert.deepEqual(snap(db, jobId), { domain: true, person: false, route: false })
  enr(db, 'email', 'founder@unrelated.co.uk', 'https://unrelated.co.uk/contact')
  enr(db, 'phone', '+44 20 7946 0000', 'https://unrelated.co.uk/contact')
  enr(db, 'person', 'Jane Doe, Founder', 'https://www.unrelated.co.uk/team')
  enr(db, 'email', 'ceo@unrelated.co.uk', 'https://alpha.co.uk/press')   // on Alpha's page, but an address at another company
  assert.deepEqual(snap(db, jobId), { domain: true, person: false, route: false })
  const [rec] = completeLeads(db, { id: jobId, user_id: 'u1' }, before)
  assert.deepEqual(rec.filled, []); assert.ok(rec.missing.includes('route') && rec.missing.includes('person'))
  assert.equal(rec.score_after, evidenceScore({ date: false, domain: true, person: false, route: false }, null))
})

test('same company: a subdomain page and an address at the company still fill the route (score +10)', () => {
  const { db, jobId } = lead('alpha.co.uk')
  const before = snapshotLeads(db, 'u1', jobId)
  enr(db, 'email', 'founder@mail.alpha.co.uk', 'https://careers.alpha.co.uk/contact')
  const [rec] = completeLeads(db, { id: jobId, user_id: 'u1' }, before)
  assert.deepEqual(rec.filled, ['route'])
  assert.equal(rec.score_after - evidenceScore({ date: false, domain: true, person: false, route: false }, null), 10)
})

test('other multi-label and private suffixes: com.au, github.io never share an identity across owners', () => {
  for (const [own, other] of [['alpha.com.au', 'beta.com.au'], ['alpha.github.io', 'beta.github.io'], ['alpha.co.jp', 'beta.co.jp']]) {
    const { db, jobId } = lead(own)
    enr(db, 'phone', '+1 555 0100', `https://${other}/contact`); enr(db, 'email', `ceo@${other}`, `https://${own}/contact`)
    assert.deepEqual(snap(db, jobId), { domain: true, person: false, route: false }, own)
    enr(db, 'phone', '+1 555 0101', `https://www.${own}/contact`)
    assert.deepEqual(snap(db, jobId), { domain: true, person: false, route: true }, `${own} own page`)
  }
})

test('malformed hosts and emails are no identity', () => {
  assert.equal(reg('co.uk'), null); assert.equal(reg('localhost'), null); assert.equal(reg('10.0.0.1'), null); assert.equal(reg('a..b.com'), null); assert.equal(reg('-x.com'), null); assert.equal(reg(''), null)
  assert.equal(reg('https://WWW.Careers.Alpha.co.uk:443/x?y'), 'alpha.co.uk'); assert.equal(reg('alpha.co.uk.'), 'alpha.co.uk')
  assert.equal(emailReg('a@b@alpha.co.uk'), null); assert.equal(emailReg('@alpha.co.uk'), null); assert.equal(emailReg('founder alpha.co.uk'), null); assert.equal(emailReg('x@co.uk'), null)
  assert.equal(emailReg('Founder@Alpha.co.uk'), 'alpha.co.uk')
  const { db, jobId } = lead('alpha.co.uk')
  enr(db, 'email', 'a@b@alpha.co.uk', 'https://alpha.co.uk/contact'); enr(db, 'phone', '+1 555', 'http://')
  assert.deepEqual(snap(db, jobId), { domain: true, person: false, route: false })
})

test('a guessed (unconfirmed) domain is not broadened into a confirmed one', () => {
  const { db, jobId } = lead('alpha.co.uk')
  db.prepare("DELETE FROM lead_enrichments WHERE kind = 'domain'").run()
  enr(db, 'email', 'founder@alpha.co.uk', 'https://alpha.co.uk/contact')
  assert.deepEqual(snap(db, jobId), { domain: false, person: false, route: false })
})
