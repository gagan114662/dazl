// #910: lead completion scoring uses public-suffix-aware company identity (the shared site-contact rule), so another company's contact
// under the same multi-label or private suffix (alpha.co.uk vs unrelated.co.uk, acme.github.io vs other.github.io) never fills a fact or
// adds score. Actual snapshotLeads -> completeLeads on migrated in-memory SQLite; the filled/missing record and score deltas are checked.
// Synthetic companies, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, addEnrichment } from '../lib/connectors/store.ts'
import { snapshotLeads, completeLeads, evidenceScore } from '../lib/scan/completion.ts'

function setup(domain: string, opts: { confirmedAs?: string | null } = {}) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const id = createJob(db, 'A', { business_name: 'Seller', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ who: ['Owner'] }), id)
  db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, score, fit, event_date, company_domain) VALUES ('L1', ?, 'Alpha', 's', 'https://news.example/a', 80, 70, 5, ?, ?)").run(id, new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10), domain)
  const put = (kind: string, value: string, url: string) => addEnrichment(db, 'A', 'L1', { connector: 'sitecrawl', kind, value, label: '', confidence: null, source_url: url, source_date: '2026-11-01', retrieved_at: 1 })
  const conf = opts.confirmedAs === undefined ? domain : opts.confirmedAs
  if (conf) put('domain', `${conf}|evidence_own_domain`, `https://${conf}/news`)
  const job = { id, user_id: 'A' }
  const before = () => snapshotLeads(db, 'A', id)
  const complete = (b: ReturnType<typeof before>) => { const [r] = completeLeads(db, job, b, { windowed: true }); return { r, score: (db.prepare("SELECT score FROM leads WHERE id = 'L1'").get() as { score: number }).score } }
  return { db, put, before, complete }
}
const BASE = evidenceScore({ date: true, domain: true, person: false, route: false }, 5)   // a dated lead with a confirmed domain only

test('#910 audit reproduction: founder@unrelated.co.uk from unrelated.co.uk does not fill the route of alpha.co.uk, and adds no score', () => {
  const s = setup('alpha.co.uk')
  const b = s.before()
  assert.deepEqual([b[0].domain, b[0].route], [true, false])
  s.put('email', 'founder@unrelated.co.uk', 'https://unrelated.co.uk/contact')
  const { r, score } = s.complete(b)
  assert.equal(r.after.route, false); assert.deepEqual(r.filled, []); assert.deepEqual(r.missing, ['person', 'route'])
  assert.equal(r.score_after, BASE); assert.equal(score, BASE)
})

test('#910 unrelated person / phone / email under a shared multi-label or private suffix fill nothing', () => {
  const cases: [string, string, [string, string, string][]][] = [
    ['co.uk', 'alpha.co.uk', [['person', 'Pat Doe, Owner', 'https://unrelated.co.uk/team'], ['phone', '+44 20 7946 0000', 'https://unrelated.co.uk/contact'], ['email', 'pat@unrelated.co.uk', 'https://unrelated.co.uk/contact']]],
    ['com.au', 'alpha.com.au', [['person', 'Pat Doe, Owner', 'https://beta.com.au/team'], ['phone', '+61 2 5550 0000', 'https://beta.com.au/c']]],
    ['github.io (private suffix)', 'acme.github.io', [['person', 'Pat Doe, Owner', 'https://other.github.io/team'], ['email', 'pat@other.github.io', 'https://other.github.io/c']]],
    ['email at the company, page on another site', 'alpha.co.uk', [['email', 'pat@alpha.co.uk', 'https://unrelated.co.uk/contact']]],
    ['page on the company, email at another site', 'alpha.co.uk', [['email', 'pat@unrelated.co.uk', 'https://alpha.co.uk/contact']]],
    ['malformed email and source page', 'alpha.co.uk', [['email', 'pat@@alpha.co.uk', 'https://alpha.co.uk/contact'], ['email', 'pat@alpha..co.uk', 'https://alpha.co.uk/c'], ['person', 'Pat Doe, Owner', 'https://alpha_co.uk/team'], ['phone', '+44 20 7946 0000', 'http%invalid']]],
  ]
  for (const [name, domain, rows] of cases) {
    const s = setup(domain); const b = s.before()
    for (const [k, v, u] of rows) s.put(k, v, u)
    const { r, score } = s.complete(b)
    assert.deepEqual([r.after.domain, r.after.person, r.after.route], [true, false, false], name)
    assert.deepEqual(r.filled, [], name); assert.equal(score, BASE, name)
  }
})

test('#910 same-company contacts are still accepted: the apex, subdomains, multi-label and private suffixes', () => {
  const cases: [string, string, [string, string, string][]][] = [
    ['co.uk apex', 'alpha.co.uk', [['person', 'Pat Doe, Owner', 'https://alpha.co.uk/team'], ['email', 'pat@alpha.co.uk', 'https://alpha.co.uk/contact']]],
    ['co.uk subdomains', 'alpha.co.uk', [['person', 'Pat Doe, Owner', 'https://www.alpha.co.uk/team'], ['email', 'pat@mail.alpha.co.uk', 'https://shop.alpha.co.uk/contact']]],
    ['com.au', 'alpha.com.au', [['person', 'Pat Doe, Owner', 'https://alpha.com.au/team'], ['phone', '+61 2 5550 0000', 'https://alpha.com.au/c']]],
    ['github.io', 'acme.github.io', [['person', 'Pat Doe, Owner', 'https://acme.github.io/team'], ['email', 'pat@acme.github.io', 'https://acme.github.io/c']]],
  ]
  for (const [name, domain, rows] of cases) {
    const s = setup(domain); const b = s.before()
    for (const [k, v, u] of rows) s.put(k, v, u)
    const { r, score } = s.complete(b)
    assert.deepEqual([r.after.person, r.after.route], [true, true], name)
    assert.deepEqual(r.filled, ['person', 'route'], name); assert.deepEqual(r.missing, [], name)
    assert.equal(score, evidenceScore({ date: true, domain: true, person: true, route: true }, 5), name)
  }
})

test('#910 exact-domain confirmation is preserved: a confirmed sibling or parent does not confirm the lead domain, and a malformed domain fills nothing', () => {
  for (const [name, domain, confirmedAs] of [
    ['confirmation is for another company under the same suffix', 'alpha.co.uk', 'unrelated.co.uk'],
    ['confirmation is for a subdomain only', 'alpha.co.uk', 'shop.alpha.co.uk'],
    ['malformed company domain', 'alpha..co.uk', 'alpha..co.uk'],
    ['bare public suffix', 'co.uk', 'co.uk'],
  ] as const) {
    const s = setup(domain, { confirmedAs }); const b = s.before()
    s.put('person', 'Pat Doe, Owner', `https://${confirmedAs}/team`); s.put('email', `pat@${confirmedAs}`, `https://${confirmedAs}/c`)
    const { r, score } = s.complete(b)
    assert.deepEqual([r.after.domain, r.after.person, r.after.route], [false, false, false], name)
    assert.equal(score, evidenceScore({ date: true, domain: false, person: false, route: false }, 5), name)
  }
})
