// Refs #1099, Gagan's rule (15 Nov 03:38): dazl calls no paid third-party API in its default path except Claude. Every gate below runs with
// DAZL_PAID_VENDORS empty (the default an operator gets) and proves NO request reaches the vendor; a control names the vendor and proves
// the same code still runs when an operator opts in. The test fence (test/helpers/net-fence.ts) names every vendor for the rest of the suite,
// so each test here sets the variable itself. Invented companies and keys; fake fetch; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { paidVendorsAllowed, paidVendorOn, usableVendor, PAID_VENDOR_OFF } from '../lib/paid-vendors.ts'
import { enrichLeadContacts } from '../lib/enrich/index.ts'
import { paidEnrichmentOutcomes } from '../lib/scan/enrichment-trace.ts'
import { readProviderIssues } from '../lib/scan/provider-issues.ts'
import { providerIssueText } from '../lib/scan/provider-issue-text.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { enrichCommenters, migrateCommenterImport } from '../lib/scan/commenter-import.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential } from '../lib/connectors/store.ts'
import { migrateKeys, saveKey, defaultVendor, hasKey, readHasKey } from '../lib/llm/key-store.ts'
import { readFileSync } from 'node:fs'
import { pickVendor } from '../lib/scan/runner.ts'
import { verifierFromEnv } from '../lib/people/email-pattern.ts'
import { jinaAdapter, resetJinaState } from '../lib/sources/jina.ts'
import { fundingRoundFor } from '../lib/signals/funding-round.ts'
import { estimateRun } from '../lib/scan/price-estimate.ts'

const OFF = { DAZL_PAID_VENDORS: '' }
const master = randomBytes(32)

async function withProcessEnv<T>(v: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const had = process.env.DAZL_PAID_VENDORS
  if (v === undefined) delete process.env.DAZL_PAID_VENDORS; else process.env.DAZL_PAID_VENDORS = v
  try { return await fn() } finally { if (had === undefined) delete process.env.DAZL_PAID_VENDORS; else process.env.DAZL_PAID_VENDORS = had }
}

test('the policy: nothing is allowed by default; only the vendors the operator names, in any case and spacing', async () => {
  await withProcessEnv(undefined, () => {
    assert.deepEqual([...paidVendorsAllowed({})], [])
    for (const v of ['apollo', 'pdl', 'zerobounce', 'openai', 'jina'] as const) assert.equal(paidVendorOn(v, {}), false, v)
  })
  assert.deepEqual([...paidVendorsAllowed({ DAZL_PAID_VENDORS: ' Apollo , PDL ,bogus' })].sort(), ['apollo', 'pdl'])
  // an empty value in a call's own env is an explicit "none", not "ask the process"
  await withProcessEnv('apollo', () => { assert.equal(paidVendorOn('apollo', OFF), false); assert.equal(paidVendorOn('apollo', {}), true) })
})

function enrichSeed() {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 'NYC dental', where: ['New York City'], who: ['Owner'], signals: [] }), jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, fit, intent, action, why) VALUES ('lead1', ?, '', 'Kestrel Dental', 'kestreldental.example', 'opened a new practice', 'https://news.example/k', 4, 3, 4, 'New dental practice in New York.')").run(jobId)
  saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  saveCredential(db, 'u1', 'enrich:pdl', 'test-pdl-key-1234', master)
  return { db, jobId, lead: { id: 'lead1', company: 'Kestrel Dental', company_domain: 'kestreldental.example' } }
}

test('scan enrichment: with saved Apollo and PDL keys and no paid vendor named, no request is sent and the scan says why once', async () => {
  const { db, jobId, lead } = enrichSeed()
  const calls: string[] = []
  const fetchImpl = (async (u: RequestInfo | URL) => { calls.push(String(u)); return new Response('{}', { status: 200 }) }) as typeof fetch
  await enrichLeadContacts(db, 'u1', jobId, [lead], { fetchImpl, master, env: OFF })
  await enrichLeadContacts(db, 'u1', jobId, [lead], { fetchImpl, master, env: OFF })
  assert.deepEqual(calls, [], 'no Apollo or PDL request')
  const rows = db.prepare("SELECT connector, status, lookup FROM connector_audit WHERE scan_job_id = ? AND status = ?").all(jobId, PAID_VENDOR_OFF) as { connector: string; status: string; lookup: string }[]
  assert.equal(rows.length, 1, 'one note per scan, not per pass')
  assert.match(rows[0].lookup, /not called: dazl uses no paid third-party service by default/)
  assert.equal((db.prepare("SELECT count(*) AS n FROM connector_audit WHERE scan_job_id = ? AND status = 'no_key'").get(jobId) as { n: number }).n, 0, 'never reported as "no key"')
  // not a failed pass, and the scan's notices say why (council review)
  assert.equal(paidEnrichmentOutcomes(db, 'u1', jobId).passFailed, 0)
  const issues = (await readProviderIssues(sqliteDb(db), 'u1', jobId)) ?? []
  assert.deepEqual(issues.map(i => i.status), ['paid_vendor_off'])
  assert.match(providerIssueText(issues[0]), /dazl uses no paid third-party service \(Apollo, People Data Labs\) by default/)
  // control: the operator names Apollo, and the same pass asks Apollo
  const c = enrichSeed()
  await enrichLeadContacts(c.db, 'u1', c.jobId, [c.lead], { fetchImpl, master, env: { DAZL_PAID_VENDORS: 'apollo' } })
  assert.ok((calls as string[]).some(u => u.includes('apollo')), JSON.stringify(calls))
  // only PDL named: the saved Apollo key is never read or called
  const p = enrichSeed(); calls.length = 0
  await enrichLeadContacts(p.db, 'u1', p.jobId, [p.lead], { fetchImpl, master, env: { DAZL_PAID_VENDORS: 'pdl' } })
  assert.ok(!(calls as string[]).some(u => u.includes('apollo')), JSON.stringify(calls))
  assert.ok((calls as string[]).some(u => u.includes('peopledatalabs')), JSON.stringify(calls))
})

test('commenter import: saved Apollo and PDL keys are not used unless named; the import says why', async () => {
  const seed = () => {
    const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateCommenterImport(db)
    const job = createJob(db, 'A', { business_name: 'B', industry: 'I', location: 'L' })
    db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
    db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('l1', ?, 'Jane Doe - VP Sales', 'Kestrel Dental', 'kestreldental.example', 'commented', 'https://www.linkedin.com/in/jane-doe')").run(job)
    db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
    db.prepare("INSERT INTO commenter_batches (id, user_id, job_id, context, total) VALUES ('b1', 'A', ?, 'commented on my post', 1)").run(job)
    saveCredential(db, 'A', 'enrich:apollo', 'test-apollo-key-1234', master); saveCredential(db, 'A', 'enrich:pdl', 'test-pdl-key-1234', master)
    return { db, job }
  }
  const calls: string[] = []
  const fetchImpl = (async (u: RequestInfo | URL) => { calls.push(String(u)); return new Response('{}', { status: 200 }) }) as typeof fetch
  const { db, job } = seed()
  await enrichCommenters(db, 'A', 'b1', { fetchImpl, master, env: OFF })
  assert.deepEqual(calls, [])
  assert.equal((db.prepare('SELECT count(*) AS n FROM connector_audit WHERE scan_job_id = ? AND status = ?').get(job, PAID_VENDOR_OFF) as { n: number }).n, 1)
  const c = seed()
  await enrichCommenters(c.db, 'A', 'b1', { fetchImpl, master, env: { DAZL_PAID_VENDORS: 'apollo' } })
  assert.ok((calls as string[]).some(u => u.includes('api.apollo.io')), 'control: named, Apollo is asked')
})

test('model vendor: a saved OpenAI key is not used unless named; the Anthropic key is used even when it is older', async () => {
  const db = new Database(':memory:'); migrateKeys(db)
  saveKey(db, 't1', 'anthropic', 'sk-ant-' + 'a'.repeat(40), master)
  db.prepare("UPDATE tenant_llm_keys SET created_at = created_at - 100 WHERE tenant_id = 't1'").run()
  saveKey(db, 't1', 'openai', 'sk-' + 'b'.repeat(40), master)
  assert.equal(pickVendor(db, 't1', OFF), 'anthropic')
  assert.equal(defaultVendor(db, 't1', OFF), 'anthropic')
  assert.equal(pickVendor(db, 't1', { DAZL_PAID_VENDORS: 'openai' }), 'openai', 'named: the newest key, as before')
  saveKey(db, 't2', 'openai', 'sk-' + 'c'.repeat(40), master)
  assert.equal(pickVendor(db, 't2', OFF), null, 'only an OpenAI key: no usable key')
  // ...and every intake gate (scan, play, watch, CSV, estimate) sees it as keyless up front, instead of accepting a scan that cannot run
  assert.equal(hasKey(db, 't2', OFF), false); assert.equal(hasKey(db, 't1', OFF), true)
  assert.equal(hasKey(db, 't2', { DAZL_PAID_VENDORS: 'openai' }), true)
  // the Db-layer read the watch, play, usage and estimate gates use (council round 2)
  assert.equal(await readHasKey(sqliteDb(db), 't2', OFF), false); assert.equal(await readHasKey(sqliteDb(db), 't1', OFF), true)
  assert.equal(usableVendor([{ vendor: 'openai' }, { vendor: 'anthropic' }], OFF)?.vendor, 'anthropic')
})

test('mailbox check: a ZeroBounce key is not used unless named', () => {
  assert.equal(verifierFromEnv({ ZEROBOUNCE_API_KEY: 'zb-key', ...OFF }), null)
  assert.ok(verifierFromEnv({ ZEROBOUNCE_API_KEY: 'zb-key', DAZL_PAID_VENDORS: 'zerobounce' }))
})

test('web pages source: read directly by dazl, never through r.jina.ai, unless Jina is named', async () => {
  const PAGE = 'https://kestreldental.example/news/second-office'
  const html = '<html><head><title>Kestrel Dental opens a second office</title></head><body><p>Kestrel Dental opened its second dental office in Brooklyn this month, with six new chairs.</p></body></html>'
  const asked: string[] = []
  const http = async (url: string) => { asked.push(url); return url === PAGE ? { status: 200, body: html } : null }
  await withProcessEnv('', async () => {
    resetJinaState()
    assert.match(jinaAdapter.label, /read directly by dazl/)
    const out = await jinaAdapter.collect({ query: 'q', keywords: ['dental'], feeds: [], pages: [PAGE], http })
    assert.deepEqual(asked, [PAGE], 'the page itself, not r.jina.ai')
    assert.equal(out.length, 1); assert.equal(out[0].url, PAGE); assert.match(out[0].quote, /second dental office in Brooklyn/)
    // a bot wall is noted, never a quote (council review)
    resetJinaState(); const notes: string[] = []
    const wall = '<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing kestreldental.example. This process is automatic. Please enable JavaScript and cookies to continue.</body></html>'
    const walled = await jinaAdapter.collect({ query: 'q', keywords: ['dental'], feeds: [], pages: [PAGE], http: async () => ({ status: 200, body: wall }), note: c => notes.push(c) })
    assert.deepEqual(walled, []); assert.ok(notes.length === 1 && ['challenge', 'js_required'].includes(notes[0]), JSON.stringify(notes))
  })
  await withProcessEnv('jina', async () => {
    resetJinaState(); asked.length = 0
    await jinaAdapter.collect({ query: 'q', keywords: ['dental'], feeds: [], pages: [PAGE], http })
    assert.deepEqual(asked, [`https://r.jina.ai/${PAGE}`])
  })
})

test('funding round: the article is read by dazl itself, never sent to r.jina.ai, unless Jina is named', async () => {
  const item = { company: 'Kestrel Pay', title: 'Kestrel Pay raises funding', url: 'https://news.example/kestrel-pay-raise', date: '2026-11-04', amount: null, stage: null }
  const realFetch = globalThis.fetch
  const asked: string[] = []
  globalThis.fetch = (async (u: RequestInfo | URL) => { asked.push(String(u)); return new Response('Title: x\n\nMarkdown Content:\nKestrel Pay raised a $5M seed round.', { status: 200 }) }) as typeof fetch
  try {
    await withProcessEnv('', async () => { await fundingRoundFor('Kestrel Pay', [item as never]) })
    assert.ok(!asked.some(u => u.includes('r.jina.ai')), JSON.stringify(asked))
    await withProcessEnv('jina', async () => { await fundingRoundFor('Kestrel Pay', [item as never]) })
    assert.ok(asked.some(u => u.includes('r.jina.ai')), 'control: named, Jina Reader is asked')
  } finally { globalThis.fetch = realFetch }
})

test('the price estimate lists no Apollo / PDL credits for saved keys the policy keeps off', () => {
  const ids = (env: Record<string, string>) => estimateRun({ budget: null, payer: 'you', enrichmentVendors: ['apollo', 'pdl'], env }).rows.map(r => r.id)
  assert.ok(!ids(OFF).some(id => id === 'apollo_credits' || id === 'pdl_credits'), JSON.stringify(ids(OFF)))
  assert.ok(ids({ DAZL_PAID_VENDORS: 'apollo,pdl' }).includes('apollo_credits'))
})

test('saving an OpenAI key is refused (with the reason) before the key is sent anywhere, unless OpenAI is named', () => {
  // the repo checks its routes by their source (as test/enrich-fallback-optin.test.ts does): the refusal comes before validateKey and writeKey
  const src = readFileSync(new URL('../app/api/settings/llm-key/route.ts', import.meta.url), 'utf8')
  const refuse = src.indexOf("if (vendor === 'openai' && !paidVendorOn('openai'))")
  assert.ok(refuse > 0, 'the refusal exists')
  assert.ok(refuse < src.indexOf('await validateKey(') && refuse < src.indexOf('await writeKey('), 'refused before the key is checked with the vendor or stored')
  assert.match(src.slice(refuse, refuse + 300), /status: 400/)
  assert.match(src.slice(refuse, refuse + 300), /dazl runs on Claude/)
})

test('the key panel offers OpenAI only when the operator named it, and says a saved OpenAI key is not used; onboarding asks for an Anthropic key', () => {
  const panel = readFileSync(new URL('../app/app/settings/llm-key-panel.tsx', import.meta.url), 'utf8')
  assert.match(panel, /\{openaiAllowed && <option value="openai">OpenAI<\/option>\}/)
  assert.match(panel, /not used: dazl runs on Claude/)
  const route = readFileSync(new URL('../app/api/settings/llm-key/route.ts', import.meta.url), 'utf8')
  assert.match(route, /openai_allowed: paidVendorOn\('openai'\)/)
  const inline = readFileSync(new URL('../app/app/key-inline.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(inline, /platform\.openai\.com|or sk-\.\.\./)
})
