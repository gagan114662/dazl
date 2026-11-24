// Claude only (#1392, #1435, #1579): no outside search or data service finds leads unless the operator switches it on by name, and a
// search that cannot run with Claude ends with a reason the person can act on. It never runs the older engine quietly instead.
// Invented companies and stubbed services only: no network, no real key.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { createQueryJob } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { migrateTinyfish, resetTinyfishState, tfFetch, tfSearch, tinyfishEnabled } from '../lib/search/tinyfish.ts'
import { peopleSearchEnabled } from '../lib/people/people-search.ts'
import { outcomeOwnCopy, scanOutcome } from '../lib/scan/scan-outcome.ts'
import { outcomeInputs } from '../lib/scan/progress.ts'
import { readRunReport } from '../lib/scan/run-report.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { knownErrorCopy } from '../lib/error-copy.ts'
import type { Provider } from '../lib/llm/provider.ts'
import type { DiscoverResult } from '../lib/discover/agent.ts'

test('the outside web search is off unless the operator sets TINYFISH_ENABLED=1; a key alone never turns it on', () => {
  assert.equal(tinyfishEnabled({ TINYFISH_API_KEY: 'tf-fixture' }), false, 'a key alone (production today) is off')
  assert.equal(tinyfishEnabled({ TINYFISH_API_KEY: 'tf-fixture', TINYFISH_ENABLED: '1' }), true)
  assert.equal(tinyfishEnabled({ TINYFISH_ENABLED: '1' }), false, 'the switch without a key is off')
  for (const v of ['0', '', 'true', 'yes', 'on', ' 1']) assert.equal(tinyfishEnabled({ TINYFISH_API_KEY: 'tf-fixture', TINYFISH_ENABLED: v }), false, `"${v}" is not the switch`)
  assert.equal(peopleSearchEnabled({ TINYFISH_API_KEY: 'tf-fixture' }), false, 'the people search follows the same switch')
  assert.equal(peopleSearchEnabled({ TINYFISH_API_KEY: 'tf-fixture', TINYFISH_ENABLED: '1' }), true)
  assert.equal(peopleSearchEnabled({ TINYFISH_API_KEY: 'tf-fixture', TINYFISH_ENABLED: '1', PEOPLE_SEARCH_ENABLED: '0' }), false)
})

test('with a key and no switch, a search and a page read send nothing', async () => {
  const db = new Database(':memory:'); migrateTinyfish(db); resetTinyfishState()
  let sent = 0
  const fetchImpl = (async () => { sent++; return new Response('{}') }) as unknown as typeof fetch
  const env = { TINYFISH_API_KEY: 'tf-fixture' }
  assert.deepEqual(await tfSearch(db, 'T', 'dental clinics opening', {}, { searches: 0 }, { env, fetchImpl }), { ok: false, reason: 'disabled' })
  assert.deepEqual(await tfFetch(db, 'T', ['https://clinic.example/news'], { fetches: 0 }, { env, fetchImpl }), { ok: false, reason: 'disabled' })
  assert.equal(sent, 0)
})

// A model that fails the test if the older engine asks it anything
const untouched = (asked: string[]): Provider => ({
  configuredModel: () => 'fixture-model',
  research: async () => { asked.push('research'); return { text: '[]', citedUrls: [] } },
  complete: async () => { asked.push('complete'); return '[]' },
} as unknown as Provider)
const setup = () => {
  const master = randomBytes(32)
  process.env.DAZL_MASTER_KEY = master.toString('base64')
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  return { db, master }
}
const row = (db: Database.Database, id: string) => db.prepare('SELECT status, error FROM scan_jobs WHERE id = ?').get(id) as { status: string; error: string | null }
const neverDiscover = async (): Promise<DiscoverResult> => { throw new Error('the search must not start') }

test('a workspace with only an OpenAI key: the search ends saying dazl searches with Claude and to add an Anthropic key; the older engine does not run', async () => {
  const { db, master } = setup()
  saveKey(db, 'T', 'openai', 'sk-openai-fixture', master)
  const id = createQueryJob(db, 'T', { query: 'Dental clinics in a city opening a new location', seller: 'Clinic fit-out contractor' })
  const job = claimKeyedJob(db, id)
  const asked: string[] = []
  const model = untouched(asked)
  assert.equal(await runJob(db, job!, { master, discover: true, discoverImpl: neverDiscover, providers: { openai: model, anthropic: model } as never }), 'failed')
  const j = row(db, id)
  assert.deepEqual([j.status, j.error], ['failed', 'claude_key_required'])
  assert.deepEqual(asked, [], 'no model call, so no profile inference and no older search')
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM leads WHERE scan_job_id = ?').get(id) as { n: number }).n, 0)
  const o = scanOutcome({ id, status: 'failed', error: 'claude_key_required' })
  assert.equal(o.kind, 'failed')
  assert.deepEqual(o.next, { text: 'Add your Anthropic key in Settings', href: '/app/settings' })
  const words = outcomeOwnCopy(o) ?? ''
  assert.match(words, /dazl searches with Claude/)
  assert.match(words, /Add your Anthropic key in Settings to run a search/)
  assert.doesNotMatch(words, /claude_key_required|lane|engine|TinyFish/i, 'plain words, no internal names')
  // the same sentence when the request is refused before a job exists
  assert.match(knownErrorCopy('claude_key_required') ?? '', /dazl searches with Claude.*Add your Anthropic key in Settings to run a search/)
})

test('too little budget left for a search: the scan stops as a budget stop and says how much was left; the older engine does not run', async () => {
  const { db, master } = setup()
  saveKey(db, 'T', 'anthropic', 'sk-ant-test', master)
  const id = createQueryJob(db, 'T', { query: 'Dental clinics in a city opening a new location', seller: 'Clinic fit-out contractor', runBudget: JSON.stringify({ max_usd: 0.1 }) })
  const job = claimKeyedJob(db, id)
  const asked: string[] = []
  const model = untouched(asked)
  assert.equal(await runJob(db, job!, { master, discover: true, discoverImpl: neverDiscover, providers: { openai: model, anthropic: model } as never }), 'failed')
  const j = row(db, id)
  assert.deepEqual([j.status, j.error], ['failed', 'budget_stopped'])
  assert.deepEqual(asked, [], 'the older engine did not run in its place')
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM scan_spend_calls WHERE scan_job_id = ?').get(id) as { n: number }).n, 0, 'nothing was reserved or sent')
  const report = (await readRunReport(sqliteDb(db), 'T', id))?.at(-1) ?? null
  const inputs = outcomeInputs(report, [], 'failed')
  assert.equal(inputs.stop_refusal_reason, 'over_limit', "the run's own limit is what left too little")
  assert.deepEqual(inputs.stop_room, { left_usd: 0.1, needed_usd: 0.3 })
  const o = scanOutcome({ id, status: 'failed', error: 'budget_stopped', ...inputs })
  assert.equal(o.kind, 'stopped')
  const words = outcomeOwnCopy(o) ?? ''
  assert.match(words, /\$0\.10 was left/)
  assert.match(words, /at least \$0\.30/)
  assert.match(words, /this run's spending limit/)
  assert.match(words, /No search was run/)
  assert.deepEqual(o.next, { text: 'Run it again with a larger budget', href: '/app/leads' })
})

test('a budget stop that recorded no amount keeps its existing words', () => {
  const plain = scanOutcome({ id: 'j', status: 'failed', error: 'budget_stopped', stop_refusal_reason: 'over_limit' })
  assert.equal(plain.label, 'Stopped by its budget - not an empty search')
  assert.equal(outcomeOwnCopy(plain), null)
  for (const junk of [null, 'x', {}, { left_usd: 'a', needed_usd: 0.3 }, { left_usd: -1, needed_usd: 0.3 }, { left_usd: 0.1 }]) {
    assert.equal(outcomeOwnCopy(scanOutcome({ id: 'j', status: 'failed', error: 'budget_stopped', stop_refusal_reason: 'over_limit', stop_room: junk as never })), null, JSON.stringify(junk))
  }
})

test('a free search whose spending limit is too small for a Claude search ends as not available; the older engine does not run', async () => {
  const env: Record<string, string> = { DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-trial-fixture', DAZL_TRIAL_SCAN_RESERVE_USD: '0.2', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1', DAZL_TRIAL_GLOBAL_DAILY_USD: '10',
    TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.05', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.01' }
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env)
  try {
    const { db, master } = setup()
    const id = createQueryJob(db, 'keyless', { query: 'Dental clinics in a city opening a new location' })
    db.prepare("UPDATE scan_jobs SET funded_by = 'trial' WHERE id = ?").run(id)
    const job = claimKeyedJob(db, id)
    assert.ok(job)
    const asked: string[] = []
    const model = untouched(asked)
    assert.equal(await runJob(db, job!, { master, discover: true, discoverImpl: neverDiscover, providers: { openai: model, anthropic: model } as never }), 'failed')
    const j = row(db, id)
    assert.deepEqual([j.status, j.error], ['failed', 'trial_unavailable'])
    assert.deepEqual(asked, [])
    const o = scanOutcome({ id, status: 'failed', error: 'trial_unavailable', funded_by: 'trial' })
    assert.equal(o.label, 'Not started - free scans are not available right now')
    assert.match(outcomeOwnCopy(o) ?? '', /Add your own Anthropic key in Settings to run a search/)
  } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
})

test('the test switch still reaches the older engine: with the Claude search switched off, a request is not refused for its key', async () => {
  const { db, master } = setup()
  saveKey(db, 'T', 'openai', 'sk-openai-fixture', master)
  const id = createQueryJob(db, 'T', { query: 'Dental clinics in a city opening a new location' })
  const job = claimKeyedJob(db, id)
  const asked: string[] = []
  const model = untouched(asked)
  // #1665: an OpenAI key is a usable key only when the operator names openai; this test is about the engine switch, so it names it
  const before = process.env.DAZL_PAID_VENDORS
  process.env.DAZL_PAID_VENDORS = 'openai'
  try {
    await runJob(db, job!, { master, discover: false, providers: { openai: model, anthropic: model } as never })
  } finally { if (before === undefined) delete process.env.DAZL_PAID_VENDORS; else process.env.DAZL_PAID_VENDORS = before }
  assert.notEqual(row(db, id).error, 'claude_key_required')
  assert.ok(asked.length > 0, 'the older engine ran, as the existing tests of it need')
})

test('#1665 the same request with OpenAI switched off: the OpenAI key is not used, no model is asked, and it ends asking for an Anthropic key', async () => {
  const { db, master } = setup()
  saveKey(db, 'T', 'openai', 'sk-openai-fixture', master)
  const id = createQueryJob(db, 'T', { query: 'Dental clinics in a city opening a new location' })
  const job = claimKeyedJob(db, id)
  const asked: string[] = []
  const model = untouched(asked)
  const before = process.env.DAZL_PAID_VENDORS
  delete process.env.DAZL_PAID_VENDORS
  try {
    assert.equal(await runJob(db, job!, { master, discover: false, providers: { openai: model, anthropic: model } as never }), 'failed')
  } finally { if (before !== undefined) process.env.DAZL_PAID_VENDORS = before }
  assert.deepEqual(asked, [], 'OpenAI was not asked anything')
  assert.equal(row(db, id).error, 'claude_key_required')
})

// #1602: the free scan needs dazl's own Claude key and the three money limits, nothing from TinyFish. Before this, turning TinyFish off
// (or leaving its two prices unset) made trialCaps() null, so every new account was told free scans are not available.
const TRIAL_LIMITS = { DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-trial-fixture', DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1', DAZL_TRIAL_GLOBAL_DAILY_USD: '10' }
test('free scans do not depend on TinyFish: with it unset or switched off, a new account is still admitted', async () => {
  const { admitTrialScan, trialCaps, trialFundable, trialTinyfishPrices } = await import('../lib/billing/trial-budget.ts')
  const { readTrialStatus } = await import('../lib/scan/trial.ts')
  for (const [name, env] of Object.entries({ 'TinyFish key unset': { ...TRIAL_LIMITS }, 'TINYFISH_ENABLED=0': { ...TRIAL_LIMITS, TINYFISH_API_KEY: 'tf-fixture', TINYFISH_ENABLED: '0' } }) as [string, Record<string, string>][]) {
    assert.deepEqual(trialCaps(env), { reserveUsd: 0.3, accountTotalUsd: 1, globalDailyUsd: 10 }, name)
    assert.equal(trialFundable(env as unknown as NodeJS.ProcessEnv), true, name)
    const db = new Database(':memory:'); migrateAllSqlite(db)
    const u = { id: 'a'.repeat(32), email: 'ann@acme.example' }
    db.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')").run(u.id, u.email)
    db.prepare("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)").run('sub-a', u.id)
    const a = await admitTrialScan(sqliteDb(db), u, { env, now: 1_800_000_000 })
    assert.equal(a.ok, true, `${name}: ${JSON.stringify(a)}`)
    assert.equal((await readTrialStatus(sqliteDb(db), u.id, '203.0.113.9', new Date(1_800_000_000_000), env as unknown as NodeJS.ProcessEnv)).funded, true, name)
    assert.equal(trialTinyfishPrices(env), null, 'no TinyFish price is set, and none is needed')
  }
  // still refused without dazl's own Claude key, and without any one of the three limits
  const noKey = { ...TRIAL_LIMITS, DAZL_TRIAL_ANTHROPIC_KEY: '' }
  assert.equal(trialFundable(noKey as unknown as NodeJS.ProcessEnv), false)
  { const db = new Database(':memory:'); migrateAllSqlite(db)
    const t = await readTrialStatus(sqliteDb(db), 'T', '203.0.113.9', new Date(1_800_000_000_000), noKey as unknown as NodeJS.ProcessEnv)
    assert.deepEqual([t.funded, t.reason], [false, 'not_configured']) }
  for (const k of ['DAZL_TRIAL_SCAN_RESERVE_USD', 'DAZL_TRIAL_ACCOUNT_TOTAL_USD', 'DAZL_TRIAL_GLOBAL_DAILY_USD']) {
    assert.equal(trialCaps({ ...TRIAL_LIMITS, [k]: '' }), null, `${k} unset: no free scans`)
    assert.equal(trialFundable({ ...TRIAL_LIMITS, [k]: '' } as unknown as NodeJS.ProcessEnv), false)
  }
})

test('trialCaps reads no TinyFish setting at all', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/billing/trial-budget.ts', import.meta.url), 'utf8')
  const at = src.indexOf('export function trialCaps(')
  const body = src.slice(at, src.indexOf('\n}\n', at))
  assert.ok(body.includes('DAZL_TRIAL_SCAN_RESERVE_USD'), 'the function body was found')
  assert.doesNotMatch(body, /TINYFISH/i)
  const caps = src.indexOf('export interface TrialCaps')
  assert.doesNotMatch(src.slice(caps, src.indexOf('\n}\n', caps)), /tinyfish/i, 'the caps carry no TinyFish price')
  // and it shows in behaviour: every TinyFish setting can change without changing the caps
  const { trialCaps } = await import('../lib/billing/trial-budget.ts')
  const base = trialCaps(TRIAL_LIMITS)
  assert.notEqual(base, null)
  for (const extra of [{ TINYFISH_API_KEY: 'k' }, { TINYFISH_API_KEY: 'k', TINYFISH_ENABLED: '1' }, { TINYFISH_ENABLED: '0' }, { DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.05', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.01' }]) assert.deepEqual(trialCaps({ ...TRIAL_LIMITS, ...extra }), base)
})

test('the older TinyFish steps of a free scan are priced only when both prices are set', async () => {
  const { trialTinyfishPrices } = await import('../lib/billing/trial-budget.ts')
  assert.deepEqual(trialTinyfishPrices({ DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.05', DAZL_TRIAL_TINYFISH_FETCH_USD: '0' }), { searchUsd: 0.05, fetchUsd: 0 })
  assert.equal(trialTinyfishPrices({ DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.05' }), null)
  assert.equal(trialTinyfishPrices({ DAZL_TRIAL_TINYFISH_SEARCH_USD: '-1', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.01' }), null)
})

// What a CSV company import does now (item 4 of the plan): its only search was TinyFish, and the model's own web search was retired
// earlier because its cost has no bound. With TinyFish off it stops before any search, on the real providers, and sends nothing
// (the test fence refuses every outside connection). It does not find leads until it is moved to the Claude search.
test('a CSV company job with TinyFish off stops before any search and calls no outside service', async () => {
  const { db, master } = setup()
  saveKey(db, 'T', 'anthropic', 'sk-ant-test', master)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, csv_domain) VALUES ('csv1', 'T', 'Acme', '-', '-', 'acme.example')").run()
  const job = claimKeyedJob(db, 'csv1')
  const old = { key: process.env.TINYFISH_API_KEY, on: process.env.TINYFISH_ENABLED }
  process.env.TINYFISH_API_KEY = 'tf-fixture'; delete process.env.TINYFISH_ENABLED   // production today: a key, no switch
  try {
    assert.equal(await runJob(db, job!, { master }), 'failed')
  } finally { for (const [k, v] of [['TINYFISH_API_KEY', old.key], ['TINYFISH_ENABLED', old.on]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
  assert.deepEqual([row(db, 'csv1').status, row(db, 'csv1').error], ['failed', 'unbounded_fallback_hold'])
  assert.deepEqual(db.prepare('SELECT collector, status FROM scan_source_runs WHERE job_id = ?').all('csv1'), [{ collector: 'search:anthropic', status: 'skipped_hold' }], 'TinyFish was not even started')
})
