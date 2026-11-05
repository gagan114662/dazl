// Workspace credit pools for BYOK enrichment (lib/enrich/credit-pool.ts, #363): reserve before every credit-charging
// Apollo/PDL call, settle to the charge the response proves, refund only a call never made, fail closed when the
// reservation cannot be saved. Synthetic tenants and companies; stubbed providers only - no network, no credits.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { bothEngines } from './helpers/engines.ts'
import { creditLockKey, parseRefusalLookup, creditLimits, setCreditLimit, operatorCreditLimits, creditPeriod, creditUse, reserveCredits, settleCredits, refundCredits, CreditRefused } from '../lib/enrich/credit-pool.ts'
import { enrichLeadContacts } from '../lib/enrich/index.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential, recentAudit, setEnrichFallback } from '../lib/connectors/store.ts'
import { migrateCommenterImport, enrichCommenters } from '../lib/scan/commenter-import.ts'
import { poolRows, periodOf, sharedPool } from '../lib/llm/spend-pool.ts'
import { providerIssueText } from '../lib/scan/provider-issue-text.ts'
import { PG_URL } from './helpers/pg-test.ts'
import { runWithJobSpend } from '../lib/scan/spend-cap.ts'

const T0 = Date.UTC(2026, 10, 2, 12) / 1000 // 2026-11-02 12:00 UTC
const refused = (reason: string) => (e: unknown) => e instanceof CreditRefused && e.reason === reason
const env = (o: Record<string, string>) => o
const use = async (db: Parameters<typeof creditUse>[0], t: string, e: Record<string, string> = {}, now = T0) =>
  Object.fromEntries((await creditUse(db, t, { env: e, now })).filter(u => u.reserved || u.charged).map(u => [u.period, [u.reserved, u.charged]]))

test('operator limits: only a positive whole number counts; anything else is UNSET, never unlimited-by-typo and never a default', () => {
  assert.deepEqual(operatorCreditLimits('apollo', {}), { day: null, month: null })
  assert.deepEqual(operatorCreditLimits('pdl', {}), { day: null, month: null }) // no 100/month free-tier default
  assert.deepEqual(operatorCreditLimits('apollo', env({ DAZL_APOLLO_CREDITS_DAY: '3', DAZL_APOLLO_CREDITS_MONTH: '9' })), { day: 3, month: 9 })
  for (const bad of ['0', '-1', '2.5', 'off', '', 'Infinity']) assert.deepEqual(operatorCreditLimits('pdl', env({ DAZL_PDL_CREDITS_DAY: bad })), { day: null, month: null }, bad)
  assert.equal(creditPeriod('apollo', 'day', T0), 'cad:20261102')
  assert.equal(creditPeriod('pdl', 'month', T0), 'cpm:202611')
  // Never the owner LLM pool's periods (d:, m:, p:, l:).
  for (const p of [creditPeriod('apollo', 'day', T0), creditPeriod('pdl', 'month', T0)]) assert.ok(p.length <= 12 && !/^[dmpl]:/.test(p), p)
})

bothEngines('UNSET limit: a paid service is not tightened - 500 reservations pass, usage is still counted; a tenant limit then binds only that tenant', async ({ db }) => {
  assert.deepEqual(await creditLimits(db, 'A', 'pdl', {}), { day: null, month: null, source: { day: null, month: null } })
  for (let i = 0; i < 500; i++) await reserveCredits(db, 'A', 'pdl', 1, { env: {}, now: T0 })
  assert.deepEqual(await use(db, 'A', {}), { 'cpd:20261102': [500, 0], 'cpm:202611': [500, 0] })
  // The tenant sets its own limit (operator env says 800/day; the tenant's own value wins, per window).
  const e = env({ DAZL_APOLLO_CREDITS_DAY: '800', DAZL_APOLLO_CREDITS_MONTH: '900' })
  await setCreditLimit(db, 'A', 'apollo', 'day', 2)
  assert.deepEqual(await creditLimits(db, 'A', 'apollo', e), { day: 2, month: 900, source: { day: 'tenant', month: 'operator' } })
  await reserveCredits(db, 'A', 'apollo', 2, { env: e, now: T0 })
  await assert.rejects(reserveCredits(db, 'A', 'apollo', 1, { env: e, now: T0 }), (x: unknown) => refused('credit_cap')(x) && (x as CreditRefused).window === 'day')
  await reserveCredits(db, 'B', 'apollo', 50, { env: e, now: T0 }) // another tenant: untouched
  // Cleared: back to unset (operator value for the month, none for the day).
  await setCreditLimit(db, 'A', 'apollo', 'day', null)
  await reserveCredits(db, 'A', 'apollo', 1, { env: {}, now: T0 })
  for (const bad of [0, -1, 2.5, 1_000_001]) await assert.rejects(setCreditLimit(db, 'A', 'apollo', 'day', bad), /whole number/)
})

test('the refusal a user reads names the provider, window, credits used against the limit, and where to change it', () => {
  const msg = providerIssueText({ connector: 'enrich:pdl', status: 'credit_cap', lookups_affected: 3, latest_at: 1, credit: { window: 'month', used: 100, limit: 100, requested: 5 } })
  assert.match(msg, /People Data Labs enrichment was skipped/)
  assert.match(msg, /monthly People Data Labs credit limit \(100 of 100 credits used this UTC month\)/)
  assert.match(msg, /was reached/)
  assert.match(providerIssueText({ connector: 'enrich:pdl', status: 'credit_cap', lookups_affected: 1, latest_at: 1, credit: { window: 'day', used: 0, limit: 4, requested: 5 } }), /the next lookup needed 5 credits and only 4 remained.*\(0 of 4 credits used this UTC day\)/)
  assert.match(msg, /Settings > Enrichment/)
  assert.match(providerIssueText({ connector: 'enrich:apollo', status: 'credit_unsaved', lookups_affected: 1, latest_at: 1 }), /Apollo enrichment was skipped.*could not be saved.*this skipped lookup was not made.*nothing was charged for it.*earlier in the scan keep their own charges/)
  assert.doesNotMatch(providerIssueText({ connector: 'enrich:apollo', status: 'credit_unsaved', lookups_affected: 1, latest_at: 1 }), /Nothing was charged/)
})

test('CI Postgres leg cannot silently skip the PG twins (DAZL_REQUIRE_PG=1 requires DAZL_TEST_PG_URL)', () => {
  if (process.env.DAZL_REQUIRE_PG === '1') assert.ok(PG_URL, 'PG twins must run in this job')
})

bothEngines('a reservation fits in both windows or is refused whole; another tenant and the LLM pool are untouched', async ({ db }) => {
  const e = env({ DAZL_APOLLO_CREDITS_DAY: '2', DAZL_APOLLO_CREDITS_MONTH: '3' })
  await reserveCredits(db, 'A', 'apollo', 1, { env: e, now: T0 })
  await reserveCredits(db, 'A', 'apollo', 1, { env: e, now: T0 })
  await assert.rejects(reserveCredits(db, 'A', 'apollo', 1, { env: e, now: T0 }), refused('credit_cap'))
  assert.deepEqual(await use(db, 'A', e), { 'cad:20261102': [2, 0], 'cam:202611': [2, 0] })
  // Next day: the day fits, the month (3) refuses a reservation of 2, and neither window is raised.
  await assert.rejects(reserveCredits(db, 'A', 'apollo', 2, { env: e, now: T0 + 86400 }), refused('credit_cap'))
  assert.deepEqual(await use(db, 'A', e, T0 + 86400), { 'cam:202611': [2, 0] })
  // Another tenant has its own windows; PDL is its own pool.
  await reserveCredits(db, 'B', 'apollo', 2, { env: e, now: T0 })
  await reserveCredits(db, 'A', 'pdl', 5, { env: e, now: T0 })
  assert.deepEqual(await use(db, 'A', e), { 'cad:20261102': [2, 0], 'cam:202611': [2, 0], 'cpd:20261102': [5, 0], 'cpm:202611': [5, 0] })
  // The owner LLM pool on the same table still sees only its own rows.
  await sharedPool(db, 'A', { day: 1 }, () => T0).reserve(0.5)
  const rows = await poolRows(db, 'A')
  assert.equal(rows.find(r => r.period === periodOf('day', T0))?.reserved_usd, 0.5)
})

bothEngines('settle moves the reservation to the proved charge, refund releases a call never made, an overrun is recorded', async ({ db }) => {
  const e = env({ DAZL_PDL_CREDITS_DAY: '10' })
  const h = await reserveCredits(db, 'A', 'pdl', 5, { env: e, now: T0 })
  await settleCredits(db, h, 2) // 2 of 5 profiles returned
  assert.deepEqual(await use(db, 'A', e), { 'cpd:20261102': [2, 2], 'cpm:202611': [2, 2] })
  await assert.rejects(settleCredits(db, h, 2), /already settled/)
  const r = await reserveCredits(db, 'A', 'pdl', 5, { env: e, now: T0 })
  await refundCredits(db, r)
  assert.deepEqual(await use(db, 'A', e), { 'cpd:20261102': [2, 2], 'cpm:202611': [2, 2] })
  // A vendor that charged more than reserved: recorded past the limit, and the next reservation is refused.
  const o = await reserveCredits(db, 'A', 'pdl', 5, { env: e, now: T0 })
  await settleCredits(db, o, 9)
  assert.deepEqual(await use(db, 'A', e), { 'cpd:20261102': [11, 11], 'cpm:202611': [11, 11] })
  await assert.rejects(reserveCredits(db, 'A', 'pdl', 1, { env: e, now: T0 }), refused('credit_cap'))
})

bothEngines('concurrent reservations never pass the limit together', async ({ db }) => {
  const e = env({ DAZL_APOLLO_CREDITS_DAY: '5' })
  const out = await Promise.allSettled(Array.from({ length: 12 }, () => reserveCredits(db, 'A', 'apollo', 1, { env: e, now: T0 })))
  assert.equal(out.filter(o => o.status === 'fulfilled').length, 5)
  assert.ok(out.filter(o => o.status === 'rejected').every(o => refused('credit_cap')((o as PromiseRejectedResult).reason)))
  assert.deepEqual(await use(db, 'A', e), { 'cad:20261102': [5, 0], 'cam:202611': [5, 0] })
}, { pgMax: 6 })

test('a store that cannot save the reservation refuses (fail closed)', async () => {
  const db = new Database(':memory:') // no tenant_spend_pools table
  await assert.rejects(reserveCredits(db, 'A', 'apollo', 1), refused('credit_reservation_not_saved'))
})

// The scan waterfall (lib/enrich/index.ts), stubbed Apollo and PDL.
const master = randomBytes(32)
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
const NYC = JSON.stringify({ summary: 'NYC dental', where: ['New York City'], who: ['Practice manager'], signals: [] })
function seed(n: number, keys: { apollo?: boolean; pdl?: boolean }) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(NYC, jobId)
  const leads = Array.from({ length: n }, (_, i) => ({ id: `lead${i + 1}`, company: `Harbor Dental ${i + 1}`, company_domain: `harbor${i + 1}.example` as string | null }))
  for (const l of leads) db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES (?, ?, '', ?, ?, 'opened', 'https://x.example/1')").run(l.id, jobId, l.company, l.company_domain)
  if (keys.apollo) saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  if (keys.pdl) saveCredential(db, 'u1', 'enrich:pdl', 'test-pdl-key-5678', master)
  if (keys.apollo && keys.pdl) setEnrichFallback(db, 'u1', true)
  return { db, jobId, leads }
}
type Calls = { org: number; people: number; pdl: number }
const stub = (calls: Calls, pdl: () => Response = () => ok({ data: [] })) => (async (u: RequestInfo | URL) => {
  const s = String(u)
  if (s.includes('organizations/enrich')) { calls.org++; const d = /harbor\d+\.example/.exec(decodeURIComponent(s))?.[0]; return ok({ organization: { name: 'Harbor Dental', website_url: `https://${d ?? 'harbor1.example'}`, city: 'New York', state: 'New York', country: 'United States' } }) }
  if (s.includes('apollo.io')) { calls.people++; return ok({ people: [] }) }
  calls.pdl++; return pdl()
}) as typeof fetch
const statuses = (db: Database.Database) => (recentAudit(db, 'u1', 100) as { status: string }[]).map(a => a.status)

test('scan waterfall: the Apollo org lookup reserves 1 credit first; at the workspace cap no org call is made, visibly', async () => {
  const e = env({ DAZL_APOLLO_CREDITS_DAY: '2' })
  const { db, jobId, leads } = seed(3, { apollo: true })
  const calls: Calls = { org: 0, people: 0, pdl: 0 }
  const r = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: stub(calls), master, env: e })
  assert.equal(calls.org, 2, 'two org lookups fit the cap; the third is never sent')
  assert.deepEqual(r.skipped.filter(s => s.why === 'credit_cap').map(s => s.provider), ['apollo'])
  assert.ok(statuses(db).includes('credit_cap'), 'the refusal is an audit row')
  const now = Math.floor(Date.now() / 1000)
  assert.deepEqual(await use(db, 'u1', e, now), { [creditPeriod('apollo', 'day', now)]: [2, 2], [creditPeriod('apollo', 'month', now)]: [2, 2] })
})

test('scan waterfall: a restart or a second job cannot reset the cap (the pool is in the store)', async () => {
  const e = env({ DAZL_APOLLO_CREDITS_DAY: '1' })
  const { db, jobId, leads } = seed(1, { apollo: true })
  const calls: Calls = { org: 0, people: 0, pdl: 0 }
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: stub(calls), master, env: e })
  assert.equal(calls.org, 1)
  // A second job of the same tenant, as a fresh pass (a new process would read the same rows).
  const job2 = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(NYC, job2)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('other', ?, '', 'Other Dental', 'other.example', 'opened', 'https://x.example/2')").run(job2)
  const r = await enrichLeadContacts(db, 'u1', job2, [{ id: 'other', company: 'Other Dental', company_domain: 'other.example' }], { fetchImpl: stub(calls), master, env: e })
  assert.equal(calls.org, 1, 'no new paid org call')
  assert.deepEqual(r.skipped.map(s => s.why), ['credit_cap'])
})

test('scan waterfall: a replayed job makes no call and its reservation is refunded', async () => {
  const e = env({})
  const { db, jobId, leads } = seed(1, { apollo: true })
  const calls: Calls = { org: 0, people: 0, pdl: 0 }
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: stub(calls), master, env: e })
  const before = await use(db, 'u1', e, Math.floor(Date.now() / 1000))
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: stub(calls), master, env: e })
  assert.equal(calls.org, 1)
  assert.deepEqual(await use(db, 'u1', e, Math.floor(Date.now() / 1000)), before)
})

test('scan waterfall: PDL reserves the search size, settles to the profiles returned, and keeps it all on an error', async () => {
  const e = env({})
  const now = () => Math.floor(Date.now() / 1000)
  const two = { data: [1, 2].map(i => ({ full_name: `Pdl Person ${i}`, job_title: 'Practice Manager', job_company_website: 'harbor1.example', job_company_location_locality: 'new york', job_company_location_region: 'new york', job_company_location_country: 'united states' })) }
  const a = seed(1, { pdl: true }); const c1: Calls = { org: 0, people: 0, pdl: 0 }
  await enrichLeadContacts(a.db, 'u1', a.jobId, a.leads, { fetchImpl: stub(c1, () => ok(two)), master, env: e })
  assert.equal(c1.pdl, 1)
  assert.deepEqual(await use(a.db, 'u1', e, now()), { [creditPeriod('pdl', 'day', now())]: [2, 2], [creditPeriod('pdl', 'month', now())]: [2, 2] })
  const b = seed(1, { pdl: true }); const c2: Calls = { org: 0, people: 0, pdl: 0 }
  await enrichLeadContacts(b.db, 'u1', b.jobId, b.leads, { fetchImpl: stub(c2, () => new Response('x', { status: 503 })), master, env: e })
  assert.equal(c2.pdl, 1)
  assert.deepEqual(await use(b.db, 'u1', e, now()), { [creditPeriod('pdl', 'day', now())]: [5, 0], [creditPeriod('pdl', 'month', now())]: [5, 0] }, 'the vendor may have billed a failed call: nothing is released')
})

test('scan waterfall: PDL at the cap is refused before any call', async () => {
  const e = env({ DAZL_PDL_CREDITS_DAY: '4' }) // a PDL search reserves 5
  const { db, jobId, leads } = seed(2, { pdl: true }); const calls: Calls = { org: 0, people: 0, pdl: 0 }
  const r = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: stub(calls), master, env: e })
  assert.equal(calls.pdl, 0)
  assert.deepEqual(r.skipped.map(s => `${s.provider}:${s.why}`), ['pdl:credit_cap', 'pdl:credit_cap'])
})

test('scan waterfall: a lookup the hard per-scan cap refuses sends nothing, and its workspace credits go back', async () => {
  // Inside a scan's spend context (lib/scan/spend-cap.ts) a job that is not this tenant's running attempt refuses every
  // paid call before the request (SpendRefused). The credit pool must not keep a reservation for a call never made.
  const e = env({})
  const now = () => Math.floor(Date.now() / 1000)
  const a = seed(1, { apollo: true }); const c1: Calls = { org: 0, people: 0, pdl: 0 }
  await runWithJobSpend(a.db, 'u1', 'not-this-tenants-job', () => enrichLeadContacts(a.db, 'u1', a.jobId, a.leads, { fetchImpl: stub(c1), master, env: e }))
  assert.equal(c1.org, 0, 'the refused org lookup is never sent')
  assert.deepEqual(await use(a.db, 'u1', e, now()), {}, 'the Apollo credit is refunded')
  const b = seed(1, { pdl: true }); const c2: Calls = { org: 0, people: 0, pdl: 0 }
  await runWithJobSpend(b.db, 'u1', 'not-this-tenants-job', () => enrichLeadContacts(b.db, 'u1', b.jobId, b.leads, { fetchImpl: stub(c2), master, env: e }))
  assert.equal(c2.pdl, 0, 'the refused PDL search is never sent')
  assert.deepEqual(await use(b.db, 'u1', e, now()), {}, 'the PDL credits are refunded')
})

test('scan waterfall: when the store cannot save a reservation no paid call is made (fail closed)', async () => {
  const { db, jobId, leads } = seed(2, { apollo: true, pdl: true })
  db.exec('DROP TABLE tenant_spend_pools')
  const calls: Calls = { org: 0, people: 0, pdl: 0 }
  const r = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: stub(calls), master, env: {} })
  assert.equal(calls.org + calls.pdl, 0)
  assert.ok(r.skipped.some(s => s.provider === 'apollo' && s.why === 'credit_unsaved'))
  assert.ok(r.skipped.some(s => s.provider === 'pdl' && s.why === 'credit_unsaved'))
})

// Commenter import (lib/scan/commenter-import.ts): the same pool.
function seedBatch(companies: number) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateCommenterImport(db)
  const jobId = createJob(db, 'A', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  for (let i = 1; i <= companies; i++) db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES (?, ?, '', ?, ?, 'opened', 'https://x.example/1')").run(`l${i}`, jobId, `Harbor Dental ${i}`, `harbor${i}.example`)
  db.prepare("INSERT INTO commenter_batches (id, user_id, context, total, note, created_at, job_id) VALUES ('b1', 'A', 't', 1, NULL, 1, ?)").run(jobId)
  return { db, jobId }
}

test('commenter import: org lookups stop at the workspace cap (audited); the 0-credit people search still runs', async () => {
  const e = env({ DAZL_APOLLO_CREDITS_DAY: '1' })
  const { db } = seedBatch(3)
  saveCredential(db, 'A', 'enrich:apollo', 'test-apollo-key-1234', master)
  const calls: Calls = { org: 0, people: 0, pdl: 0 }
  await enrichCommenters(db, 'A', 'b1', { fetchImpl: stub(calls), master, env: e })
  assert.equal(calls.org, 1)
  assert.equal(calls.people, 3)
  assert.equal((recentAudit(db, 'A', 100) as { status: string }[]).filter(a => a.status.startsWith('credit_cap')).length, 1)
})

test('commenter import: PDL reserves before the call and stops the batch at the cap', async () => {
  const e = env({ DAZL_PDL_CREDITS_DAY: '7' })
  const { db } = seedBatch(3)
  saveCredential(db, 'A', 'enrich:pdl', 'test-pdl-key-5678', master)
  const calls: Calls = { org: 0, people: 0, pdl: 0 }
  await enrichCommenters(db, 'A', 'b1', { fetchImpl: stub(calls), master, env: e })
  // First search: 5 reserved, 0 returned -> settles to 0. Second: 5 reserved, 0 returned. Third: fits again.
  assert.equal(calls.pdl, 3)
  const now = Math.floor(Date.now() / 1000)
  assert.deepEqual(await use(db, 'A', e, now), {}, 'every search returned nothing: nothing stays charged')
  const failing = seedBatch(3)
  saveCredential(failing.db, 'A', 'enrich:pdl', 'test-pdl-key-5678', master)
  const c2: Calls = { org: 0, people: 0, pdl: 0 }
  await enrichCommenters(failing.db, 'A', 'b1', { fetchImpl: stub(c2, () => new Response('x', { status: 503 })), master, env: e })
  assert.equal(c2.pdl, 1, 'a failed search keeps its 5; the next would pass 7 and is never sent')
  assert.deepEqual(await use(failing.db, 'A', e, now), { [creditPeriod('pdl', 'day', now)]: [5, 0], [creditPeriod('pdl', 'month', now)]: [5, 0] })
})

bothEngines('C5: a limit lowered between the read and the reservation is honored (limit decided inside the same statement), a limit raised is honored too', async ({ db }) => {
  await setCreditLimit(db, 'A', 'apollo', 'day', 10)
  await reserveCredits(db, 'A', 'apollo', 3, { env: {}, now: T0 })
  // lowered to 3 while a reservation of 1 is in flight: must refuse (3 + 1 > 3), never pass against the stale 10
  await assert.rejects(reserveCredits(db, 'A', 'apollo', 1, { env: {}, now: T0, beforeReserve: () => setCreditLimit(db, 'A', 'apollo', 'day', 3) }), refused('credit_cap'))
  assert.deepEqual(await use(db, 'A', {}), { 'cad:20261102': [3, 0], 'cam:202611': [3, 0] }, 'the refused reservation raised no window')
  // raised to 10 while in flight: must pass against the new limit, not be refused against the stale 3
  await reserveCredits(db, 'A', 'apollo', 1, { env: {}, now: T0, beforeReserve: () => setCreditLimit(db, 'A', 'apollo', 'day', 10) })
  assert.deepEqual(await use(db, 'A', {}), { 'cad:20261102': [4, 0], 'cam:202611': [4, 0] })
  // cleared while in flight with an operator fallback of 4: the operator limit binds (4 + 1 > 4)
  await assert.rejects(reserveCredits(db, 'A', 'apollo', 1, { env: { DAZL_APOLLO_CREDITS_DAY: '4' }, now: T0, beforeReserve: () => setCreditLimit(db, 'A', 'apollo', 'day', null) }), refused('credit_cap'))
})

test('C6a scan waterfall: a replay of a lookup already answered at a FULL pool is recognized as a replay (no call, no new reservation, not credit_cap)', async () => {
  const e = env({})
  const now = () => Math.floor(Date.now() / 1000)
  const two = { data: [1, 2].map(i => ({ full_name: `Pdl Person ${i}`, job_title: 'Practice Manager', job_company_website: 'harbor1.example', job_company_location_locality: 'new york', job_company_location_region: 'new york', job_company_location_country: 'united states' })) }
  const a = seed(1, { pdl: true }); const c1: Calls = { org: 0, people: 0, pdl: 0 }
  await enrichLeadContacts(a.db, 'u1', a.jobId, a.leads, { fetchImpl: stub(c1, () => ok(two)), master, env: e })
  assert.equal(c1.pdl, 1)
  await setCreditLimit(a.db, 'u1', 'pdl', 'day', 2) // the pool is now exactly full (2 of 2 charged)
  const before = await use(a.db, 'u1', e, now())
  const r = await enrichLeadContacts(a.db, 'u1', a.jobId, a.leads, { fetchImpl: stub(c1, () => ok(two)), master, env: e })
  assert.equal(c1.pdl, 1, 'the replay made no second paid call')
  assert.deepEqual(r.skipped.map(s => `${s.provider}:${s.why}`), ['pdl:replayed'], 'a known replay is replayed, not refused as a cap')
  assert.deepEqual(await use(a.db, 'u1', e, now()), before, 'the replay reserved and refunded nothing')
})

bothEngines('C6b/c/d holds: no double refund, a crashed reservation stays counted (over-count, never under), and the next pass cannot release it', async ({ db }) => {
  const e = env({ DAZL_PDL_CREDITS_DAY: '5' })
  const h = await reserveCredits(db, 'A', 'pdl', 5, { env: e, now: T0 })
  await refundCredits(db, h)
  await assert.rejects(refundCredits(db, h), /already settled/)
  await assert.rejects(settleCredits(db, h, 1), /already settled/)
  assert.deepEqual(await use(db, 'A', e), {}, 'one refund released exactly the reservation: no negative, no double release')
  // crash after reserve (the hold object is lost with the process): the credits stay reserved, and a later pass at the
  // limit is refused rather than admitted - the pool can only over-count a possible charge, never under-count it
  await reserveCredits(db, 'A', 'pdl', 5, { env: e, now: T0 })
  await assert.rejects(reserveCredits(db, 'A', 'pdl', 1, { env: e, now: T0 }), refused('credit_cap'))
  assert.deepEqual(await use(db, 'A', e), { 'cpd:20261102': [5, 0], 'cpm:202611': [5, 0] }, 'the lost hold keeps its full reservation')
})

bothEngines('C6 durable idempotency: a cloned or tampered hold, a refund after settle and a concurrent settle+refund release exactly once and never touch another reservation', async ({ db }) => {
  const e = env({})
  const other = await reserveCredits(db, 'A', 'pdl', 3, { env: e, now: T0 }) // an unrelated open reservation that must survive everything below
  const h = await reserveCredits(db, 'A', 'pdl', 5, { env: e, now: T0 })
  const clone = { ...h }, inflated = { ...h, units: 99 }
  await refundCredits(db, h)
  assert.deepEqual(await use(db, 'A', e), { 'cpd:20261102': [3, 0], 'cpm:202611': [3, 0] }, 'exactly the 5 credits went back; the other 3 stay')
  await assert.rejects(refundCredits(db, clone), /already settled/)
  await assert.rejects(settleCredits(db, inflated, 0), /already settled/)
  assert.deepEqual(await use(db, 'A', e), { 'cpd:20261102': [3, 0], 'cpm:202611': [3, 0] }, 'a cloned/replayed hold released nothing more')
  // refund after settle, and a tampered `units` never changes what a settle moves (the durable row decides)
  const h2 = await reserveCredits(db, 'A', 'pdl', 5, { env: e, now: T0 })
  await settleCredits(db, { ...h2, units: 1 }, 2)
  assert.deepEqual(await use(db, 'A', e), { 'cpd:20261102': [5, 2], 'cpm:202611': [5, 2] }, '5 reserved -> charged 2 releases 3, whatever units the object claimed')
  await assert.rejects(refundCredits(db, { ...h2 }), /already settled/)
  // concurrent settle + refund of one hold: exactly one wins
  const h3 = await reserveCredits(db, 'A', 'pdl', 4, { env: e, now: T0 })
  const res = await Promise.allSettled([settleCredits(db, { ...h3 }, 1), refundCredits(db, { ...h3 })])
  assert.equal(res.filter(r => r.status === 'fulfilled').length, 1, 'one release wins')
  const after = await use(db, 'A', e)
  assert.ok(JSON.stringify(after) === JSON.stringify({ 'cpd:20261102': [6, 3], 'cpm:202611': [6, 3] }) || JSON.stringify(after) === JSON.stringify({ 'cpd:20261102': [5, 2], 'cpm:202611': [5, 2] }), JSON.stringify(after))
  await refundCredits(db, other) // the unrelated reservation is still releasable, once
  await assert.rejects(refundCredits(db, other), /already settled/)
})

bothEngines('C5 serialization: set, lower, clear and reserve interleave in commit order and no set is lost', async ({ db }) => {
  const e = env({})
  const ops: Promise<unknown>[] = []
  for (let i = 0; i < 12; i++) ops.push(reserveCredits(db, 'A', 'apollo', 1, { env: e, now: T0 }).catch(x => x))
  ops.push(setCreditLimit(db, 'A', 'apollo', 'day', 5))
  for (let i = 0; i < 12; i++) ops.push(reserveCredits(db, 'A', 'apollo', 1, { env: e, now: T0 }).catch(x => x))
  await Promise.all(ops)
  assert.equal((await creditLimits(db, 'A', 'apollo', e)).day, 5, 'the concurrent set was not lost')
  const u = (await creditUse(db, 'A', { env: e, now: T0 })).find(x => x.provider === 'apollo' && x.window === 'day')!
  // Reservations admitted before the set committed may exceed 5 (they were authorized when unset); after it, none may.
  const more = await reserveCredits(db, 'A', 'apollo', 1, { env: e, now: T0 }).then(() => 'admitted', () => 'refused')
  assert.equal(more, u.reserved + 1 <= 5 ? 'admitted' : 'refused', `post-set reservation obeys the limit (reserved ${u.reserved})`)
  await setCreditLimit(db, 'A', 'apollo', 'day', null)
  assert.equal((await creditLimits(db, 'A', 'apollo', e)).day, null, 'clear sticks')
  await reserveCredits(db, 'A', 'apollo', 1, { env: e, now: T0 }) // cleared: admitted
}, { pgMax: 8 })

test('C2 the refusal numbers are stored at the moment of refusal (PDL 5 vs limit 4 at 0 used) and survive later limit/usage changes', async () => {
  const e = env({ DAZL_PDL_CREDITS_DAY: '4', DAZL_PDL_CREDITS_MONTH: '100' })
  const { db, jobId, leads } = seed(1, { pdl: true }); const calls: Calls = { org: 0, people: 0, pdl: 0 }
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: stub(calls), master, env: e })
  assert.equal(calls.pdl, 0)
  const rows = () => (db.prepare("SELECT lookup FROM connector_audit WHERE tenant_id = 'u1' AND status = 'credit_cap'").all() as { lookup: string }[])
  assert.equal(rows().length, 1)
  assert.deepEqual(parseRefusalLookup(rows()[0].lookup), { window: 'day', used: 0, limit: 4, requested: 5 }, 'the refusing window, its usage and limit, and the request - not the tightest-window guess')
  assert.doesNotMatch(rows()[0].lookup, /harbor/i, 'no company text in the stored refusal')
  // later changes: the limit is raised and credits are spent; the stored refusal still says what happened then
  await setCreditLimit(db, 'u1', 'pdl', 'day', 50)
  await reserveCredits(db, 'u1', 'pdl', 7, { env: e, now: Math.floor(Date.now() / 1000) })
  assert.deepEqual(parseRefusalLookup(rows()[0].lookup), { window: 'day', used: 0, limit: 4, requested: 5 })
  // the month window refusing instead (day fits): the month is the named window
  const e2 = env({ DAZL_PDL_CREDITS_DAY: '50', DAZL_PDL_CREDITS_MONTH: '3' })
  const b = seed(1, { pdl: true }); await enrichLeadContacts(b.db, 'u1', b.jobId, b.leads, { fetchImpl: stub({ org: 0, people: 0, pdl: 0 }), master, env: e2 })
  const r2 = parseRefusalLookup((b.db.prepare("SELECT lookup FROM connector_audit WHERE status = 'credit_cap'").get() as { lookup: string }).lookup)
  assert.equal(r2?.window, 'month'); assert.equal(r2?.limit, 3)
  // used == limit reads as reached; used < limit reads as need/remain
  assert.match(providerIssueText({ connector: 'enrich:apollo', status: 'credit_cap', lookups_affected: 1, latest_at: 1, credit: { window: 'month', used: 5, limit: 5, requested: 1 } }), /Apollo credit limit \(5 of 5 credits used this UTC month\) was reached/)
  assert.equal(parseRefusalLookup('people Harbor 1'), null)
})

test('C6d Apollo: a failed or unanswered org lookup keeps its credit (the vendor may have billed it) and a replay of that held lookup is not paid again', async () => {
  const e = env({})
  const now = () => Math.floor(Date.now() / 1000)
  const a = seed(1, { apollo: true }); const c1: Calls = { org: 0, people: 0, pdl: 0 }
  await enrichLeadContacts(a.db, 'u1', a.jobId, a.leads, { fetchImpl: (async (u: RequestInfo | URL) => { if (String(u).includes('organizations/enrich')) { c1.org++; return new Response('x', { status: 503 }) } return stub(c1)(u) }) as typeof fetch, master, env: e })
  assert.equal(c1.org, 1)
  assert.deepEqual(await use(a.db, 'u1', e, now()), { [creditPeriod('apollo', 'day', now())]: [1, 0], [creditPeriod('apollo', 'month', now())]: [1, 0] }, 'unknown charge: the credit stays counted')
  // the same job again (a retry or crash recovery): the claim is held/uncertain, no second paid call, no release of the credit
  const c2: Calls = { org: 0, people: 0, pdl: 0 }
  await enrichLeadContacts(a.db, 'u1', a.jobId, a.leads, { fetchImpl: stub(c2), master, env: e })
  assert.equal(c2.org, 0, 'a held lookup is never paid twice')
  assert.deepEqual(await use(a.db, 'u1', e, now()), { [creditPeriod('apollo', 'day', now())]: [1, 0], [creditPeriod('apollo', 'month', now())]: [1, 0] }, 'the replay released nothing and reserved nothing')
})

bothEngines('C6 holds are bound to their own row: tenant, provider, original window and units survive tampering, and an id collision fails closed', async ({ db }) => {
  const e = env({})
  const nextMonth = T0 + 40 * 86400
  const h = await reserveCredits(db, 'A', 'pdl', 5, { env: e, now: T0, holdId: 'aaaa0001' })
  // an id collision cannot overwrite or reuse the open hold: the reservation is refused whole and no window is raised
  await assert.rejects(reserveCredits(db, 'A', 'pdl', 2, { env: e, now: T0, holdId: 'aaaa0001' }), refused('credit_reservation_not_saved'))
  assert.deepEqual(await use(db, 'A', e), { 'cpd:20261102': [5, 0], 'cpm:202611': [5, 0] }, 'the colliding reservation rolled back')
  // tampered provider / units / window time on the object: the row decides, so the PDL Nov windows get exactly the 5 back
  await refundCredits(db, { ...h, provider: 'apollo', units: 1, at: nextMonth })
  assert.deepEqual(await use(db, 'A', e), {}, 'released the stored 5 from the stored provider and the ORIGINAL day and month')
  assert.deepEqual(await use(db, 'A', e, nextMonth), {}, 'the tampered month was never touched')
  // another tenant's id space: the same id under another tenant is not this hold
  const hb = await reserveCredits(db, 'B', 'apollo', 1, { env: e, now: T0, holdId: 'aaaa0001' })
  await assert.rejects(refundCredits(db, { ...hb, tenantId: 'A' }), /already settled/, 'a hold cannot be released under another tenant')
  await refundCredits(db, hb)
  // rollover: reserved late on one UTC day, settled on the next day: the original day/month windows move, not today's
  const late = Date.UTC(2026, 10, 30, 23, 59, 0) / 1000
  const h2 = await reserveCredits(db, 'A', 'apollo', 2, { env: e, now: late })
  await settleCredits(db, h2, 1)
  assert.deepEqual(await use(db, 'A', e, late), { 'cad:20261130': [1, 1], 'cam:202611': [1, 1] }, 'settled into the windows it was reserved in')
  assert.deepEqual(await use(db, 'A', e, late + 3600), {}, 'December / the next day gained nothing')
})

bothEngines('C5 PG commit order: a reserve and a set/clear both wait on the same per-pair lock and then complete', async ({ db, kind }) => {
  if (kind !== 'pg') return // SQLite transactions are exclusive by construction; this proves the PG advisory lock
  const pool = (db as unknown as { pool: { connect(): Promise<{ query(q: string, p?: unknown[]): Promise<unknown>; release(): void }> } }).pool
  const holder = await pool.connect()
  const key = creditLockKey('A', 'apollo')
  await holder.query('SELECT pg_advisory_lock(hashtext($1))', [key])
  let reserved = false, setDone = false, otherPairDone = false
  const r = reserveCredits(db, 'A', 'apollo', 1, { env: {}, now: T0 }).then(() => { reserved = true })
  const s = setCreditLimit(db, 'A', 'apollo', 'day', 1).then(() => { setDone = true })
  const o = reserveCredits(db, 'A', 'pdl', 1, { env: {}, now: T0 }).then(() => { otherPairDone = true }) // another provider is not blocked
  await new Promise(res => setTimeout(res, 400))
  assert.equal(reserved, false, 'reserve waits for the pair lock')
  assert.equal(setDone, false, 'set waits for the same pair lock')
  assert.equal(otherPairDone, true, 'a different provider is not serialized behind it')
  await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [key]); holder.release()
  await Promise.all([r.catch(() => {}), s, o])
  assert.equal((await creditLimits(db, 'A', 'apollo', {})).day, 1, 'the set landed')
  const more = await reserveCredits(db, 'A', 'apollo', 1, { env: {}, now: T0 }).then(() => 'admitted', () => 'refused')
  const u = (await creditUse(db, 'A', { env: {}, now: T0 })).find(x => x.provider === 'apollo' && x.window === 'day')!
  assert.ok(u.reserved >= 1, 'first reserve was admitted in one order or the other')
  assert.equal(more, 'refused', `after both commit, the limit of 1 binds (reserved ${u.reserved})`)
}, { pgMax: 8 })
