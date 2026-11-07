// #912: the qualification preview (and the free lead reading) use a company home page as evidence only when the lead's domain is CONFIRMED by
// the canonical rule (own-domain evidence, a current identity review, or a passed homepage check). A populated company_domain alone - a
// legacy row, a name probe, a link guess, a stale review - is not fetched, not used, and says why. Confirmation is rechecked after the
// page reads, and runQualification (the paid path) makes no model call when it is missing. Synthetic data, injected fetch + provider.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { migrateConnectors, addEnrichment } from '../lib/connectors/store.ts'
import { qualifyPreview } from '../lib/scan/qualify-preview.ts'
import { runQualification } from '../lib/scan/qualify-run.ts'
import { DEFAULT_LIMITS } from '../lib/scan/lead-qualify.ts'
import { leadSignals } from '../lib/scan/page-signals.ts'
import { domainReviewFor } from '../lib/outreach/domain-review.ts'
import { setDomainReview } from '../lib/scan/domain-review-action.ts'
import { bothEngines } from './helpers/engines.ts'

const L = 'a'.repeat(24), MODEL = 'claude-sonnet-4-5', SELLER = 'Sales prospecting software for B2B sales teams'
const POSTING = 'https://weworkremotely.com/remote-jobs/acme-sdr', HOME = 'https://acme.example/'
type Row = { connector: string; kind: string; value: string; label: string | null; source_url: string | null; retrieved_at: number | null }

function setup(contact: string | null = null) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createQueryJob(db, 'u1', { query: 'B2B companies hiring sales roles' })
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(job)
  db.prepare('INSERT INTO leads(id,scan_job_id,company,contact,signal,source_url,company_domain) VALUES (?,?,?,?,?,?,?)').run(L, job, 'Acme', contact, 'Posted a role titled "SDR"', POSTING, 'acme.example')
  const put = (kind: string, value: string, url: string, label = '') => addEnrichment(db, 'u1', L, { connector: 'sitecrawl', kind, value, label, confidence: null, source_url: url, source_date: '2026-11-01', retrieved_at: 10 })
  const rows = () => db.prepare("SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ? AND tenant_id = 'u1'").all(L) as Row[]
  const review = () => setDomainReview(db, 'u1', L, 'confirm', domainReviewFor({ id: L, contact }, rows()).binding!)
  return { db, put, review }
}
// the posting names the company only when asked to; the home page always does
const fetcher = (postingNames = true, seen: string[] = [], during?: () => void) => async (url: string) => {
  seen.push(url); during?.()
  return { text: url === POSTING && !postingNames ? 'A page about something else entirely.' : 'Acme runs outbound sales with five SDRs.', title: 't', retrievedAt: 1 }
}
const out = JSON.stringify({ company_fit: { verdict: 'yes', quote: 'Acme runs outbound sales with five SDRs.', quote_url: HOME, note: '' }, use_case: { verdict: 'unknown' }, buying_evidence: { verdict: 'unknown' } })
function prov() { let calls = 0; return { calls: () => calls, p: { research: async () => ({ text: '', citedUrls: [] }), configuredModel: () => MODEL, completeDetailed: async () => { calls++; return { text: out, model: 'stub' } } } as never } }

test('#912 audit reproduction: a populated but unconfirmed domain is not fetched or used; with a non-naming posting the preview is not ready and the paid run makes zero model calls', async () => {
  const s = setup(), seen: string[] = []
  const p = await qualifyPreview(s.db, 'u1', L, SELLER, fetcher(false, seen), 'anthropic', MODEL)
  assert.ok(p)
  assert.deepEqual(seen, [POSTING], 'the unconfirmed home page is not even read')
  assert.deepEqual(p.pages.map(x => x.role), ['posting'])
  assert.ok(p.notes.some(n => /acme\.example is not confirmed/.test(n)), 'says why')
  assert.equal(p.input, null); assert.equal(p.ready, false); assert.equal(p.prompt_sha256, null)
  const pr = prov()
  const r = await runQualification(s.db, 'u1', L, { approved_by_user: true, vendor: 'anthropic', model: MODEL, max_usd_estimate: 1, prompt_sha256: 'x'.repeat(64), request_context_sha256: p.packing!.context_sha256, limits: DEFAULT_LIMITS }, { enabled: true, sellerText: SELLER, vendor: 'anthropic', provider: pr.p, apiKey: 'k', fetchPage: fetcher(false) })
  assert.equal(r.status, 'blocked'); assert.equal(pr.calls(), 0)
})

test('#912 only canonical confirmation admits the home page: own-domain evidence, a passed homepage check, a current review', async () => {
  const cases: [string, (s: ReturnType<typeof setup>) => void, boolean][] = [
    ['no domain row (legacy)', () => {}, false],
    ['name probe', s => s.put('domain', 'acme.example|name_probe', HOME, 'domain-basis-v1:name_probe'), false],
    ['link-text guess', s => s.put('domain', 'acme.example|evidence_link_text', 'https://x.test/p', 'domain-basis-v1:evidence_link_text'), false],
    ['own-domain evidence for ANOTHER domain', s => s.put('domain', 'other.example|evidence_own_domain', 'https://other.example/n', 'domain-basis-v1:evidence_own_domain'), false],
    ['own-domain evidence', s => s.put('domain', 'acme.example|evidence_own_domain', 'https://acme.example/news', 'domain-basis-v1:evidence_own_domain'), true],
    ['passed homepage check', s => s.put('domain_check', 'acme.example|name+place', HOME), true],
    ['current identity review', s => { s.put('domain', 'acme.example|name_probe', HOME, 'domain-basis-v1:name_probe'); s.put('email', 'hello@acme.example', 'https://acme.example/contact'); assert.equal(s.review().status, 'confirmed') }, true],
    ['stale identity review (address changed after review)', s => { s.put('domain', 'acme.example|name_probe', HOME, 'domain-basis-v1:name_probe'); s.put('email', 'hello@acme.example', 'https://acme.example/contact'); s.review(); s.db.prepare("UPDATE lead_enrichments SET value = 'other@acme.example' WHERE kind = 'email'").run() }, false],
  ]
  for (const [name, seed, used] of cases) {
    const s = setup(); seed(s); const seen: string[] = []
    const p = await qualifyPreview(s.db, 'u1', L, SELLER, fetcher(true, seen), 'anthropic', MODEL)
    assert.equal(seen.includes(HOME), used, name)
    assert.deepEqual(p?.scope?.pages_included.map(x => x.role), used ? ['posting', 'company_home'] : ['posting'], name)
    const sig = await leadSignals(s.db, 'u1', L, fetcher(true))
    assert.equal(sig?.pages.some(x => x.role === 'company_home'), used, name + ' (lead reading)')
  }
})

test('#912 confirmation lost or domain changed WHILE the pages are read blocks the preview, and the paid run then makes no call', async () => {
  for (const [name, change] of [
    ['own-domain evidence removed', (db: Database.Database) => db.prepare("DELETE FROM lead_enrichments WHERE kind = 'domain'").run()],
    ['company domain changed', (db: Database.Database) => db.prepare("UPDATE leads SET company_domain = 'acme-two.example'").run()],
    ['company renamed', (db: Database.Database) => db.prepare("UPDATE leads SET company = 'Acme Holdings'").run()],
  ] as const) {
    const s = setup(); s.put('domain', 'acme.example|evidence_own_domain', 'https://acme.example/news', 'domain-basis-v1:evidence_own_domain')
    const approved = await qualifyPreview(s.db, 'u1', L, SELLER, fetcher(true), 'anthropic', MODEL)
    assert.equal(approved?.ready, true, name + ': ready while confirmed')
    let once = false
    const p = await qualifyPreview(s.db, 'u1', L, SELLER, fetcher(true, [], () => { if (!once) { once = true; change(s.db) } }), 'anthropic', MODEL)
    assert.equal(p?.ready, false, name); assert.ok(p?.notes.some(n => /company or confirmed site changed while reading/.test(n)), name)
    const pr = prov()
    const r = await runQualification(s.db, 'u1', L, { approved_by_user: true, vendor: 'anthropic', model: MODEL, max_usd_estimate: approved!.cost!.usd_estimate_max!, prompt_sha256: approved!.prompt_sha256!, request_context_sha256: approved!.packing!.context_sha256, limits: DEFAULT_LIMITS }, { enabled: true, sellerText: SELLER, vendor: 'anthropic', provider: pr.p, apiKey: 'k', fetchPage: fetcher(true) })
    assert.notEqual(r.status, 'done', name); assert.equal(pr.calls(), 0, name + ': no model call')
  }
})

test('#912 a confirmed, unchanged lead is still previewed and run normally (one model call)', async () => {
  const s = setup(); s.put('domain', 'acme.example|evidence_own_domain', 'https://acme.example/news', 'domain-basis-v1:evidence_own_domain')
  const p = await qualifyPreview(s.db, 'u1', L, SELLER, fetcher(true), 'anthropic', MODEL)
  assert.equal(p?.ready, true)
  const pr = prov()
  const r = await runQualification(s.db, 'u1', L, { approved_by_user: true, vendor: 'anthropic', model: MODEL, max_usd_estimate: p!.cost!.usd_estimate_max!, prompt_sha256: p!.prompt_sha256!, request_context_sha256: p!.packing!.context_sha256, limits: DEFAULT_LIMITS }, { enabled: true, sellerText: SELLER, vendor: 'anthropic', provider: pr.p, apiKey: 'k', fetchPage: fetcher(true) })
  assert.equal(r.status, 'done'); assert.equal(pr.calls(), 1)
  assert.equal(await qualifyPreview(s.db, 'u2', L, SELLER, fetcher(true)), null, 'another tenant gets nothing')
})

// leadSignals runs on the Db layer: the same confirmation rule on SQLite and Postgres.
bothEngines('#912 leadSignals reads the home page only for a confirmed domain (Db layer)', async ({ db }) => {
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, created_at) VALUES ('j912', 'u1', 'S', 'x', 'y', 'running', 1)")
  await db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url, company_domain, confidence, score) VALUES (?, 'j912', 'Acme', 's', ?, 'acme.example', 80, 50)", [L, POSTING])
  const add = (id: string, kind: string, value: string, tenant = 'u1') => db.run("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, ?, 'sitecrawl', ?, ?, '', NULL, 'https://acme.example/news', '2026-11-01', 1)", [id, L, tenant, kind, value])
  const home = async (tenant = 'u1') => (await leadSignals(db, tenant, L, fetcher(true)))?.pages.some(x => x.role === 'company_home') ?? null
  assert.equal(await home(), false, 'populated only')
  await add('e1', 'domain', 'acme.example|name_probe'); assert.equal(await home(), false, 'name probe')
  await add('e2', 'domain', 'acme.example|evidence_own_domain', 'u2'); assert.equal(await home(), false, "another tenant's evidence does not confirm")
  await add('e3', 'domain_check', 'acme.example|name+place'); assert.equal(await home(), true, 'passed homepage check')
  assert.equal(await home('u2'), null, 'another tenant gets nothing')
})

// #912 follow-up: the free lead reading rechecks the lead after its page reads, on both engines. A change DURING the fetch withdraws the stale
// reading with a stated reason instead of returning it as current evidence; a confirmed, unchanged lead is untouched.
bothEngines('#912 leadSignals rechecks the lead after its reads: lost confirmation, domain change, rename, source change and deletion withdraw stale readings; unchanged stays', async ({ db }) => {
  let n = 0
  const seed = async () => {
    const job = `j912x${++n}`, lead = `${'b'.repeat(23)}${n}`
    await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, created_at) VALUES (?, 'u1', 'S', 'x', 'y', 'running', 1)", [job])
    await db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url, company_domain, confidence, score) VALUES (?, ?, 'Acme', 's', ?, 'acme.example', 80, 50)", [lead, job, POSTING])
    await db.run("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'u1', 'sitecrawl', 'domain', 'acme.example|evidence_own_domain', 'domain-basis-v1:evidence_own_domain', NULL, 'https://acme.example/news', '2026-11-01', 10)", [`en${n}`, lead])
    return lead
  }
  const during = (change: () => Promise<void>) => { let once = false; return async (url: string) => { if (!once) { once = true; await change() } return fetcher(true)(url) } }
  const roles = (s: Awaited<ReturnType<typeof leadSignals>>) => s?.pages.map(p => `${p.role}:${p.status}`)
  { const lead = await seed(); const s = await leadSignals(db, 'u1', lead, fetcher(true))
    assert.deepEqual(roles(s), ['posting:read', 'company_home:read'], 'confirmed and unchanged: both readings stand (positive control)'); assert.equal(s?.company, 'Acme') }
  { const lead = await seed(); const s = await leadSignals(db, 'u1', lead, during(async () => { await db.run("DELETE FROM lead_enrichments WHERE lead_id = ? AND kind = 'domain'", [lead]) }))
    assert.deepEqual(roles(s), ['posting:read', 'company_home:not_used'], 'confirmation deleted during the fetch: only the home reading is withdrawn')
    assert.match(s!.pages[1].why!, /no longer confirmed/); assert.equal(s!.pages[1].reading, undefined); assert.ok(s!.pages[0].reading, 'the posting reading, judged against an unchanged company, stands') }
  { const lead = await seed(); const s = await leadSignals(db, 'u1', lead, during(async () => { await db.run("UPDATE leads SET company = 'Birch', company_domain = 'birch.example' WHERE id = ?", [lead]) }))
    assert.equal(s?.company, 'Birch', 'the result names the CURRENT company, never Acme'); assert.deepEqual(roles(s), ['posting:not_used', 'company_home:not_used'])
    for (const p of s!.pages) { assert.match(p.why!, /changed while the pages were being read/); assert.equal(p.reading, undefined) }
    assert.ok(!JSON.stringify(s).includes('acme.example/') || s!.pages.every(p => p.status === 'not_used'), 'the Acme home page is not presented as a reading') }
  { const lead = await seed(); const s = await leadSignals(db, 'u1', lead, during(async () => { await db.run("UPDATE leads SET company = 'Acme Holdings' WHERE id = ?", [lead]) }))
    assert.equal(s?.company, 'Acme Holdings'); assert.deepEqual(roles(s), ['posting:not_used', 'company_home:not_used'], 'a rename withdraws the posting reading judged against the old name') }
  { const lead = await seed(); const s = await leadSignals(db, 'u1', lead, during(async () => { await db.run("UPDATE leads SET source_url = 'https://weworkremotely.com/remote-jobs/other' WHERE id = ?", [lead]) }))
    assert.deepEqual(roles(s), ['posting:not_used', 'company_home:not_used'], 'a changed source page withdraws both') }
  { const lead = await seed(); const s = await leadSignals(db, 'u1', lead, during(async () => { await db.run("DELETE FROM lead_enrichments WHERE lead_id = ?", [lead]); await db.run("DELETE FROM leads WHERE id = ?", [lead]) }))
    assert.equal(s, null, 'the lead is gone: nothing is returned') }
})
