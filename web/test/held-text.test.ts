// Isolated, stubbed fixtures (in-memory DB, stub provider, stub fetch): no network, no TinyFish, no live proof of yield.
// Narrow path from docs/design/blocked-source-verification.md: a candidate whose page dazl's OWN fetch could not read may be
// checked against text TinyFish ALREADY returned for that exact URL in the same scan attempt, with every check unchanged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob, exportLeads } from '../lib/scan/store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateEvents } from '../lib/events/store.ts'
import type { Provider } from '../lib/llm/provider.ts'
import { resetTinyfishState } from '../lib/search/tinyfish.ts'
import { claimKeyedJob, runJob, verifyLeads } from '../lib/scan/runner.ts'
import { HeldText, canonicalUrl, looksLikeWall, looksTruncated, MIN_COPY_CHARS, MAX_COPY_BYTES } from '../lib/scan/held-text.ts'
import { evidenceOriginLabel } from '../lib/scan/evidence-origin.ts'
import { evidenceCopyForLead, storeEvidenceCopy, purgeExpiredEvidenceCopies, MAX_TENANT_COPIES, MAX_COPY_BYTES as MAX_COPY_STORED } from '../lib/scan/evidence-copies.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const master = randomBytes(32)
process.env.DAZL_MASTER_KEY = master.toString('base64')
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const recent = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10)
const QUOTE = 'Harbor Freight Supply of Columbus Ohio is hiring a payroll specialist to manage biweekly payroll'
const FILLER = ' The team handles payroll, benefits administration and month-end reporting for about forty employees across two sites in central Ohio.'.repeat(4)
const BODY = `Posted ${recent}. ${QUOTE}.${FILLER} Apply now.`
const URL_ = 'https://jobs.example/hf'
const REQUEST = 'Find Ohio companies with 10 to 100 employees that recently posted a payroll, HR or office manager job'
const ICP = { summary: 'Ohio SMBs hiring payroll', who: ['Controller'], industries: [], sizes: ['10-100 employees'], where: ['Ohio'], signals: ['payroll job'], exclude: [] }

interface Opt { own?: 'blocked' | 'js_required' | 'ok'; tf?: { url?: string; title?: string; text: string } | null; cited?: string; company?: string; excerpt?: string; eventDate?: string | null; file?: string; fullTenant?: boolean }
async function scan(o: Opt = {}) {
  const cited = o.cited ?? URL_
  const db = new Database(o.file ?? ':memory:')
  migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db)
  saveKey(db, 'A', 'anthropic', KEY, master)
  createQueryJob(db, 'A', { query: REQUEST, icp: JSON.stringify(ICP) })
  const job = claimKeyedJob(db)!
  if (o.fullTenant) for (let i = 0; i < MAX_TENANT_COPIES; i++) { const t = `filler ${i} `.repeat(80); storeEvidenceCopy(db, 'A', 'oldjob', 1, { url: `https://filler.example/${i}`, title: '', text: t, sha256: createHash('sha256').update(t).digest('hex'), heldAt: 1 }) }
  const calls = { tfFetch: 0, ownFetch: [] as string[], other: [] as string[] }
  const tf = o.tf === undefined ? { text: BODY } : o.tf
  const fetchImpl = (async (u: string) => {
    if (u.startsWith('https://api.search.tinyfish.ai')) {
      const q = new URL(u).searchParams.get('query') ?? ''
      if (q.startsWith('site:linkedin.com/in ')) return new Response(JSON.stringify({ results: [] }), { status: 200 })
      return new Response(JSON.stringify({ results: [{ url: cited, title: 'Payroll specialist', snippet: QUOTE, date: recent }] }), { status: 200 })
    }
    if (u.startsWith('https://api.fetch.tinyfish.ai')) { calls.tfFetch++; return new Response(JSON.stringify({ results: tf ? [{ url: tf.url ?? cited, title: tf.title ?? 'Payroll specialist', text: tf.text }] : [] }), { status: 200 }) }
    calls.other.push(u)
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const lead = { name: '', company: o.company ?? 'Harbor Freight Supply', contact: null, signal: 'Hiring a payroll specialist', source_url: cited, score: 80, excerpt: o.excerpt ?? QUOTE, event_date: o.eventDate === undefined ? recent : o.eventDate }
  const providers: Record<'anthropic' | 'openai', Provider> = {
    anthropic: { research: async () => ({ text: '', citedUrls: [] }), complete: async (_k: string, _p: string, _f?: typeof fetch, maxTokens?: number) => maxTokens === 300 ? JSON.stringify([]) : JSON.stringify([lead]) },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  const own = o.own ?? 'blocked'
  const fetchPage = async (u: string) => { calls.ownFetch.push(u); return own === 'ok' ? { text: BODY, title: 'Payroll specialist', retrievedAt: 1_700_000_000 } : { fail: own === 'blocked' ? 'blocked' as const : 'js_required' as const } }
  resetTinyfishState()
  const realFetch = globalThis.fetch
  globalThis.fetch = fetchImpl; process.env.TINYFISH_API_KEY = 'tf-test'
  try {
    const r = await runJob(db, job, { providers, master, fetchPage, fetchImpl, score: false, judge: null, ground: false })
    const rows = db.prepare('SELECT id, company, source_url, review_reason, confidence, evidence_excerpt, evidence_origin, own_fetch_failure, evidence_copy_sha256, evidence_copy_id, retrieved_at FROM leads').all() as Record<string, unknown>[]
    return { r, rows, calls, db }
  } finally { globalThis.fetch = realFetch; delete process.env.TINYFISH_API_KEY }
}

// ---- positive ----
test('own fetch blocked + TinyFish text for the exact URL with the quote: verified, labelled, original failure and hash kept, zero extra fetches', async () => {
  const x = await scan()
  assert.equal(x.rows.length, 1)
  const row = x.rows[0]
  assert.equal(row.review_reason, null, 'verified, not review')
  assert.equal(row.evidence_origin, 'tinyfish_copy'); assert.equal(row.own_fetch_failure, 'blocked_by_site')
  assert.equal(row.evidence_copy_sha256, createHash('sha256').update(BODY).digest('hex'), 'hash of the exact original text that was checked')
  assert.equal(row.evidence_excerpt, QUOTE, 'the saved quote is the original, unmodified')
  // the original text is preserved in an immutable tenant-scoped record linked from the lead and survives the in-memory object
  assert.ok(row.evidence_copy_id)
  assert.equal(x.db.prepare('SELECT text FROM lead_evidence_copies WHERE id = ?').get(row.evidence_copy_id) !== undefined, true)
  assert.equal(x.calls.tfFetch, 1, 'the single fetch that extraction already made; the verifier added none')
  assert.deepEqual(x.calls.ownFetch, [URL_], 'dazl still tried its own fetch once, and only the cited URL')
  assert.deepEqual(x.calls.other.filter(u => u.includes('jobs.example')), [], 'nothing fetched from the cited site by anyone but the one own fetch (the other stubbed calls are the unrelated post-scan signal feeds)')
  const csv = (exportLeads(x.db, 'A') as Record<string, unknown>[])[0]
  assert.equal(csv.evidence_origin, 'tinyfish_copy'); assert.equal(csv.own_fetch_failure, 'blocked_by_site')
  assert.match(evidenceOriginLabel(String(csv.evidence_origin), String(csv.own_fetch_failure)), /copy of the page fetched by TinyFish.*own fetch.*blocked_by_site.*did not read the page directly/)
})
test('the exact original text is recoverable from a fresh database connection after the scan objects are gone; other tenants and expired records see nothing', async () => {
  const file = join(tmpdir(), `dazl-evidence-${randomBytes(6).toString('hex')}.db`)
  try {
    const x = await scan({ file })
    const leadId = String(x.rows[0].id); const jobId = (x.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id
    x.db.close()
    const db2 = new Database(file)
    const c = evidenceCopyForLead(db2, 'A', leadId)!
    assert.equal(c.text, BODY, 'byte-for-byte the text that was checked'); assert.equal(c.integrity, 'ok')
    assert.equal(c.sha256, createHash('sha256').update(BODY).digest('hex')); assert.equal(c.job_id, jobId); assert.equal(c.attempt, 1); assert.equal(c.source_url, URL_); assert.equal(c.own_fetch_failure, 'blocked_by_site')
    assert.equal(evidenceCopyForLead(db2, 'B', leadId), null, 'tenant scoped')
    // immutable: no update ever; no delete while retained
    assert.throws(() => db2.prepare('UPDATE lead_evidence_copies SET text = ?').run('edited'), /immutable/)
    assert.throws(() => db2.prepare('DELETE FROM lead_evidence_copies').run(), /retention/)
    db2.close()
  } finally { rmSync(file, { force: true }) }
})
test('company named ONLY in the page title: verified from the copy, and the exact title and body are both recoverable from a fresh connection, bound immutably', async () => {
  const TITLE = 'Zenith Widgets \u2014 Careers \u00b7 "Ohio" payroll'
  const file = join(tmpdir(), `dazl-evidence-title-${randomBytes(6).toString('hex')}.db`)
  try {
    const x = await scan({ file, company: 'Zenith Widgets', tf: { title: TITLE, text: BODY } })
    assert.equal(x.rows[0].review_reason, null, 'the title names the company, the quote does not: the existing rule accepts it')
    assert.doesNotMatch(QUOTE, /Zenith/)
    const leadId = String(x.rows[0].id); x.db.close()
    const db2 = new Database(file)
    const c = evidenceCopyForLead(db2, 'A', leadId)!
    assert.equal(c.title, TITLE, 'exact original title, byte for byte'); assert.equal(c.text, BODY); assert.equal(c.integrity, 'ok')
    assert.equal(c.title_sha256, createHash('sha256').update(TITLE).digest('hex')); assert.equal(c.sha256, createHash('sha256').update(BODY).digest('hex'))
    assert.equal(evidenceCopyForLead(db2, 'B', leadId), null)
    assert.throws(() => db2.prepare('UPDATE lead_evidence_copies SET title = ?').run('Other Co'), /immutable/)
    // a tampered row (trigger bypassed) is reported, not silently trusted
    db2.exec('DROP TRIGGER lead_evidence_copies_no_update'); db2.prepare('UPDATE lead_evidence_copies SET title = ?').run('Other Co')
    assert.equal(evidenceCopyForLead(db2, 'A', leadId)!.integrity, 'mismatch')
    db2.close()
  } finally { rmSync(file, { force: true }) }
})
test('company in neither the quote nor the title: stays in review (the title is not a free pass)', async () => {
  const x = await scan({ company: 'Zenith Widgets', tf: { title: 'Jobs at another firm', text: BODY } })
  assert.equal(x.rows[0].review_reason, 'blocked_by_site'); assert.equal(x.rows[0].evidence_copy_id, null)
})
test('retention and size are bounded: expired rows are the only deletable rows; a full tenant uses no copy; an oversize copy is not used', async () => {
  const t = (n: number) => `retained ${n} `.repeat(80)
  const db = new Database(':memory:'); migrateScan(db)
  const past = Math.floor(Date.now() / 1000) - 91 * 86_400
  const old = storeEvidenceCopy(db, 'A', 'j', 1, { url: 'https://x.example/old', title: '', text: t(1), sha256: createHash('sha256').update(t(1)).digest('hex'), heldAt: 1 }, past)
  const fresh = storeEvidenceCopy(db, 'A', 'j', 1, { url: 'https://x.example/new', title: '', text: t(2), sha256: createHash('sha256').update(t(2)).digest('hex'), heldAt: 1 })
  assert.equal(purgeExpiredEvidenceCopies(db), 1, 'only the expired row goes')
  assert.equal(db.prepare('SELECT id FROM lead_evidence_copies').all().length, 1); assert.equal((db.prepare('SELECT id FROM lead_evidence_copies').get() as { id: string }).id, fresh); assert.notEqual(old, fresh)
  assert.throws(() => storeEvidenceCopy(db, 'A', 'j', 1, { url: 'https://x.example/bad', title: '', text: 'abc', sha256: 'f'.repeat(64), heldAt: 1 }), /hash mismatch/)
  db.close()
  const full = await scan({ fullTenant: true })
  assert.equal(full.rows[0].review_reason, 'blocked_by_site', 'no room for another copy: stays in review, nothing partial stored'); assert.equal(full.rows[0].evidence_copy_id, null)
  const big = `${QUOTE}. ` + 'x'.repeat(MAX_COPY_BYTES)
  const huge = await scan({ tf: { text: big } })
  assert.equal(huge.rows[0].review_reason, 'blocked_by_site'); assert.equal(huge.rows[0].evidence_copy_id, null)
  assert.equal(MAX_COPY_BYTES, MAX_COPY_STORED, 'the verifier limit and the storage limit are the same number')
})
test('a JavaScript-only page is eligible too and keeps its own failure name', async () => {
  const x = await scan({ own: 'js_required' })
  assert.equal(x.rows[0].review_reason, null); assert.equal(x.rows[0].own_fetch_failure, 'needs_javascript')
})
test('control: when dazl can read the page itself nothing is labelled as a copy', async () => {
  const x = await scan({ own: 'ok' })
  assert.equal(x.rows[0].review_reason, null); assert.equal(x.rows[0].evidence_origin, null); assert.equal(x.rows[0].own_fetch_failure, null)
})

// ---- negative: every miss leaves the candidate exactly where the real failure put it ----
const stays = async (name: string, o: Opt, why = 'blocked_by_site') => test(`stays in review as ${why}: ${name}`, async () => {
  const x = await scan(o)
  assert.equal(x.rows.length, 1, name)
  assert.equal(x.rows[0].review_reason, why, name); assert.equal(x.rows[0].confidence, null)
  assert.equal(x.rows[0].evidence_origin, null, 'never labelled as a verified copy'); assert.equal(x.rows[0].evidence_copy_sha256, null)
})
test('no TinyFish text for the page: nothing is verified or labelled as a copy', async () => {
  const x = await scan({ tf: null })
  assert.ok(x.rows.every(r => r.review_reason !== null && r.evidence_origin === null && r.confidence === null))
})
stays('TinyFish text without the quote', { tf: { text: `Posted ${recent}. We run payroll for several clients in Ohio.${FILLER}` } })
stays('quote present but the company is not named in the quote or title', { company: 'Zenith Widgets', tf: { title: 'Jobs', text: BODY } })
stays('stale event date: the date rules are unchanged', { eventDate: '2019-03-01' })
stays('text TinyFish returned under a DIFFERENT url (a redirect target is not the cited page)', { tf: { url: 'https://other.example/elsewhere', text: BODY } })
stays('same host, different query string', { tf: { url: `${URL_}?id=2`, text: BODY } })
stays('login / consent wall text', { tf: { text: `Log in to continue. We use cookies. ${QUOTE}. ${'x '.repeat(300)}` } })
stays('too short to be the page', { tf: { text: `${QUOTE}.` } })
stays('copy that ends on a truncation marker', { tf: { text: `${BODY} Read more…` } })
stays('a walled social host never uses a copy', { cited: 'https://www.facebook.com/groups/ohio/posts/1', tf: { text: BODY } })

// ---- unit: matching, attempt binding, immutability, truncation ----
test('canonicalUrl: host case, default port, fragment and one trailing slash are the same page; query, path case, www, scheme aliases are not', () => {
  const k = canonicalUrl('https://Jobs.Example:443/hf/#top'); assert.equal(k, 'https://jobs.example/hf')
  assert.equal(canonicalUrl('https://jobs.example/hf/'), k)
  for (const other of ['https://jobs.example/hf?id=1', 'https://www.jobs.example/hf', 'https://jobs.example/HF', 'http://jobs.example/hf']) assert.notEqual(canonicalUrl(other), k, other)
  assert.equal(canonicalUrl('javascript:alert(1)'), null); assert.equal(canonicalUrl('https://u:p@jobs.example/hf'), null); assert.equal(canonicalUrl('not a url'), null)
})
test('HeldText: bound to one attempt, only requested URLs, eligible failures only, frozen', () => {
  const pages = [{ url: URL_, title: 't', text: BODY }, { url: 'https://never.requested/x', title: 't', text: BODY }]
  const h = HeldText.seal('job1:1', [URL_], pages)
  assert.equal(h.size, 1, 'a returned page that was never requested is not held')
  assert.equal(h.copyFor('job1:1', `${URL_}/#frag`, 'blocked_by_site').ok, true)
  assert.deepEqual(h.copyFor('job1:2', URL_, 'blocked_by_site'), { ok: false, refusal: 'wrong_attempt' }, 'another attempt (a retry) cannot use it')
  assert.deepEqual(h.copyFor('job1:1', URL_, 'login_required'), { ok: false, refusal: 'failure_not_eligible' })
  assert.deepEqual(h.copyFor('job1:1', URL_, 'quote_unconfirmed'), { ok: false, refusal: 'failure_not_eligible' })
  assert.deepEqual(h.copyFor('job1:1', 'https://jobs.example/other', 'blocked_by_site'), { ok: false, refusal: 'no_copy' })
  const got = h.copyFor('job1:1', URL_, 'blocked_by_site'); assert.ok(got.ok)
  assert.throws(() => { 'use strict'; (got.page as { text: string }).text = 'changed' }, TypeError)
  assert.ok(Object.isFrozen(h))
  pages[0].text = 'mutated after sealing'
  const again = h.copyFor('job1:1', URL_, 'blocked_by_site'); assert.ok(again.ok && again.page.text === BODY, 'later changes to the caller\'s array do not reach the held copy')
})
test('wall and truncation detectors', () => {
  assert.equal(looksLikeWall('Please log in to continue. ' + 'x'.repeat(100)), true)
  assert.equal(looksLikeWall(BODY), false)
  assert.equal(looksLikeWall(`We use cookies to improve your experience. ${BODY}${FILLER.repeat(8)}`), false, 'a cookie banner above a long real article is not a wall')
  assert.equal(looksTruncated(`${BODY} Read more…`), true); assert.equal(looksTruncated(BODY), false)
  assert.ok(MIN_COPY_CHARS >= 400)
})

// ---- verifier-level: the attempt must match, no binding means no copy ----
test('verifyLeads: a held copy from another attempt, or none supplied, changes nothing', async () => {
  const cand = { name: '', company: 'Harbor Freight Supply', contact: null, signal: 's', source_url: URL_, score: 80, excerpt: QUOTE, event_date: recent }
  const blocked = async () => ({ fail: 'blocked' as const })
  const text = HeldText.seal('job1:1', [URL_], [{ url: URL_, title: 't', text: BODY }])
  const ok = await verifyLeads([cand], blocked, new Date(), undefined, null, { text, attempt: 'job1:1' })
  assert.equal(ok.leads.length, 1); assert.equal(ok.leads[0].evidence_origin, 'tinyfish_copy')
  for (const held of [{ text, attempt: 'job1:2' }, undefined]) {
    const r = await verifyLeads([cand], blocked, new Date(), undefined, null, held)
    assert.equal(r.leads.length, 0); assert.equal(r.review[0].review_reason, 'blocked_by_site')
  }
})
