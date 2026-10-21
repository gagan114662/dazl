import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { companyKey, dedupKey, verifyEvidence, type Candidate } from '../lib/scan/evidence.ts'
import { htmlToText, isPublicIp, safeFetchPage } from '../lib/scan/fetch-page.ts'
import { createJob, listLeads, migrateScan } from '../lib/scan/store.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { claimKeyedJob, runJob, verifyLeads } from '../lib/scan/runner.ts'
import { randomBytes } from 'node:crypto'

const NOW = new Date('2026-10-20T12:00:00Z')
const QUOTE = 'Northside Builders opened a second yard and is hiring five roofers this month'
const cand = (o: Partial<Candidate> = {}): Candidate => ({ name: '', company: 'Northside Builders Inc.', contact: null, signal: 'Expanding', source_url: 'https://northsidebuilders.example/a', score: 70, excerpt: QUOTE, event_date: '2026-10-01', ...o })
const page = (text: string, title = '') => ({ text, title, retrievedAt: 1_800_000_000 })
const good = page(`October 2026 local news. ${QUOTE}. Call 416-555-0199 or email jobs@northside.example.`)

test('good evidence passes with high confidence and a verified date', () => {
  const v = verifyEvidence(cand(), good, NOW)
  assert.equal(v.ok, true)
  if (v.ok) { assert.equal(v.dateStatus, 'verified'); assert.ok(v.confidence >= 80) }
})

test('quote that is not on the page is rejected (model invented or paraphrased it)', () => {
  const v = verifyEvidence(cand({ excerpt: 'Northside Builders just raised a huge funding round last week' }), good, NOW)
  assert.deepEqual(v, { ok: false, reason: 'excerpt_not_on_page' })
  assert.deepEqual(verifyEvidence(cand({ excerpt: 'too short' }), good, NOW), { ok: false, reason: 'no_excerpt' })
})

test('wrong company: quote is real but about someone else', () => {
  const p = page('Southside Roofing opened a second yard and is hiring five roofers this month. Northside Builders is a rival firm.')
  const v = verifyEvidence(cand({ excerpt: 'Southside Roofing opened a second yard and is hiring five roofers this month' }), p, NOW)
  assert.deepEqual(v, { ok: false, reason: 'entity_mismatch' })
  // company named only far from the quote and not in the title is not enough
  const far = page(`Northside Builders. ${'filler word '.repeat(200)} Acme Corp opened a second yard and is hiring five roofers this month`)
  assert.deepEqual(verifyEvidence(cand({ excerpt: 'Acme Corp opened a second yard and is hiring five roofers this month' }), far, NOW), { ok: false, reason: 'entity_mismatch' })
})

test('old news: claimed date too old, or page shows an older year than claimed', () => {
  assert.deepEqual(verifyEvidence(cand({ event_date: '2024-03-01' }), good, NOW), { ok: false, reason: 'stale' })
  const old = page(`Published March 2019. ${QUOTE}.`)
  assert.deepEqual(verifyEvidence(cand({ event_date: '2026-10-01' }), old, NOW), { ok: false, reason: 'date_conflict' })
  assert.deepEqual(verifyEvidence(cand({ event_date: '2027-05-01' }), good, NOW), { ok: false, reason: 'future_date' })
  assert.deepEqual(verifyEvidence(cand({ event_date: 'last Tuesday' }), good, NOW), { ok: false, reason: 'bad_date' })
})

test('undated or unverified dates lower confidence but can still pass; contacts only if on the page', () => {
  const undated = verifyEvidence(cand({ event_date: null }), page(`${QUOTE}.`), NOW)
  assert.equal(undated.ok, true)
  if (undated.ok) { assert.equal(undated.dateStatus, 'undated'); assert.equal(undated.confidence, 55) }
  const withContact = verifyEvidence(cand({ contact: 'jobs@northside.example' }), good, NOW)
  const fakeContact = verifyEvidence(cand({ contact: 'ceo@northside.example' }), good, NOW)
  assert.equal(withContact.ok && withContact.contact, 'jobs@northside.example')
  assert.equal(fakeContact.ok && fakeContact.contact, null)
  const phone = verifyEvidence(cand({ contact: '(416) 555-0199' }), good, NOW)
  assert.equal(phone.ok && phone.contact, '(416) 555-0199')
})

test('company key ignores legal suffixes and case; dedup picks the best lead per company', async () => {
  assert.equal(companyKey('The Northside Builders, Inc.'), 'northside builders')
  assert.equal(dedupKey({ company: 'NORTHSIDE BUILDERS LTD', name: 'x' }), dedupKey({ company: 'Northside Builders', name: 'y' }))
  const fetchPage = async (u: string) => (u.endsWith('/b') ? page(`Posted 2026. ${QUOTE}. Email jobs@northside.example`) : page(`${QUOTE}.`))
  const { leads, dropped } = await verifyLeads([
    cand({ source_url: 'https://northsidebuilders.example/a', event_date: null }),
    cand({ source_url: 'https://northsidebuilders.example/b', company: 'Northside Builders Ltd', contact: 'jobs@northside.example' }),
    cand({ source_url: 'https://northsidebuilders.example/c', excerpt: 'this quote does not exist anywhere on the page at all' }),
  ], fetchPage, NOW)
  assert.equal(leads.length, 1)
  assert.equal(leads[0].source_url, 'https://northsidebuilders.example/b')
  assert.equal(dropped.duplicate, 1)
  assert.equal(dropped.excerpt_not_on_page, 1)
})

test('unreachable pages are dropped', async () => {
  const { leads, dropped } = await verifyLeads([cand()], async () => null, NOW)
  assert.equal(leads.length, 0)
  assert.equal(dropped.page_unreachable, 1)
})

test('end to end: only verified leads are stored with evidence, per tenant; counts recorded', async () => {
  const master = randomBytes(32)
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-' + 'A'.repeat(40), master)
  const id = createJob(db, 'A', { business_name: 'Acme', industry: 'roofing', location: 'Toronto' })
  const text = JSON.stringify([cand({ event_date: '2026-10-05' }), cand({ source_url: 'https://northsidebuilders.example/zzz', excerpt: 'Fabricated quote that never appeared on any page anywhere', company: 'Other Co' })])
  const providers = { anthropic: { research: async () => ({ text, citedUrls: ['https://northsidebuilders.example/a', 'https://northsidebuilders.example/zzz'] }) }, openai: { research: async () => ({ text: '[]', citedUrls: [] }) } }
  await runJob(db, claimKeyedJob(db)!, { providers, master, now: NOW, fetchPage: async () => good })
  const rows = listLeads(db, 'A', id) as { evidence_excerpt: string; confidence: number; event_date: string }[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].evidence_excerpt, QUOTE)
  assert.ok(rows[0].confidence >= 80)
  const j = db.prepare('SELECT candidates, verified FROM scan_jobs WHERE id = ?').get(id) as { candidates: number; verified: number }
  assert.deepEqual({ ...j }, { candidates: 2, verified: 1 })
  assert.equal(listLeads(db, 'B', id).length, 0)
})

test('SSRF guard: private, loopback, metadata and non-https URLs are never fetched', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(isPublicIp(ip), false, ip)
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) assert.equal(isPublicIp(ip), true, ip)
  for (const u of ['http://example.com/', 'https://127.0.0.1/', 'https://[::1]/', 'https://169.254.169.254/latest/meta-data', 'https://localhost/', 'https://example.com:8443/', 'https://user:pw@example.com/', 'file:///etc/passwd', 'not a url'])
    assert.equal(await safeFetchPage(u), null, u)
})

test('htmlToText drops scripts and styles and decodes entities', () => {
  const r = htmlToText('<html><head><title>Acme &amp; Co</title><style>x{}</style></head><body><script>evil()</script><p>Hello&nbsp;<b>world</b> &#38; more</p></body></html>')
  assert.equal(r.title, 'Acme & Co')
  assert.equal(r.text, 'Acme & Co Hello world & more')
})
