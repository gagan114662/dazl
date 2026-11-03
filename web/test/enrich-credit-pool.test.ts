// Workspace credit pools for BYOK enrichment (lib/enrich/credit-pool.ts, #363): reserve before every credit-charging
// Apollo/PDL call, settle to the charge the response proves, refund only a call never made, fail closed when the
// reservation cannot be saved. Synthetic tenants and companies; stubbed providers only - no network, no credits.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { bothEngines } from './helpers/engines.ts'
import { creditLimits, creditPeriod, creditUse, reserveCredits, settleCredits, refundCredits, CreditRefused, DEFAULT_CREDIT_LIMITS } from '../lib/enrich/credit-pool.ts'
import { enrichLeadContacts } from '../lib/enrich/index.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential, recentAudit, setEnrichFallback } from '../lib/connectors/store.ts'
import { migrateCommenterImport, enrichCommenters } from '../lib/scan/commenter-import.ts'
import { poolRows, periodOf, sharedPool } from '../lib/llm/spend-pool.ts'

const T0 = Date.UTC(2026, 10, 2, 12) / 1000 // 2026-11-02 12:00 UTC
const refused = (reason: string) => (e: unknown) => e instanceof CreditRefused && e.reason === reason
const env = (o: Record<string, string>) => o
const use = async (db: Parameters<typeof creditUse>[0], t: string, e: Record<string, string> = {}, now = T0) =>
  Object.fromEntries((await creditUse(db, t, { env: e, now })).filter(u => u.reserved || u.charged).map(u => [u.period, [u.reserved, u.charged]]))

test('limits: defaults, operator overrides, and anything that is not a positive whole number keeps the default', () => {
  assert.deepEqual(creditLimits('apollo', {}), DEFAULT_CREDIT_LIMITS.apollo)
  assert.deepEqual(creditLimits('pdl', {}), { day: 25, month: 100 })
  assert.deepEqual(creditLimits('apollo', env({ DAZL_APOLLO_CREDITS_DAY: '3', DAZL_APOLLO_CREDITS_MONTH: '9' })), { day: 3, month: 9 })
  for (const bad of ['0', '-1', '2.5', 'off', '', 'Infinity']) assert.deepEqual(creditLimits('pdl', env({ DAZL_PDL_CREDITS_DAY: bad })), { day: 25, month: 100 }, bad)
  assert.equal(creditPeriod('apollo', 'day', T0), 'cad:20261102')
  assert.equal(creditPeriod('pdl', 'month', T0), 'cpm:202611')
  // Never the owner LLM pool's periods (d:, m:, p:, l:).
  for (const p of [creditPeriod('apollo', 'day', T0), creditPeriod('pdl', 'month', T0)]) assert.ok(p.length <= 12 && !/^[dmpl]:/.test(p), p)
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
