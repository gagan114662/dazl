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
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential } from '../lib/connectors/store.ts'
import { migrateKeys, saveKey, defaultVendor } from '../lib/llm/key-store.ts'
import { pickVendor } from '../lib/scan/runner.ts'
import { verifierFromEnv } from '../lib/people/email-pattern.ts'
import { jinaAdapter, resetJinaState } from '../lib/sources/jina.ts'

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
  // control: the operator names Apollo, and the same pass asks Apollo
  const c = enrichSeed()
  await enrichLeadContacts(c.db, 'u1', c.jobId, [c.lead], { fetchImpl, master, env: { DAZL_PAID_VENDORS: 'apollo' } })
  assert.ok(calls.some(u => u.includes('apollo')), JSON.stringify(calls))
})

test('model vendor: a saved OpenAI key is not used unless named; the Anthropic key is used even when it is older', () => {
  const db = new Database(':memory:'); migrateKeys(db)
  saveKey(db, 't1', 'anthropic', 'sk-ant-' + 'a'.repeat(40), master)
  db.prepare("UPDATE tenant_llm_keys SET created_at = created_at - 100 WHERE tenant_id = 't1'").run()
  saveKey(db, 't1', 'openai', 'sk-' + 'b'.repeat(40), master)
  assert.equal(pickVendor(db, 't1', OFF), 'anthropic')
  assert.equal(defaultVendor(db, 't1', OFF), 'anthropic')
  assert.equal(pickVendor(db, 't1', { DAZL_PAID_VENDORS: 'openai' }), 'openai', 'named: the newest key, as before')
  saveKey(db, 't2', 'openai', 'sk-' + 'c'.repeat(40), master)
  assert.equal(pickVendor(db, 't2', OFF), null, 'only an OpenAI key: no usable key (the scan fails no_api_key)')
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
  })
  await withProcessEnv('jina', async () => {
    resetJinaState(); asked.length = 0
    await jinaAdapter.collect({ query: 'q', keywords: ['dental'], feeds: [], pages: [PAGE], http })
    assert.deepEqual(asked, [`https://r.jina.ai/${PAGE}`])
  })
})
