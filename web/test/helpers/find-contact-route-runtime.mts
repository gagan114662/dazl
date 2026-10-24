import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb } from './sequence-route-db.ts'
import { installFixtureTransport } from './fixture-company-transport.ts'
import { migrateScan, createJob } from '../../lib/scan/store.ts'
import { migrateOutreach } from '../../lib/outreach/store.ts'
import { migrateConnectors } from '../../lib/connectors/store.ts'
import { migrateMemory, saveMemory } from '../../lib/memory.ts'
import { createDraft } from '../../lib/outreach/service.ts'
import { domainReviewFor } from '../../lib/outreach/domain-review.ts'
import { publishedContact } from '../../lib/outreach/published-email.ts'
import { confirmLeadReview } from '../../lib/scan/review-confirm.ts'
import { POST } from '../../app/api/leads/[lead]/find-contact/route.ts'
import { POST as REVIEW } from '../../app/api/leads/[lead]/domain-review/route.ts'

// Real route + real crawler + real stores. Only the https transport is mapped to a loopback fixture server.
const html = (b: string) => `<html><body>${b}</body></html>`
const t = await installFixtureTransport({
  'jobboard.test': { '/a': html('<a href="https://acmeroofing.test/">site</a>'), '/b': html('<a href="https://otherco.test/">site</a>'), '/c': html('<a href="https://blockedco.test/">site</a>'), '/d': html('<a href="https://acmeroofing.test/">site</a>') },
  'acmeroofing.test': { '/robots.txt': 'User-agent: *\nAllow: /', '/': html('Acme Roofing <a href="/contact">Contact</a>'), '/contact': html('<a href="mailto:hello@acmeroofing.test">hello</a>') },
  'otherco.test': { '/robots.txt': '', '/': html('Totally Different Company Ltd'), '/contact': html('info@otherco.test') },
  'blockedco.test': { '/robots.txt': 'User-agent: *\nDisallow: /', '/': html('Blocked Co'), '/contact': html('hello@blockedco.test') },
})

const db = new Database(':memory:')
migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateMemory(db)
saveMemory(db, 'A', { positioning: 'Synthetic fixture offer.' })
const job = createJob(db, 'A', { business_name: 'Seller', industry: 'x', location: 'y' })
const jobB = createJob(db, 'B', { business_name: 'Other', industry: 'x', location: 'y' })
for (const j of [job, jobB]) db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(j)
const ins = db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,review_reason,score,source_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
const ID = (n: number) => String(n).repeat(24).slice(0, 24)
ins.run(ID(1), job, 'Acme Roofing', null, 'Acme Roofing is hiring a sales rep', 'https://jobboard.test/a', 'Acme Roofing is hiring a sales rep', null, 'source_review_required', 50, null)
ins.run(ID(2), job, 'Acme Roofing', null, 'x', 'https://jobboard.test/a', 'x', null, 'source_review_required', 50, null)       // never confirmed
ins.run(ID(3), job, 'handle123', null, 'Ask HN', 'https://jobboard.test/a', 'x', null, 'author_post', 50, null)               // person handle
ins.run(ID(4), job, 'Acme Roofing', null, 'x', 'https://jobboard.test/a', 'x', null, 'source_review_required', 50, null)      // other user's lead (job B)
db.prepare('UPDATE leads SET scan_job_id = ? WHERE id = ?').run(jobB, ID(4))
ins.run(ID(5), job, 'Different Corp', null, 'x', 'https://jobboard.test/b', 'x', null, 'source_review_required', 50, null)    // homepage names someone else
ins.run(ID(6), job, 'Blocked Co', null, 'x', 'https://jobboard.test/c', 'x', null, 'source_review_required', 50, null)       // robots disallow
for (const n of [1, 3, 5, 6]) confirmLeadReview(db, 'A', ID(n))
setScanDb(db)

const post = (id: string, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  POST(new NextRequest(`http://localhost/api/leads/${id}/find-contact`, { method: 'POST', headers, body: '{}' }), { params: Promise.resolve({ lead: id }) })
const enr = (id: string) => db.prepare('SELECT connector, kind, value, source_url FROM lead_enrichments WHERE lead_id = ?').all(id)

test('route refusals: origin, id shape, other user, unconfirmed, person handle, switched off', async () => {
  assert.equal((await post(ID(1), { 'content-type': 'text/plain' })).status, 403)
  assert.equal((await post(ID(1), { 'content-type': 'application/json', origin: 'https://evil.example', host: 'localhost' })).status, 403)
  assert.equal((await post('nope')).status, 404)
  assert.equal((await post(ID(4))).status, 404)
  assert.equal((await post(ID(2))).status, 409)
  assert.equal((await post(ID(3))).status, 422)
  process.env.SITECRAWL_ENABLED = '0'
  assert.equal((await post(ID(1))).status, 503)
  delete process.env.SITECRAWL_ENABLED
  assert.deepEqual(t.hits, [], 'no fixture request made for any refused call')
  assert.deepEqual(enr(ID(1)), [])
})

test('click path: confirmed company row -> own-domain mailbox stored with its page URL -> contact available -> draft gate passes', async () => {
  assert.equal(publishedContact({ contact: null, enrichments: [] } as never), null)
  const res = await post(ID(1))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { searched: true, found: 1 })
  assert.deepEqual(enr(ID(1)), [
    { connector: 'sitecrawl', kind: 'domain', value: 'acmeroofing.test|evidence_link_domain_label', source_url: 'https://jobboard.test/a' },
    { connector: 'sitecrawl', kind: 'email', value: 'hello@acmeroofing.test', source_url: 'https://acmeroofing.test/contact' },
  ])
  const e = db.prepare('SELECT connector, kind, value, label, source_url FROM lead_enrichments WHERE lead_id = ?').all(ID(1)) as never[]
  const pcl = publishedContact({ contact: null, enrichments: e } as never)!
  assert.equal(pcl.email, 'hello@acmeroofing.test')
  assert.deepEqual({ basis: pcl.domainBasis, url: pcl.domainBasisSourceUrl }, { basis: 'linked', url: 'https://jobboard.test/a' })
  assert.ok(t.hits.every(h => /\.test\//.test(h) || /\.test$/.test(h.split('/')[0])))
  // The site was only linked from the cited page: the draft waits for the user's identity review, through the real route.
  assert.throws(() => createDraft(db, 'A', ID(1), 'Seller'), /domain_unconfirmed/)
  const bind = () => domainReviewFor({ id: ID(1), contact: null }, db.prepare("SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ?").all(ID(1)) as never).binding!
  const review = (id: string, action: string, headers: Record<string, string> = { 'content-type': 'application/json' }, binding: string | null = bind()) =>
    REVIEW(new NextRequest(`http://localhost/api/leads/${id}/domain-review`, { method: 'POST', headers, body: JSON.stringify({ action, binding }) }), { params: Promise.resolve({ lead: id }) })
  assert.equal((await review(ID(1), 'confirm', { 'content-type': 'text/plain' })).status, 403)
  assert.equal((await review(ID(4), 'confirm')).status, 404, 'another user\'s lead')
  assert.equal((await review(ID(1), 'bogus')).status, 400)
  assert.equal((await review(ID(1), 'confirm', undefined, null)).status, 400, 'confirm without the binding the user saw')
  const stale = await review(ID(1), 'confirm', undefined, 'e'.repeat(64))
  assert.deepEqual([stale.status, (await stale.json()).stale], [409, true])
  assert.equal((db.prepare("SELECT count(*) n FROM lead_enrichments WHERE kind = 'domain_review'").get() as { n: number }).n, 0)
  assert.deepEqual(await (await review(ID(1), 'confirm')).json(), { status: 'confirmed', domain: 'acmeroofing.test' })
  // createDraft's own gates decide: an address recorded by the crawl is used, nothing else is bypassed.
  const id = createDraft(db, 'A', ID(1), 'Seller')
  const m = db.prepare('SELECT to_email, status, test FROM outreach_messages WHERE id = ?').get(id) as { to_email: string; status: string; test: number }
  assert.deepEqual({ ...m }, { to_email: 'hello@acmeroofing.test', status: 'draft', test: 0 })
  assert.equal((db.prepare("SELECT count(*) AS n FROM outreach_messages WHERE status <> 'draft'").get() as { n: number }).n, 0, 'nothing was sent or approved')
})

test('shared domain, whole workflow: a scan with two leads on one company site -> one read of the site, both leads get rows, each needs its own identity review before its own draft', async () => {
  const { crawlJob } = await import('../../lib/connectors/sitecrawl.ts')
  const job2 = createJob(db, 'A', { business_name: 'Seller', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job2)
  const ins2 = db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,human_confirmed_at,human_confirmed_from) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  ins2.run(ID(7), job2, 'Acme Roofing', null, 'Acme Roofing is hiring a rep', 'https://jobboard.test/d', 'Acme Roofing is hiring a rep', 90, 60, 1800000000, 'test_review')
  ins2.run(ID(8), job2, 'Acme Roofing', null, 'Acme Roofing is hiring a closer', 'https://jobboard.test/d', 'Acme Roofing is hiring a closer', 90, 50, 1800000000, 'test_review')
  const before = t.hits.length
  await crawlJob(db, 'A', job2, { gapMs: 0, env: {}, now: Date.parse('2026-10-24T12:00:00Z') })
  const mine = t.hits.slice(before)
  assert.equal(mine.filter(h => h === 'acmeroofing.test/contact').length, 1, 'the company contact page is read once for the whole scan')
  assert.equal(mine.filter(h => h === 'acmeroofing.test/').length, 1, 'and so is the homepage')
  for (const n of [7, 8]) {
    const e = db.prepare('SELECT kind, value, label, source_url FROM lead_enrichments WHERE lead_id = ? AND kind IN (\'email\', \'domain\') ORDER BY kind').all(ID(n)) as { kind: string; value: string; label: string | null; source_url: string }[]
    assert.deepEqual(e.map(x => [x.kind, x.value]), [['domain', 'acmeroofing.test|evidence_link_domain_label'], ['email', 'hello@acmeroofing.test']], `lead ${n} has its own rows`)
    assert.equal(e[0].source_url, 'https://jobboard.test/d')
  }
  const bindOf = (n: number) => domainReviewFor({ id: ID(n), contact: null }, db.prepare('SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ?').all(ID(n)) as never).binding!
  assert.notEqual(bindOf(7), bindOf(8), 'the binding is per lead')
  const rv = (n: number) => REVIEW(new NextRequest(`http://localhost/api/leads/${ID(n)}/domain-review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'confirm', binding: bindOf(n) }) }), { params: Promise.resolve({ lead: ID(n) }) })
  assert.throws(() => createDraft(db, 'A', ID(7), 'Seller'), /domain_unconfirmed/)
  assert.throws(() => createDraft(db, 'A', ID(8), 'Seller'), /domain_unconfirmed/)
  assert.equal((await rv(7)).status, 200)
  assert.ok(createDraft(db, 'A', ID(7), 'Seller'), 'reviewed lead drafts')
  assert.throws(() => createDraft(db, 'A', ID(8), 'Seller'), /domain_unconfirmed/, 'the other lead on the same domain does not inherit that review')
  assert.equal((await rv(8)).status, 200)
  assert.ok(createDraft(db, 'A', ID(8), 'Seller'))
  assert.equal((db.prepare("SELECT count(*) AS n FROM outreach_messages WHERE status <> 'draft'").get() as { n: number }).n, 0, 'nothing sent or approved')
})

test('domain identity and robots: a homepage naming another company or disallowing the crawl stores nothing', async () => {
  for (const n of [5, 6]) {
    const r = await post(ID(n))
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { searched: true, found: 0 })
    assert.deepEqual(enr(ID(n)), [])
  }
  assert.ok(!t.hits.some(h => h.startsWith('blockedco.test/contact')), 'robots-disallowed contact page never requested')
  assert.throws(() => createDraft(db, 'A', ID(5), 'Seller'), /no_email_contact/)
  await t.close()
})
