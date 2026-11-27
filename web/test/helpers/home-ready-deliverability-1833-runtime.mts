import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { addEnrichment } from '../../lib/connectors/store.ts'
import { homeReady } from '../../lib/outreach/home-ready.ts'
import { ownSiteBuyerRows } from './own-site-buyer.ts'

const NOW = Math.floor(Date.now() / 1000), DAY = 86400
const recent = new Date(Date.now() - 5 * DAY * 1000).toISOString().slice(0, 10)

function seed() {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  setScanDb(db); setUser({ id: 'A', business_name: 'Acme' })
  const J = 'a'.repeat(24)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, status, candidates, created_at) VALUES (?, 'A', 'x', '(from request)', '-', 'Dental practices in Ohio that opened a new location', NULL, 'running', 5, ?)")
    .run(J, NOW - 3 * DAY)
  const lead = (id: string, verdict: string | null, domainRow = false, candidate = false, alternate = false) => {
    const domain = `${id}.example`
    db.prepare(`INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, review_reason, event_date, date_status, event_date_proof, fit, created_at, quarantined_at, human_confirmed_at, seen_before, company_domain, source_kind, contact)
      VALUES (?, ?, ?, 'opened a new location', 'https://news.example/a', 80, 'opened a new location', NULL, ?, 'unverified', 'page_bound', NULL, ?, NULL, ?, 0, ?, NULL, ?)`)
      .run(id, J, `Co ${id}`, recent, NOW - DAY, NOW - DAY, domain, `dana@${domain}`)
    for (const r of ownSiteBuyerRows(domain)) addEnrichment(db, 'A', id, r)
    addEnrichment(db, 'A', id, { connector: 'sitecrawl', kind: 'email', value: `dana@${domain}`, label: null, confidence: null, source_url: `https://${domain}/contact`, source_date: recent, retrieved_at: NOW })
    if (alternate) {
      addEnrichment(db, 'A', id, { connector: 'sitecrawl', kind: 'email', value: `dana.buyer@${domain}`, label: null, confidence: null, source_url: `https://${domain}/contact`, source_date: recent, retrieved_at: NOW })
      addEnrichment(db, 'A', id, { connector: 'scan:deliverability', kind: 'deliverability', value: `dana.buyer@${domain}|accepted`, label: null, confidence: null, source_url: `https://${domain}/contact`, source_date: recent, retrieved_at: NOW })
    }
    if (candidate) db.prepare("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format, verification, checked_at) VALUES ('A', ?, 'Dana Buyer', ?, 'first', 'undeliverable', ?)").run(id, `dana@${domain}`, NOW)
    if (verdict) addEnrichment(db, 'A', id, { connector: 'scan:deliverability', kind: 'deliverability', value: `${domainRow ? `@${domain}` : `dana@${domain}`}|${verdict}`, label: null, confidence: null, source_url: `https://${domain}/contact`, source_date: recent, retrieved_at: NOW })
  }
  lead('rejected', 'rejected')
  lead('nomx', 'no_mx', true)
  lead('ok', 'accepted')
  lead('candidate', null, false, true)
  lead('alternate', 'rejected', false, false, true)
  lead('unknown', null)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(J)
  return db
}

test('#1833 refused addresses are held and an accepted address still shows', async () => {
  seed()
  const r = await homeReady('A', NOW)
  const by = Object.fromEntries(r.companies.map(c => [c.lead_id, c]))
  assert.deepEqual(r.companies.map(c => c.lead_id).sort(), ['alternate', 'candidate', 'nomx', 'ok', 'rejected', 'unknown'], 'all companies are judged')
  assert.equal(by.ok.ready, true)
  assert.equal(by.ok.details?.email, 'dana@ok.example', 'an accepted address still shows')
  assert.ok(!by.ok.details?.email_undeliverable)
  assert.equal(by.unknown.ready, true)
  assert.equal(by.alternate.ready, true)
  for (const id of ['rejected', 'nomx', 'candidate']) {
    assert.equal(by[id].ready, false, `${id} is held`)
    assert.equal(by[id].reason, "email can't receive mail")
    assert.equal(by[id].details, undefined, 'the refused address is not shown as usable')
  }
})
