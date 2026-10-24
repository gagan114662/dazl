import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { runQualification, storedQualifications, migrateQualify } from '../lib/scan/qualify-run.ts'
import { preparePrompt, DEFAULT_LIMITS } from '../lib/scan/lead-qualify.ts'
import { qualifyPreview } from '../lib/scan/qualify-preview.ts'

const L = 'a'.repeat(24), MODEL = 'claude-sonnet-4-5'
function setup() {
  const db = new Database(':memory:'); migrateScan(db)
  const job = createQueryJob(db, 'u1', { query: 'B2B companies hiring sales roles' })
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(job)
  db.prepare("INSERT INTO leads(id,scan_job_id,company,signal,source_url,company_domain) VALUES (?,?,?,?,?,?)").run(L, job, 'Acme', 'Posted a role titled "SDR"', 'https://weworkremotely.com/remote-jobs/acme-sdr', 'acme.example')
  return db
}
const fetchPage = async (url: string) => ({ text: `Acme runs outbound sales with five SDRs. (${url})`, title: 't', retrievedAt: 1 })
const out = JSON.stringify({ company_fit: { verdict: 'yes', quote: 'Acme runs outbound sales with five SDRs.', quote_url: 'https://acme.example/', note: '' }, use_case: { verdict: 'unknown' }, buying_evidence: { verdict: 'unknown' } })
function prov() { let calls = 0; return { calls: () => calls, p: { research: async () => ({ text: '', citedUrls: [] }), configuredModel: () => MODEL, completeDetailed: async () => { calls++; return { text: out, model: 'stub' } } } as never } }
async function approvalFor(db: Database.Database) {
  const pv = await qualifyPreview(db, 'u1', L, 'Sales prospecting software', fetchPage, 'anthropic', MODEL)
  assert.ok(pv && pv.cost && pv.prompt_sha256)
  return { approved_by_user: true as const, vendor: 'anthropic', model: MODEL, max_usd_estimate: pv.cost.usd_estimate_max!, prompt_sha256: pv.prompt_sha256, limits: DEFAULT_LIMITS }
}
const deps = (p: unknown, over: Record<string, unknown> = {}) => ({ enabled: true, sellerText: 'Sales prospecting software', vendor: 'anthropic', provider: p as never, apiKey: 'k', fetchPage, ...over })

test('disabled by default: no request, no row', async () => {
  const db = setup(), s = prov(), a = await approvalFor(db)
  assert.deepEqual(await runQualification(db, 'u1', L, a, deps(s.p, { enabled: false })), { status: 'disabled' })
  assert.equal(s.calls(), 0); assert.equal(storedQualifications(db, 'u1', L).length, 0)
})
test('no usable key, wrong hash, wrong model: refused with zero requests and no stuck row', async () => {
  const db = setup(), s = prov(), a = await approvalFor(db)
  assert.equal((await runQualification(db, 'u1', L, a, deps(s.p, { apiKey: null }))).status, 'blocked')
  const bad = await runQualification(db, 'u1', L, { ...a, prompt_sha256: 'f'.repeat(64) }, deps(s.p))
  assert.deepEqual([bad.status, (bad as { reason: string }).reason], ['blocked', 'content_mismatch'])
  const mm = await runQualification(db, 'u1', L, { ...a, model: 'other' }, deps(s.p))
  assert.equal((mm as { reason: string }).reason, 'model_mismatch')
  assert.equal(s.calls(), 0); assert.equal(storedQualifications(db, 'u1', L).length, 0)
})
test('approved run: one request, result stored with caveat and quote url; a repeat or concurrent click makes no second request', async () => {
  const db = setup(), s = prov(), a = await approvalFor(db)
  const [r1, r2] = await Promise.all([runQualification(db, 'u1', L, a, deps(s.p)), runQualification(db, 'u1', L, a, deps(s.p))])
  assert.equal(s.calls(), 1)
  assert.deepEqual([r1.status, r2.status].sort(), ['done', 'exists'])
  const r3 = await runQualification(db, 'u1', L, a, deps(s.p))
  assert.equal(r3.status, 'exists'); assert.equal(s.calls(), 1)
  const st = storedQualifications(db, 'u1', L)
  assert.equal(st.length, 1); assert.equal(st[0].qualification?.company_fit.quote_url, 'https://acme.example/'); assert.match(st[0].qualification!.caveat, /Literal match only/)
  assert.equal(storedQualifications(db, 'u2', L).length, 0)
})
test('a provider error keeps a failed row so nothing repeats the possibly billed request', async () => {
  const db = setup(), a = await approvalFor(db); let calls = 0
  const p = { research: async () => ({ text: '', citedUrls: [] }), configuredModel: () => MODEL, completeDetailed: async () => { calls++; throw new Error('provider_500') } } as never
  assert.equal((await runQualification(db, 'u1', L, a, deps(p))).status, 'failed')
  assert.equal((await runQualification(db, 'u1', L, a, deps(p))).status, 'exists')
  assert.equal(calls, 1); void preparePrompt
})

test('changed page text does not allow a second paid request, and the row keeps the evidence scope used', async () => {
  const db = setup(), s = prov(), a = await approvalFor(db)
  assert.equal((await runQualification(db, 'u1', L, a, deps(s.p))).status, 'done')
  const fetch2 = async (url: string) => ({ text: `Acme changed its page entirely and now sells widgets. (${url})`, title: 't', retrievedAt: 2 })
  const pv2 = await qualifyPreview(db, 'u1', L, 'Sales prospecting software', fetch2, 'anthropic', MODEL)
  assert.notEqual(pv2!.prompt_sha256, a.prompt_sha256)
  const r = await runQualification(db, 'u1', L, { ...a, prompt_sha256: pv2!.prompt_sha256!, max_usd_estimate: pv2!.cost!.usd_estimate_max! }, deps(s.p, { fetchPage: fetch2 }))
  assert.equal(r.status, 'exists'); assert.equal(s.calls(), 1)
  const st = storedQualifications(db, 'u1', L); assert.equal(st.length, 1)
  const ev = st[0].evidence as { scope: { pages_included: { chars_sent: number }[] }; pages: unknown[] }
  assert.ok(ev.scope.pages_included.length > 0 && ev.scope.pages_included[0].chars_sent > 0); assert.equal(ev.pages.length, 2)
})
test('a failed row also blocks a changed-content request', async () => {
  const db = setup(), a = await approvalFor(db); let calls = 0
  const p = { research: async () => ({ text: '', citedUrls: [] }), configuredModel: () => MODEL, completeDetailed: async () => { calls++; throw new Error('x') } } as never
  assert.equal((await runQualification(db, 'u1', L, a, deps(p))).status, 'failed')
  const fetch2 = async (url: string) => ({ text: `Acme new text (${url})`, title: 't', retrievedAt: 2 })
  const pv2 = await qualifyPreview(db, 'u1', L, 'Sales prospecting software', fetch2, 'anthropic', MODEL)
  assert.equal((await runQualification(db, 'u1', L, { ...a, prompt_sha256: pv2!.prompt_sha256!, max_usd_estimate: pv2!.cost!.usd_estimate_max! }, deps(p, { fetchPage: fetch2 }))).status, 'exists')
  assert.equal(calls, 1)
})

test('the table itself allows only one claim per lead, across different hashes', () => {
  const db = setup(); migrateQualify(db)
  const ins = (h: string) => db.prepare("INSERT OR IGNORE INTO lead_qualifications (tenant_id, lead_id, prompt_sha256, status) VALUES ('u1', ?, ?, 'running')").run(L, h).changes
  assert.deepEqual([ins('1'.repeat(64)), ins('2'.repeat(64))], [1, 0])
})
