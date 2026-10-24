import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, addEnrichment } from '../lib/connectors/store.ts'
import { domainReviewFor } from '../lib/outreach/domain-review.ts'
import { domainBasisFor } from '../lib/outreach/published-email.ts'
import { setDomainReview } from '../lib/scan/domain-review-action.ts'

type Row = { connector: string; kind: string; value: string; label: string | null; source_url: string; retrieved_at: number }
const email = (v = 'info@acme.test', url = 'https://acme.test/contact', at = 10): Row => ({ connector: 'sitecrawl', kind: 'email', value: v, label: null, source_url: url, retrieved_at: at })
const dom = (domain: string, basis: string, url: string, at = 10): Row => ({ connector: 'sitecrawl', kind: 'domain', value: `${domain}|${basis}`, label: `domain-basis-v1:${basis}`, source_url: url, retrieved_at: at })
const lead = { id: 'a'.repeat(24), contact: null }

test('which bases need the user identity review', () => {
  assert.equal(domainReviewFor(lead, [email(), dom('acme.test', 'evidence_own_domain', 'https://acme.test/careers/1')]).state, 'not_required')
  for (const b of ['evidence_link_domain_label', 'evidence_link_text', 'name_probe']) assert.equal(domainReviewFor(lead, [email(), dom('acme.test', b, 'https://x.test/p')]).state, 'required', b)
  assert.equal(domainReviewFor(lead, [email()]).state, 'required', 'unrecorded crawl provenance is not grandfathered')
  assert.equal(domainReviewFor({ id: lead.id, contact: 'sales@cited.test' }, [email()]).state, 'not_required', 'an address printed on the cited page needs no website review (that is not company verification either)')
  assert.equal(domainReviewFor(lead, []).state, 'not_required', 'no crawled address, nothing to review')
})

test('trust reads the stored token only, never display prose', () => {
  const prose: Row = { connector: 'sitecrawl', kind: 'domain', value: 'acme.test', label: 'domain basis: the cited page is on this domain; homepage names the company', source_url: 'https://acme.test/c', retrieved_at: 1 }
  assert.equal(domainBasisFor('info@acme.test', [prose]).kind, 'unrecorded')
  const mismatched: Row = { ...dom('acme.test', 'evidence_own_domain', 'https://acme.test/c'), label: 'domain-basis-v1:name_probe' }
  assert.equal(domainBasisFor('info@acme.test', [mismatched]).kind, 'unrecorded', 'value token and label token must agree')
  assert.equal(domainBasisFor('info@acme.test', [{ ...dom('acme.test', 'made_up', 'https://acme.test/c'), label: 'domain-basis-v1:made_up' }]).kind, 'unrecorded')
  // an address on a different host than any recorded domain is not covered by it
  assert.equal(domainBasisFor('info@other.test', [dom('acme.test', 'evidence_own_domain', 'https://acme.test/c')]).kind, 'unrecorded')
  assert.equal(domainBasisFor('info@evilacme.test', [dom('acme.test', 'evidence_own_domain', 'https://acme.test/c')]).kind, 'unrecorded', 'suffix text is not a subdomain')
  assert.equal(domainBasisFor('info@mail.acme.test', [dom('acme.test', 'evidence_own_domain', 'https://acme.test/c')]).kind, 'own_domain')
})

test('the review is bound to lead, domain, basis, pages, address and every recorded domain; weakest basis governs', () => {
  const rows = [email(), dom('acme.test', 'evidence_link_domain_label', 'https://jobs.test/a')]
  const d0 = domainReviewFor(lead, rows)
  const reviewed = (d = d0): Row => ({ connector: 'user', kind: 'domain_review', value: d.domain!, label: 'domain-review-v1:' + d.binding!, source_url: 'https://jobs.test/a', retrieved_at: 20 })
  assert.equal(domainReviewFor(lead, [...rows, reviewed()]).state, 'confirmed')
  // another lead id, a different address, a different address page: unmatched
  assert.equal(domainReviewFor({ id: 'b'.repeat(24), contact: null }, [...rows, reviewed()]).state, 'required')
  assert.equal(domainReviewFor(lead, [email('sales@acme.test'), rows[1], reviewed()]).state, 'required')
  assert.equal(domainReviewFor(lead, [email('info@acme.test', 'https://acme.test/about'), rows[1], reviewed()]).state, 'required')
  // the same domain later reached a weaker way: the weaker basis governs and the old review no longer matches
  const weaker = domainReviewFor(lead, [...rows, dom('acme.test', 'name_probe', 'https://acme.test/', 30), reviewed()])
  assert.equal(weaker.state, 'required'); assert.equal(weaker.basis, 'name_probe')
  // a stronger row added later does not upgrade it, and does not keep a review that matched the old set
  const stronger = domainReviewFor(lead, [email(), dom('acme.test', 'name_probe', 'https://acme.test/'), dom('acme.test', 'evidence_own_domain', 'https://acme.test/careers/1', 40)])
  assert.equal(stronger.state, 'required'); assert.equal(stronger.basis, 'name_probe')
  // a second company domain for the same lead is a contradiction: needs a new review, even if one is own_domain
  assert.equal(domainReviewFor(lead, [email(), dom('acme.test', 'evidence_own_domain', 'https://acme.test/c'), dom('acme-other.test', 'evidence_link_text', 'https://x.test/p')]).state, 'required')
  // a review for a different domain value does not count
  assert.equal(domainReviewFor(lead, [...rows, { ...reviewed(), value: 'other.test' }]).state, 'required')
  // another user's tenant rows are never read here (callers filter tenant); a review written under connector other than user is ignored
  assert.equal(domainReviewFor(lead, [...rows, { ...reviewed(), connector: 'sitecrawl' }]).state, 'required')
})

test('setDomainReview: confirm, withdraw, tenant scope, no-op for cited-page and own-domain leads', () => {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobA = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobA)
  const ins = db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
  const L = (n: number) => String(n).repeat(24).slice(0, 24)
  ins.run(L(1), jobA, 'Acme', null, 's', 'https://jobs.test/a', 'q', 90, 50)
  ins.run(L(2), jobA, 'Cited', 'sales@cited.test', 's', 'https://cited.test/a', 'q', 90, 50)
  ins.run(L(3), jobA, 'Own', null, 's', 'https://own.test/jobs/1', 'q', 90, 50)
  const put = (id: string, e: { kind: string; value: string; label: string; source_url: string }) => addEnrichment(db, 'A', id, { connector: 'sitecrawl', ...e, confidence: null, source_date: '2026-10-24', retrieved_at: 10 })
  put(L(1), { kind: 'email', value: 'info@acme.test', label: '', source_url: 'https://acme.test/contact' }); put(L(1), { kind: 'domain', value: 'acme.test|name_probe', label: 'domain-basis-v1:name_probe', source_url: 'https://acme.test/' })
  put(L(3), { kind: 'email', value: 'info@own.test', label: '', source_url: 'https://own.test/contact' }); put(L(3), { kind: 'domain', value: 'own.test|evidence_own_domain', label: 'domain-basis-v1:evidence_own_domain', source_url: 'https://own.test/jobs/1' })
  const rows = (id: string) => db.prepare("SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ? AND tenant_id = 'A'").all(id) as Row[]
  assert.equal(domainReviewFor({ id: L(1), contact: null }, rows(L(1))).state, 'required')
  const bindingNow = () => domainReviewFor({ id: L(1), contact: null }, rows(L(1))).binding!
  const b0 = bindingNow()
  assert.deepEqual(setDomainReview(db, 'B', L(1), 'confirm', b0), { status: 'not_found' }, 'another tenant cannot review')
  assert.deepEqual(setDomainReview(db, 'B', L(1), 'withdraw'), { status: 'not_found' })
  assert.deepEqual(setDomainReview(db, 'A', L(2), 'confirm', b0), { status: 'not_required' })
  assert.deepEqual(setDomainReview(db, 'A', L(3), 'confirm', b0), { status: 'not_required' })
  // the page showed the old state; the server changed after the page loaded: confirm records nothing
  assert.deepEqual(setDomainReview(db, 'A', L(1), 'confirm', undefined), { status: 'stale' }, 'no binding is never a blind confirm')
  assert.deepEqual(setDomainReview(db, 'A', L(1), 'confirm', 'f'.repeat(64)), { status: 'stale' })
  put(L(1), { kind: 'email', value: 'sales@acme.test', label: '', source_url: 'https://acme.test/team' })
  db.prepare("UPDATE lead_enrichments SET retrieved_at = 50 WHERE value = 'sales@acme.test'").run()
  assert.deepEqual(setDomainReview(db, 'A', L(1), 'confirm', b0), { status: 'stale' }, 'address changed after the page loaded')
  assert.equal((db.prepare("SELECT count(*) n FROM lead_enrichments WHERE kind = 'domain_review'").get() as { n: number }).n, 0)
  db.prepare("DELETE FROM lead_enrichments WHERE value = 'sales@acme.test'").run()
  assert.deepEqual(setDomainReview(db, 'A', L(1), 'confirm', b0), { status: 'confirmed', domain: 'acme.test' })
  assert.equal(domainReviewFor({ id: L(1), contact: null }, rows(L(1))).state, 'confirmed')
  assert.equal((db.prepare("SELECT count(*) n FROM lead_enrichments WHERE kind = 'domain_review'").get() as { n: number }).n, 1)
  // a new weaker or different candidate invalidates it without any deletion
  put(L(1), { kind: 'domain', value: 'acme-other.test|evidence_link_text', label: 'domain-basis-v1:evidence_link_text', source_url: 'https://x.test/p' })
  assert.equal(domainReviewFor({ id: L(1), contact: null }, rows(L(1))).state, 'required')
  assert.deepEqual(setDomainReview(db, 'A', L(1), 'withdraw'), { status: 'withdrawn' })
  assert.equal((db.prepare("SELECT count(*) n FROM lead_enrichments WHERE kind = 'domain_review'").get() as { n: number }).n, 0)
})

test('confirm takes the write lock before reading: a concurrent writer on the same file cannot slip between check and write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dr-')); const f = join(dir, 'a.db')
  const a = new Database(f); const b = new Database(f, { timeout: 0 })
  migrateScan(a); migrateConnectors(a)
  const job = createJob(a, 'A', { business_name: 'S', industry: 'x', location: 'y' }); a.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const id = 'd'.repeat(24)
  a.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)').run(id, job, 'Acme', null, 's', 'https://jobs.test/a', 'q', 90, 50)
  const ins = a.prepare("INSERT INTO lead_enrichments (tenant_id, lead_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES ('A', ?, 'sitecrawl', ?, ?, ?, ?, '2026-10-24', 10)")
  ins.run(id, 'email', 'info@acme.test', null, 'https://acme.test/contact'); ins.run(id, 'domain', 'acme.test|name_probe', 'domain-basis-v1:name_probe', 'https://acme.test/')
  const bind = domainReviewFor({ id, contact: null }, a.prepare('SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ?').all(id) as never).binding!
  a.exec('BEGIN IMMEDIATE')
  assert.throws(() => setDomainReview(b, 'A', id, 'confirm', bind), /locked|busy/i, 'blocked while another writer holds the lock, not a stale read')
  a.exec('COMMIT')
  assert.deepEqual(setDomainReview(b, 'A', id, 'confirm', bind), { status: 'confirmed', domain: 'acme.test' })
  a.close(); b.close(); rmSync(dir, { recursive: true })
})

test('createDraft reads the identity state under the write lock: a concurrent writer blocks it, and a withdraw committed first blocks the draft', async () => {
  const { createDraft } = await import('../lib/outreach/service.ts')
  const { migrateOutreach } = await import('../lib/outreach/store.ts')
  const dir = mkdtempSync(join(tmpdir(), 'dr2-')); const f = join(dir, 'a.db')
  const a = new Database(f); const b = new Database(f, { timeout: 0 })
  migrateScan(a); migrateOutreach(a); migrateConnectors(a)
  const job = createJob(a, 'A', { business_name: 'S', industry: 'x', location: 'y' }); a.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const id = 'e'.repeat(24)
  a.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,human_confirmed_at,human_confirmed_from) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, job, 'Acme', null, 's', 'https://jobs.test/a', 'q', 90, 50, 1800000000, 'test_review')
  const ins = a.prepare("INSERT INTO lead_enrichments (tenant_id, lead_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES ('A', ?, 'sitecrawl', ?, ?, ?, ?, '2026-10-24', 10)")
  ins.run(id, 'email', 'info@acme.test', null, 'https://acme.test/contact'); ins.run(id, 'domain', 'acme.test|name_probe', 'domain-basis-v1:name_probe', 'https://acme.test/')
  const bind = domainReviewFor({ id, contact: null }, a.prepare('SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ?').all(id) as never).binding!
  assert.deepEqual(setDomainReview(a, 'A', id, 'confirm', bind), { status: 'confirmed', domain: 'acme.test' })
  a.exec('BEGIN IMMEDIATE')
  assert.throws(() => createDraft(b, 'A', id, 'Seller'), /locked|busy/i)
  setDomainReview(a, 'A', id, 'withdraw')
  a.exec('COMMIT')
  assert.throws(() => createDraft(b, 'A', id, 'Seller'), /domain_unconfirmed/, 'withdraw committed before the draft: no draft')
  assert.equal((a.prepare('SELECT count(*) n FROM outreach_messages').get() as { n: number }).n, 0)
  a.close(); b.close(); rmSync(dir, { recursive: true })
})
