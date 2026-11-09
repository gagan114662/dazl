// #943 review: resolution, completion and the scoreboard read the SAME current-site-contact rule as actionability, and contact selection is order-independent.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, addEnrichment } from '../lib/connectors/store.ts'
import { resolveFacts } from '../lib/scan/resolution.ts'
import { snapshotLeads } from '../lib/scan/completion.ts'
import { currentSiteContact, type SiteRow } from '../lib/scan/site-contact.ts'

const today = new Date().toISOString().slice(0, 10)
const ICP = JSON.stringify({ who: ['Founder'], window_days: 90 })
function seed(domain: string, confirm: boolean, contactHost: string) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(ICP, jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt, confidence, score, event_date) VALUES ('L1', ?, '', 'Alpha', ?, 's', 'https://news.example/x', 'e', 80, 70, ?)").run(jobId, domain, today)
  const put = (kind: string, value: string, host: string, label: string | null = null) => addEnrichment(db, 'u1', 'L1', { connector: 'sitecrawl', kind, value, label, confidence: null, source_url: `https://${host}/p`, source_date: today, retrieved_at: 10 })
  if (confirm) put('domain', `${domain}|evidence_own_domain`, domain, 'domain-basis-v1:evidence_own_domain')
  put('person', 'Jo Roe, Founder', contactHost); put('phone', '+1 555 0100', contactHost)
  return { db, job: { id: jobId, user_id: 'u1', icp: ICP } }
}

test('resolution: a populated but unconfirmed domain is not confirmed identity and its contacts are not attached', () => {
  const { db, job } = seed('alpha.example', false, 'alpha.example')
  const [r] = resolveFacts(db, job); assert.equal(r.identity, 'unconfirmed'); assert.equal(r.contact, 'missing'); assert.equal(r.resolved, false)
})
test('resolution: a contact from a foreign site under a confirmed domain is not attached', () => {
  const { db, job } = seed('alpha.example', true, 'other.example')
  const [r] = resolveFacts(db, job); assert.equal(r.identity, 'confirmed'); assert.equal(r.contact, 'missing')
})
test('completion: alpha.co.uk does not earn contact points from unrelated beta.co.uk (public-suffix aware)', () => {
  const { db, job } = seed('alpha.co.uk', true, 'beta.co.uk')
  const [s] = snapshotLeads(db, 'u1', job.id); assert.deepEqual([s.domain, s.person, s.route], [true, false, false])
  const own = seed('alpha.co.uk', true, 'alpha.co.uk'); const [o] = snapshotLeads(own.db, 'u1', own.job.id); assert.deepEqual([o.person, o.route], [true, true])
})
test('contact selection does not depend on the order rows are returned in', () => {
  const { db } = seed('alpha.example', true, 'alpha.example')
  const rows: SiteRow[] = [
    { connector: 'sitecrawl', kind: 'person', value: 'Zed One, Founder', source_url: 'https://alpha.example/a' },
    { connector: 'sitecrawl', kind: 'person', value: 'Amy Two, Founder', source_url: 'https://alpha.example/b' },
    { connector: 'sitecrawl', kind: 'phone', value: '+1 555 0200', source_url: 'https://alpha.example/c' },
    { connector: 'sitecrawl', kind: 'phone', value: '+1 555 0100', source_url: 'https://alpha.example/d' },
  ]
  const pick = (r: SiteRow[]) => { const c = currentSiteContact(db, 'u1', { id: 'L1', company_domain: 'alpha.example' }, 'founder', r); return [c.person?.value, c.route?.value] }
  assert.deepEqual(pick(rows), pick([...rows].reverse())); assert.deepEqual(pick(rows), ['Amy Two, Founder', '+1 555 0100'])
})
