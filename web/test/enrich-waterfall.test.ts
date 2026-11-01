// #382: Apollo -> PDL as a real fallback waterfall. Stubbed providers (invented company and people); no network, no credits.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { enrichLeadContacts, APOLLO_CALLS, PDL_CALLS, MAX_FAILS } from '../lib/enrich/index.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential, recentAudit, enrichmentsForLeads, setEnrichFallback, enrichFallbackEnabled } from '../lib/connectors/store.ts'

const master = randomBytes(32)
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
const NYC = JSON.stringify({ summary: 'NYC dental', where: ['New York City'], who: ['Practice manager'], signals: [] })
function seed(n = 1, both = true) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(NYC, jobId)
  const leads = Array.from({ length: n }, (_, i) => ({ id: `lead${i + 1}`, company: i === 0 ? 'Harbor Dental' : `Harbor Dental ${i + 1}`, company_domain: i === 0 ? 'harbordental.example' : null as string | null }))
  for (const l of leads) db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES (?, ?, '', ?, ?, 'opened', 'https://x.example/1')").run(l.id, jobId, l.company, l.company_domain)
  saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  // The fallback legs below all exercise the opt-IN state; the default-off contract has its own leg.
  if (both) { saveCredential(db, 'u1', 'enrich:pdl', 'test-pdl-key-5678', master); setEnrichFallback(db, 'u1', true) }
  return { db, jobId, leads }
}
const apolloWith = (people: unknown[], org: unknown = { organization: { name: 'Harbor Dental', website_url: 'https://harbordental.example', city: 'New York', state: 'New York', country: 'United States' } }) => async (url: string) => String(url).includes('organizations/enrich') ? ok(org) : ok({ people })
const PERSON = { name: 'Invented Manager', title: 'Practice Manager', linkedin_url: 'https://profiles.example/m', organization: { name: 'Harbor Dental', primary_domain: 'harbordental.example' } }
const PDL_OK = { data: [{ full_name: 'Pdl Person', job_title: 'Practice Manager', job_company_website: 'harbordental.example', job_company_location_locality: 'new york', job_company_location_region: 'new york', job_company_location_country: 'united states' }] }
type Calls = { apollo: number; pdl: number }
const router = (apollo: (u: string) => Promise<Response>, pdl: () => Promise<Response>, calls: Calls) => (async (u: RequestInfo | URL) => { const s = String(u); if (s.includes('apollo.io')) { calls.apollo++; return apollo(s) } calls.pdl++; return pdl() }) as typeof fetch
const attached = (db: Database.Database, id = 'lead1') => (enrichmentsForLeads(db, 'u1', [id])[id] ?? []).filter(e => e.kind === 'contact').map(e => `${e.connector}:${e.value}`)
const statuses = (db: Database.Database) => (recentAudit(db, 'u1', 50) as { connector: string; status: string }[]).map(a => `${a.connector.replace('enrich:', '')}:${a.status}`).reverse()

for (const [why, apollo] of [
  ['empty', async (u: string) => (u.includes('organizations') ? ok({ organization: { name: 'Harbor Dental', website_url: 'https://harbordental.example', city: 'New York', state: 'New York', country: 'United States' } }) : ok({ people: [] }))],
  ['401', async () => new Response('no', { status: 401 })],
  ['429', async () => new Response('slow', { status: 429 })],
  ['timeout', async () => { throw new DOMException('aborted', 'AbortError') }],
  ['5xx', async () => new Response('x', { status: 503 })],
] as [string, (u: string) => Promise<Response>][]) {
  test(`both keys: Apollo ${why} -> PDL is tried and its valid, agreeing person is attached`, async () => {
    const { db, jobId, leads } = seed(); const calls: Calls = { apollo: 0, pdl: 0 }
    const r = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(apollo, async () => ok(PDL_OK), calls), master })
    assert.deepEqual(attached(db), ['enrich:pdl:Pdl Person - Practice Manager']); assert.deepEqual(r.byProvider, { apollo: 0, pdl: 1 }); assert.equal(calls.pdl, 1)
  })
}

test('Apollo finds a verified person: PDL is not called (and not charged)', async () => {
  const { db, jobId, leads } = seed(); const calls: Calls = { apollo: 0, pdl: 0 }
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(apolloWith([PERSON]), async () => ok(PDL_OK), calls), master })
  assert.deepEqual(attached(db), ['enrich:apollo:Invented Manager - Practice Manager']); assert.equal(calls.pdl, 0)
})

test('only a PDL key (no Apollo key) still works; only an Apollo key never calls PDL', async () => {
  const a = seed(1, false); const c1: Calls = { apollo: 0, pdl: 0 }
  await enrichLeadContacts(a.db, 'u1', a.jobId, a.leads, { fetchImpl: router(async () => ok({ people: [] }), async () => ok(PDL_OK), c1), master }); assert.equal(c1.pdl, 0)
  const b = seed(1, true); b.db.prepare("DELETE FROM tenant_connectors WHERE connector = 'enrich:apollo'").run(); const c2: Calls = { apollo: 0, pdl: 0 }
  await enrichLeadContacts(b.db, 'u1', b.jobId, b.leads, { fetchImpl: router(async () => ok({ people: [] }), async () => ok(PDL_OK), c2), master })
  assert.deepEqual([c2.apollo, c2.pdl, attached(b.db).length], [0, 1, 1])
})

test('wrong-company results are still rejected, whichever provider returns them: Apollo (other company) falls through, PDL (Pico Rivera) is refused', async () => {
  const { db, jobId, leads } = seed(); const calls: Calls = { apollo: 0, pdl: 0 }
  const wrong = { data: [{ full_name: 'Wrong Person', job_title: 'Manager', job_company_website: 'harbordental.example', job_company_location_locality: 'pico rivera', job_company_location_region: 'california', job_company_location_country: 'united states' }] }
  const other = { ...PERSON, organization: { name: 'Totally Different Co', primary_domain: 'different.example' } }
  const r = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(apolloWith([other]), async () => ok(wrong), calls), master })
  assert.deepEqual(attached(db), []); assert.equal(r.attached, 0); assert.ok(calls.pdl === 1, 'PDL was tried after Apollo yielded nothing usable')
})

test('a bad Apollo key opens only Apollo: later leads skip it visibly and still use PDL; the pass does not end', async () => {
  const { db, jobId, leads } = seed(2); const calls: Calls = { apollo: 0, pdl: 0 }
  const r = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(async () => new Response('no', { status: 401 }), async () => ok(PDL_OK), calls), master })
  assert.equal(calls.apollo, 1, 'one failed attempt, then the circuit is open'); assert.equal(calls.pdl, 2)
  assert.deepEqual(r.skipped.filter(s => s.provider === 'apollo').map(s => s.why), ['circuit_open'])
  assert.ok(statuses(db).includes('apollo:circuit_open') && statuses(db).includes('apollo:auth'))
  assert.deepEqual(attached(db, 'lead2'), ['enrich:pdl:Pdl Person - Practice Manager'], 'the second lead (no domain) takes PDL\'s record because its employer place agrees with the scan geography')
})

test('repeated transient failures open the circuit after MAX_FAILS; exhausted budget is a visible skip, not silent', async () => {
  const { db, jobId, leads } = seed(5); const calls: Calls = { apollo: 0, pdl: 0 }
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(async () => new Response('slow', { status: 429 }), async () => ok({ data: [] }), calls), master })
  assert.equal(calls.apollo, 4, `lead 1 costs an org + a people call, leads 2 and 3 one failed org call each; the circuit opens at ${MAX_FAILS} failures and leads 4-5 are skipped`); assert.ok(statuses(db).includes('apollo:circuit_open'))
  assert.ok(APOLLO_CALLS >= 1 && PDL_CALLS >= 1)
})

test('a replayed job does not pay again: a lookup this job already made is skipped (found -> stop, empty -> next provider)', async () => {
  const { db, jobId, leads } = seed(); const calls: Calls = { apollo: 0, pdl: 0 }
  const f = router(apolloWith([]), async () => ok(PDL_OK), calls)
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: f, master })
  assert.deepEqual([calls.apollo > 0, calls.pdl], [true, 1]); const before = { ...calls }
  const again = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: f, master })
  assert.deepEqual(calls, before, 'no provider call at all on the replay'); assert.deepEqual(again.skipped.map(s => `${s.provider}:${s.why}`), ['apollo:replayed', 'pdl:replayed'])
  assert.equal(attached(db).length, 1, 'no duplicate rows')
})

test('an exhausted per-tenant budget skips visibly (an audit row), the other provider still runs, and nothing is silently dropped', async () => {
  const { db, jobId, leads } = seed(3); const calls: Calls = { apollo: 0, pdl: 0 }
  const r = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(apolloWith([]), async () => ok(PDL_OK), calls), master, budget: { apollo: 1, pdl: 2 } })
  assert.equal(calls.pdl, 2, 'PDL stops at its own budget'); assert.ok(r.skipped.some(s => s.provider === 'apollo' && s.why === 'budget_exhausted') && r.skipped.some(s => s.provider === 'pdl' && s.why === 'budget_exhausted'))
  assert.ok(statuses(db).includes('apollo:budget_exhausted') && statuses(db).includes('pdl:budget_exhausted'))
})

test('both providers dead (auth): every lead carries an audited reason, circuits open per provider, nothing is silently dropped', async () => {
  const { db, jobId, leads } = seed(3); const calls: Calls = { apollo: 0, pdl: 0 }
  const denied = async () => new Response('no', { status: 401 })
  const r = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(denied, denied, calls), master })
  assert.equal(calls.apollo, 1); assert.equal(calls.pdl, 1, 'each provider billed once, then circuit open')
  assert.deepEqual(attached(db), [])
  assert.equal(r.skipped.filter(s => s.why === 'circuit_open' && s.provider === 'apollo').length, 2)
  assert.equal(r.skipped.filter(s => s.why === 'circuit_open' && s.provider === 'pdl').length, 2)
  const st = statuses(db)
  assert.ok(st.includes('apollo:auth') && st.includes('pdl:auth'), JSON.stringify(st))
  assert.ok(st.includes('apollo:circuit_open') && st.includes('pdl:circuit_open'), JSON.stringify(st))
})

test('a one-off transport failure does NOT open the circuit: the next lead still uses Apollo', async () => {
  const { db, jobId, leads } = seed(2); const calls: Calls = { apollo: 0, pdl: 0 }
  let orgCalls = 0
  const flaky = async (u: string) => {
    if (u.includes('organizations/enrich')) { orgCalls++; if (orgCalls === 1) throw new DOMException('aborted', 'AbortError') }
    return ok({ people: [] })
  }
  const r = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(flaky, async () => ok(PDL_OK), calls), master })
  assert.equal(orgCalls, 2, 'Apollo retried for lead 2: one abort is transient, not a dead key')
  assert.equal(r.skipped.filter(s => s.why === 'circuit_open').length, 0)
})

test('default OFF: both keys saved without the opt-in never touch PDL (the old "Apollo only" contract)', async () => {
  const { db, jobId, leads } = seed(1, false); saveCredential(db, 'u1', 'enrich:pdl', 'test-pdl-key-5678', master)
  assert.equal(enrichFallbackEnabled(db, 'u1'), false)
  const calls: Calls = { apollo: 0, pdl: 0 }
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(async (u: string) => (u.includes('organizations') ? ok({ organization: { name: 'Harbor Dental', website_url: 'https://harbordental.example', city: 'New York', state: 'New York', country: 'United States' } }) : ok({ people: [] })), async () => ok(PDL_OK), calls), master })
  assert.ok(calls.apollo > 0); assert.equal(calls.pdl, 0) // no opt-in -> no PDL call, no credit
})
test('opt-in toggle: enabling then disabling the flag controls the fallback exactly', async () => {
  const { db } = seed(1, false)
  assert.equal(enrichFallbackEnabled(db, 'u1'), false)
  setEnrichFallback(db, 'u1', true); assert.equal(enrichFallbackEnabled(db, 'u1'), true)
  setEnrichFallback(db, 'u1', false); assert.equal(enrichFallbackEnabled(db, 'u1'), false)
})

test('tenant isolation: one tenant opting in never enables another tenant\'s fallback', async () => {
  const a = seed(1, true) // opted in
  const b = seed(1, false); saveCredential(b.db, 'u1', 'enrich:pdl', 'test-pdl-key-5678', master) // both keys, NO opt-in
  setEnrichFallback(a.db, 'u1', true)
  assert.equal(enrichFallbackEnabled(a.db, 'u1'), true)
  assert.equal(enrichFallbackEnabled(b.db, 'u1'), false)
  const calls: Calls = { apollo: 0, pdl: 0 }
  await enrichLeadContacts(b.db, 'u1', b.jobId, b.leads, { fetchImpl: router(async (u: string) => (u.includes('organizations') ? ok({ organization: { name: 'Harbor Dental', website_url: 'https://harbordental.example', city: 'New York', state: 'New York', country: 'United States' } }) : ok({ people: [] })), async () => ok(PDL_OK), calls), master })
  assert.equal(calls.pdl, 0, 'a tenant without its own opt-in never spends PDL credits')
})
test('disabled provider: opt-in does not resurrect a disabled PDL key', async () => {
  const { db, jobId, leads } = seed()
  const { setEnabled } = await import('../lib/connectors/store.ts')
  const { sqliteDb } = await import('../lib/db/client.ts')
  assert.equal(await setEnabled(sqliteDb(db), 'u1', 'enrich:pdl', false), true)
  assert.equal(enrichFallbackEnabled(db, 'u1'), true) // the flag is on...
  const calls: Calls = { apollo: 0, pdl: 0 }
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(async (u: string) => (u.includes('organizations') ? ok({ organization: { name: 'Harbor Dental', website_url: 'https://harbordental.example', city: 'New York', state: 'New York', country: 'United States' } }) : ok({ people: [] })), async () => ok(PDL_OK), calls), master })
  assert.equal(calls.pdl, 0, '...but a disabled PDL key is never used')
})

test('PDL credit truth: the scan budget caps PROFILES RETURNED, and each search size is capped by what remains', async () => {
  const { db, jobId, leads } = seed(2, true)
  const sizes: number[] = []
  const pdlProfiles = (n: number) => ({ data: Array.from({ length: n }, () => PDL_OK.data[0]) })
  const capRouter = (async (u: RequestInfo | URL, init?: { body?: string }) => {
    const s2 = String(u)
    if (s2.includes('apollo.io')) return s2.includes('organizations') ? ok({ organization: { name: 'X', website_url: 'https://harbordental.example', city: 'New York', state: 'New York', country: 'United States' } }) : ok({ people: [] })
    sizes.push(JSON.parse(init?.body ?? '{}').size ?? 0)
    return ok(pdlProfiles(4))
  }) as unknown as typeof fetch
  const r = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: capRouter, master })
  assert.deepEqual(sizes, [5, 1], 'the first search may request the full budget; the second is capped by what 4 returned profiles left')
  // Charged = profiles RETURNED (adapter contract): 4 + min(4, size 1) = 5, never more than the budget.
  const charged = (db.prepare("SELECT results FROM connector_audit WHERE tenant_id = 'u1' AND connector = 'enrich:pdl' AND status = 'ok'").all() as { results: number }[]).reduce((a, r) => a + r.results, 0)
  assert.equal(charged, 5, 'profiles returned across the scan never exceed the 5-credit budget')
  assert.ok(r.byProvider.pdl > 0)
})
test('terminal rejection is a replay class of its own: a fully-contradicted search is never paid for twice', async () => {
  const { db, jobId, leads } = seed()
  const calls: Calls = { apollo: 0, pdl: 0 }
  const contradicting = async (u: string) => u.includes('organizations') ? ok({ organization: { name: 'Harbor Dental', website_url: 'https://harbordental.example', city: 'New York', state: 'New York', country: 'United States' } }) : ok({ people: [{ ...PERSON, organization: { name: 'Different Co', primary_domain: 'different.example' } }] })
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(contradicting, async () => ok(PDL_OK), calls), master })
  const apolloAfterFirst = calls.apollo
  assert.ok(apolloAfterFirst > 0)
  const r2 = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(contradicting, async () => ok(PDL_OK), calls), master })
  assert.equal(calls.apollo, apolloAfterFirst, 'the replayed rejection costs nothing')
  assert.ok(r2.skipped.some(s2 => s2.provider === 'apollo' && s2.why === 'replayed'), 'rejection replays as replayed, not a re-pay')
})
test('a stale reserved row (crashed pass) fails closed: no second payment, no downstream provider, reported uncertain', async () => {
  const { db, jobId, leads } = seed()
  db.prepare("INSERT INTO connector_audit (id, tenant_id, connector, scan_job_id, lookup, status, results) VALUES ('r1', 'u1', 'enrich:apollo', ?, ?, 'reserved', 0)").run(jobId, 'people Harbor Dental (harbordental.example)')
  const calls: Calls = { apollo: 0, pdl: 0 }
  const r = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(async () => ok({ people: [PERSON] }), async () => ok(PDL_OK), calls), master })
  assert.equal(calls.apollo, 0, 'the possibly-paid call is never repeated')
  assert.equal(calls.pdl, 0, 'unknown paid state stops the waterfall for the lead')
  assert.ok(r.skipped.some(s2 => s2.why === 'uncertain'), 'the pass reports the lead uncertain')
})
test('same-name leads with no domain never share a memo: each is searched, neither silences the other', async () => {
  const db2 = new Database(':memory:'); migrateScan(db2); migrateConnectors(db2)
  const jobId = createJob(db2, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db2.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(NYC, jobId)
  const leads = [1, 2].map(i => ({ id: `lead${i}`, company: 'Harbor Dental', company_domain: null as string | null }))
  for (const l of leads) db2.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES (?, ?, '', ?, NULL, 'opened', 'https://x.example/1')").run(l.id, jobId, l.company)
  saveCredential(db2, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  const calls: Calls = { apollo: 0, pdl: 0 }
  const apollo = async (u: string) => u.includes('organizations') ? ok({ organization: { name: 'Harbor Dental', website_url: 'https://harbordental.example', city: 'New York', state: 'New York', country: 'United States' } }) : ok({ people: [PERSON] })
  await enrichLeadContacts(db2, 'u1', jobId, leads, { fetchImpl: router(apollo, async () => ok(PDL_OK), calls), master })
  assert.ok(calls.apollo >= 4, `both leads searched (org+people each), got ${calls.apollo}`)
  const keys = (db2.prepare("SELECT DISTINCT lookup FROM connector_audit WHERE tenant_id = 'u1' AND connector = 'enrich:apollo' AND lookup LIKE 'step:people %'").all() as { lookup: string }[]).map(r => r.lookup)
  assert.ok(keys.some(k => k.includes('lead:lead1')) && keys.some(k => k.includes('lead:lead2')), 'each no-domain lead has its own durable identity')
})

test('a double-run (stale lease reap / concurrent caller) never pays twice: the loser reads the winner, makes 0 provider calls', async () => {
  const { db, jobId, leads } = seed(1)
  const aCalls: Calls = { apollo: 0, pdl: 0 }
  const bCalls: Calls = { apollo: 0, pdl: 0 }
  // Worker A claims the atomic reservation and stalls INSIDE the org call; the reaper's worker B runs the same job.
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const aApollo = async (u: string) => { if (u.includes('organizations')) await gate; return apolloWith([PERSON])(u) }
  const A = enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(aApollo, async () => ok(PDL_OK), aCalls), master })
  await new Promise(r => setTimeout(r, 20)) // A is parked mid-org-call with its reservation durable
  const rb = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(apolloWith([PERSON]), async () => ok(PDL_OK), bCalls), master })
  assert.equal(bCalls.apollo, 0, 'the double-run never repeats a possibly-paid call')
  assert.equal(bCalls.pdl, 0, 'uncertain stops the waterfall for the lead')
  assert.ok(rb.skipped.some(x => x.why === 'uncertain'), 'the second worker reports the lead uncertain')
  release()
  const ra = await A
  assert.equal(aCalls.apollo, 2, 'the winner pays exactly once: org + people')
  assert.equal(ra.attached, 1)
})

test('setup failures refuse explicitly: no master key = no calls, an audited refusal, never a silent swallow', async () => {
  const { db, jobId, leads } = seed(1)
  const calls: Calls = { apollo: 0, pdl: 0 }
  const saved = process.env.DAZL_MASTER_KEY; delete process.env.DAZL_MASTER_KEY
  try {
    const r = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(apolloWith([PERSON]), async () => ok(PDL_OK), calls) }) // no deps.master: needs the env key
    assert.equal(calls.apollo + calls.pdl, 0, 'no paid call without a readable setup')
    assert.equal(r.attached, 0)
    const rows = db.prepare("SELECT status FROM connector_audit WHERE tenant_id = 'u1' AND connector = 'enrich'").all() as { status: string }[]
    assert.ok(rows.some(x => x.status.startsWith('setup failed')), 'the refusal is on the durable record')
  } finally { if (saved !== undefined) process.env.DAZL_MASTER_KEY = saved }
})

test('one unreadable key refuses THAT provider only: audited, the healthy provider still runs', async () => {
  const { db, jobId, leads } = seed(1) // both keys saved + fallback opted in
  db.prepare("UPDATE tenant_connectors SET ciphertext = 'corrupt-not-json' WHERE tenant_id = 'u1' AND connector = 'enrich:apollo'").run()
  const calls: Calls = { apollo: 0, pdl: 0 }
  const r = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(apolloWith([PERSON]), async () => ok(PDL_OK), calls), master })
  assert.equal(calls.apollo, 0, 'the unreadable key is never used')
  assert.equal(calls.pdl, 1, 'a healthy provider still runs')
  assert.equal(r.attached, 1)
  const rows = db.prepare("SELECT status FROM connector_audit WHERE tenant_id = 'u1' AND connector = 'enrich:apollo' AND lookup = 'key load'").all() as { status: string }[]
  assert.ok(rows.some(x => x.status.startsWith('setup unreadable')), 'the refusal is audited on the provider')
})

test('a TRANSIENT outcome HOLDS the claim: even a received 429 is never assumed free on an unverifiable plan', async () => {
  const { db, jobId, leads } = seed(1, false) // Apollo only
  const calls: Calls = { apollo: 0, pdl: 0 }
  const flaky = async () => new Response('slow', { status: 429 }) // the WHOLE attempt is rate-limited (org and people)
  const r1 = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(flaky, async () => ok(PDL_OK), calls), master })
  assert.equal(r1.attached, 0, 'the rate-limited pass attaches nothing')
  const claims1 = db.prepare("SELECT status FROM connector_claims WHERE tenant_id = 'u1' ORDER BY claimed_at").all() as { status: string }[]
  assert.deepEqual(claims1.map(c => c.status), ['reserved', 'reserved'], 'per-step holds, no automatic release: a plan that bills errored requests would make any release a rebill (org claim + people claim)')
  const after1 = { ...calls }
  const r2 = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(apolloWith([PERSON]), async () => ok(PDL_OK), calls), master })
  assert.equal(r2.attached, 0, 'a held lead is not retried automatically (recovery is the tracked per-step follow-up)')
  assert.ok(r2.skipped.some(x => x.why === 'uncertain'), 'the replay reports the lead uncertain (held for review)')
  assert.deepEqual(calls, after1, 'ZERO new provider calls for the held lead')
})

test('an UNCERTAIN paid attempt (timeout/abort after the request left) stays held: the replay never re-bills, reports uncertain', async () => {
  const { db, jobId, leads } = seed(1, false) // Apollo only
  const calls: Calls = { apollo: 0, pdl: 0 }
  const aborting = async () => { throw new DOMException('aborted', 'AbortError') }
  const r1 = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(aborting, async () => ok(PDL_OK), calls), master })
  assert.equal(r1.attached, 0)
  const claims1 = db.prepare("SELECT status FROM connector_claims WHERE tenant_id = 'u1' ORDER BY claimed_at").all() as { status: string }[]
  assert.deepEqual(claims1.map(c => c.status), ['reserved', 'reserved'], 'a possibly-charged attempt keeps its claims (org step + people step)')
  const r2 = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(apolloWith([PERSON]), async () => ok(PDL_OK), calls), master })
  const callsAfter = { ...calls }
  assert.equal(r2.attached, 0, 'the held lead is never re-billed automatically')
  assert.ok(r2.skipped.some(x => x.why === 'uncertain'), 'the replay reports the lead uncertain (held for review)')
  assert.equal(callsAfter.apollo, calls.apollo, 'no new provider call for the held lead')
})

test('a CHARGED sub-step survives a later transient: org 200 then people 429 keeps the claim held - the replay re-bills NOTHING', async () => {
  const { db, jobId, leads } = seed(1, false) // Apollo only
  const calls: Calls = { apollo: 0, pdl: 0 }
  // org enrich succeeds (a credit is spent: data was returned), then the people search is rate-limited
  const orgThenPeople429 = async (url: string) =>
    String(url).includes('organizations/enrich')
      ? ok({ organization: { name: 'Harbor Dental', website_url: 'https://harbordental.example', city: 'New York', state: 'New York', country: 'United States' } })
      : new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 })
  const r1 = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(orgThenPeople429, async () => ok(PDL_OK), calls), master })
  assert.equal(r1.attached, 0)
  assert.ok(calls.apollo >= 2, 'both sub-steps ran (org charged, people refused)')
  // The recovery contract: the PAID org step settles terminal WITH its memo (the org credit bought durable data);
  // only the 0-credit people step stays held - and a held step is never released automatically.
  const claims1 = db.prepare("SELECT status, memo FROM connector_claims WHERE tenant_id = 'u1' ORDER BY claimed_at").all() as { status: string; memo: string | null }[]
  assert.deepEqual(claims1.map(c => c.status), ['ok', 'reserved'], 'org paid+terminal with memo; people held - never a blind retry')
  const memo = JSON.parse(claims1[0].memo ?? 'null') as { v: number; domain: string } | null
  assert.equal(memo?.v, 1, 'the org claim carries its resume memo')
  assert.equal(memo?.domain, 'harbordental.example', 'the memo names the confirmed domain the people step queries')
  const r2 = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(apolloWith([PERSON]), async () => ok(PDL_OK), calls), master })
  assert.equal(r2.attached, 0, 'held for review: no automatic re-attempt of a partially-charged lead')
  assert.ok(r2.skipped.some(x => x.why === 'uncertain'), 'the replay reports the lead uncertain')
  assert.equal(calls.apollo, 2, 'ZERO additional org (or people) calls - the org credit is never re-billed, the held people step is owner-only')
})

test('RECOVERY: org paid then the pass died BEFORE the people call - the replay runs ONLY the free people search (memo resume)', async () => {
  const { db, jobId, leads } = seed(1, false) // Apollo only
  // Simulate the crashed pass's durable state exactly: org claim settled 'ok' WITH its memo, people never claimed.
  const { auditTryReserve, auditSettleClaim } = await import('../lib/connectors/store.ts')
  const orgKey = 'step:org Harbor Dental (harbordental.example)'
  const g = auditTryReserve(db, { tenantId: 'u1', connector: 'enrich:apollo', jobId, lookup: orgKey, status: 'reserved', results: 0 })
  assert.ok('id' in g)
  const memo = { v: 1, website: 'https://harbordental.example', domain: 'harbordental.example', name: 'Harbor Dental', place: null, address: null, established: true, keyedOnLeadDomain: true }
  auditSettleClaim(db, { tenantId: 'u1', connector: 'enrich:apollo', jobId, lookup: orgKey, status: 'ok', results: 1 }, (g as { id: string }).id, 'ok', 1, JSON.stringify(memo))
  const calls: Calls = { apollo: 0, pdl: 0 }
  const r = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(apolloWith([PERSON]), async () => ok(PDL_OK), calls), master })
  assert.equal(calls.apollo, 1, 'ONLY the 0-credit people search runs - the org credit is never re-spent')
  assert.deepEqual(attached(db), ['enrich:apollo:Invented Manager - Practice Manager'])
  assert.equal(r.attached, 1)
  const orgCalls = db.prepare("SELECT status FROM connector_audit WHERE tenant_id = 'u1' AND lookup LIKE 'step:org %' AND status = 'reserved'").all()
  assert.equal(orgCalls.length, 0, 'no second org attempt was even reserved')
})

test('RECOVERY: the memo identity is the NORMALIZED domain actually requested (case/www-insensitive), never a raw string', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(NYC, jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('lead1', ?, '', 'Harbor Dental', 'WWW.HarborDental.EXAMPLE', 'opened', 'https://x.example/1')").run(jobId)
  saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  const seen: string[] = []
  const apolloRaw = apolloWith([PERSON])
  const apollo = async (u: string) => apolloRaw(u)
  const capturing = (async (u: RequestInfo | URL, init?: RequestInit) => { seen.push(String(init?.body ?? u)); return apollo(String(u)) }) as typeof fetch
  await enrichLeadContacts(db, 'u1', jobId, [{ id: 'lead1', company: 'Harbor Dental', company_domain: 'WWW.HarborDental.EXAMPLE' }], { fetchImpl: capturing, master })
  assert.ok(seen[0]?.includes('harbordental.example') && !seen[0]?.includes('WWW.'), 'the provider request body uses the normalized domain')
  const claims = db.prepare("SELECT lookup FROM connector_claims WHERE tenant_id = 'u1' ORDER BY claimed_at").all() as { lookup: string }[]
  assert.deepEqual(claims.map(c => c.lookup), ['step:org Harbor Dental (harbordental.example)', 'step:people Harbor Dental (harbordental.example)'], 'the claim names the exact domain the request sent')
})

test('RECOVERY: a HELD people claim is owner-only - no automatic release even though the endpoint is 0-credit', async () => {
  const { db, jobId, leads } = seed(1, false)
  const { auditTryReserve } = await import('../lib/connectors/store.ts')
  const g = auditTryReserve(db, { tenantId: 'u1', connector: 'enrich:apollo', jobId, lookup: 'step:people Harbor Dental (harbordental.example)', status: 'reserved', results: 0 })
  assert.ok('id' in g) // reserved, never settled: the people call's outcome is UNKNOWN
  const calls: Calls = { apollo: 0, pdl: 0 }
  const r = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(apolloWith([PERSON]), async () => ok(PDL_OK), calls), master })
  assert.equal(calls.apollo, 0, 'the held people claim stops the attempt BEFORE the paid org call')
  assert.ok(r.skipped.some(x => x.why === 'uncertain'), 'reported uncertain, held for owner review')
})

test('OWNER RETRY: org paid + people held -> the owner action releases ONLY the held claim and resumes on the memo (org never re-charged)', async () => {
  const { db, jobId, leads } = seed(1, false) // Apollo only
  const { auditTryReserve, auditSettleClaim } = await import('../lib/connectors/store.ts')
  const { claimKeysFor, heldEnrichments, retryHeldEnrichment, heldCostText } = await import('../lib/enrich/index.ts')
  const k = claimKeysFor(leads[0])
  const g1 = auditTryReserve(db, { tenantId: 'u1', connector: 'enrich:apollo', jobId, lookup: k.stepOrg, status: 'reserved', results: 0 })
  const memo = { v: 1, website: 'https://harbordental.example', domain: 'harbordental.example', name: 'Harbor Dental', place: null, address: null, established: true, keyedOnLeadDomain: true }
  auditSettleClaim(db, { tenantId: 'u1', connector: 'enrich:apollo', jobId, lookup: k.stepOrg, status: 'ok', results: 1 }, (g1 as { id: string }).id, 'ok', 1, JSON.stringify(memo))
  const g2 = auditTryReserve(db, { tenantId: 'u1', connector: 'enrich:apollo', jobId, lookup: k.stepPeople, status: 'reserved', results: 0 })
  assert.ok('id' in g2) // a received 429: never settled
  db.prepare("UPDATE connector_claims SET claimed_at = 0 WHERE lookup = ?").run(k.stepPeople) // old enough to be held, not live
  const held = heldEnrichments(db, 'u1')
  assert.deepEqual(held.map(h => `${h.provider}:${h.step}`), ['apollo:people'], 'the held people step surfaces for the owner')
  assert.match(heldCostText(held[0]), /0-credit/, 'the owner sees the free-endpoint cost wording')
  const calls: Calls = { apollo: 0, pdl: 0 }
  const r = await retryHeldEnrichment(db, 'u1', 'lead1', { provider: 'apollo', step: 'people' }, { fetchImpl: router(apolloWith([PERSON]), async () => ok(PDL_OK), calls), master })
  assert.deepEqual(r, { status: 'retried', attached: 1, releases: ['apollo people'] })
  assert.equal(calls.apollo, 1, 'ONLY the people search re-runs: the org credit is never re-spent')
  assert.deepEqual(attached(db), ['enrich:apollo:Invented Manager - Practice Manager'])
  const rel = db.prepare("SELECT status FROM connector_audit WHERE tenant_id = 'u1' AND status LIKE 'owner released%'").all()
  assert.equal(rel.length, 1, 'the release is on the durable audit record')
})

test('OWNER RETRY: a LEGACY whole-attempt hold releases with the may-repay disclosure and re-runs the full attempt', async () => {
  const { db, jobId, leads } = seed(1, false)
  const { auditTryReserve } = await import('../lib/connectors/store.ts')
  const { claimKeysFor, heldEnrichments, retryHeldEnrichment, heldCostText } = await import('../lib/enrich/index.ts')
  const k = claimKeysFor(leads[0])
  const g = auditTryReserve(db, { tenantId: 'u1', connector: 'enrich:apollo', jobId, lookup: k.legacyPeople, status: 'reserved', results: 0 })
  assert.ok('id' in g)
  db.prepare("UPDATE connector_claims SET claimed_at = 0").run()
  const held = heldEnrichments(db, 'u1')
  assert.deepEqual(held.map(h => h.step), ['legacy'])
  assert.match(heldCostText(held[0]), /1 Apollo credit/, 'the old row cannot prove its outcome: the possible re-charge is disclosed')
  const calls: Calls = { apollo: 0, pdl: 0 }
  const r = await retryHeldEnrichment(db, 'u1', 'lead1', { provider: 'apollo', step: 'legacy' }, { fetchImpl: router(apolloWith([PERSON]), async () => ok(PDL_OK), calls), master })
  assert.deepEqual(r, { status: 'retried', attached: 1, releases: ['apollo legacy'] })
  assert.equal(calls.apollo, 2, 'the full attempt re-runs (org + people): the disclosed possible re-charge')
})

test('OWNER RETRY: a FRESH claim (a live pass may be in flight) is never released', async () => {
  const { db, jobId, leads } = seed(1, false)
  const { auditTryReserve } = await import('../lib/connectors/store.ts')
  const { claimKeysFor, heldEnrichments, retryHeldEnrichment } = await import('../lib/enrich/index.ts')
  const k = claimKeysFor(leads[0])
  const g = auditTryReserve(db, { tenantId: 'u1', connector: 'enrich:apollo', jobId, lookup: k.stepOrg, status: 'reserved', results: 0 })
  assert.ok('id' in g) // claimed_at = now: possibly a LIVE call
  assert.deepEqual(heldEnrichments(db, 'u1'), [], 'too fresh to call held')
  const r = await retryHeldEnrichment(db, 'u1', 'lead1', { provider: 'apollo', step: 'org' }, { fetchImpl: router(apolloWith([PERSON]), async () => ok(PDL_OK), { apollo: 0, pdl: 0 }), master })
  assert.deepEqual(r, { status: 'nothing_held' })
  const still = db.prepare("SELECT status FROM connector_claims WHERE tenant_id = 'u1'").all() as { status: string }[]
  assert.deepEqual(still.map(x => x.status), ['reserved'], 'the live claim was NOT touched')
})

test('CRASH REGRESSION: org ok + rejection-verdict memo, people never settled -> the replay resumes the verdict with ZERO calls', async () => {
  const { db, jobId, leads } = seed(1, false) // Apollo only
  const { auditTryReserve, auditSettleClaim } = await import('../lib/connectors/store.ts')
  const { claimKeysFor } = await import('../lib/enrich/index.ts')
  const k = claimKeysFor(leads[0])
  const g = auditTryReserve(db, { tenantId: 'u1', connector: 'enrich:apollo', jobId, lookup: k.stepOrg, status: 'reserved', results: 0 })
  const verdict = { v: 1, website: 'https://wrongco.example', domain: 'wrongco.example', name: 'Wrong Co', place: null, address: null, established: true, keyedOnLeadDomain: true, rejected: 'contact rejected: organization mismatch Wrong Co vs Harbor Dental' }
  auditSettleClaim(db, { tenantId: 'u1', connector: 'enrich:apollo', jobId, lookup: k.stepOrg, status: 'ok', results: 1 }, (g as { id: string }).id, 'ok', 1, JSON.stringify(verdict))
  // the crash: no people claim, no refusal card - the exact hole the reviewer named
  const calls: Calls = { apollo: 0, pdl: 0 }
  const r = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(apolloWith([PERSON]), async () => ok(PDL_OK), calls), master })
  assert.equal(calls.apollo, 0, 'the verdict resumes from the memo: no provider call, no possible re-charge')
  assert.ok(r.skipped.some(x => x.provider === 'apollo' && x.why === 'replayed'))
  const people = db.prepare('SELECT status FROM connector_claims WHERE lookup = ?').get(k.stepPeople) as { status: string }
  assert.equal(people.status, 'rejected', 'the people verdict settles durably')
  const cards = enrichmentsForLeads(db, 'u1', ['lead1']).lead1 ?? []
  assert.ok(cards.some(e => e.kind === 'contact_rejected' && /organization mismatch/.test(e.value)), 'the refusal card is written')
  const calls2: Calls = { apollo: 0, pdl: 0 }
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(apolloWith([PERSON]), async () => ok(PDL_OK), calls2), master })
  assert.equal(calls2.apollo, 0, 'a second replay converges: still zero calls')
  assert.equal((enrichmentsForLeads(db, 'u1', ['lead1']).lead1 ?? []).filter(e => e.kind === 'contact_rejected').length, 1, 'idempotent: exactly one refusal card')
})

test('CRASH REGRESSION: terminal rejected people claim without its refusal card -> the replay repairs the card with zero calls', async () => {
  const { db, jobId, leads } = seed(1, false)
  const { auditTryReserve, auditSettleClaim } = await import('../lib/connectors/store.ts')
  const { claimKeysFor } = await import('../lib/enrich/index.ts')
  const k = claimKeysFor(leads[0])
  const g = auditTryReserve(db, { tenantId: 'u1', connector: 'enrich:apollo', jobId, lookup: k.stepPeople, status: 'reserved', results: 0 })
  auditSettleClaim(db, { tenantId: 'u1', connector: 'enrich:apollo', jobId, lookup: k.stepPeople, status: 'contact rejected: organization mismatch Wrong Co vs Harbor Dental', results: 0 }, (g as { id: string }).id, 'contact rejected: organization mismatch Wrong Co vs Harbor Dental', 0)
  // the crash: the claim is terminal but the card write never happened - the card would be invisible forever
  const calls: Calls = { apollo: 0, pdl: 0 }
  const r = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(apolloWith([PERSON]), async () => ok(PDL_OK), calls), master })
  assert.equal(calls.apollo, 0, 'repair is free: no provider call')
  assert.ok(r.skipped.some(x => x.why === 'replayed'))
  assert.ok((enrichmentsForLeads(db, 'u1', ['lead1']).lead1 ?? []).some(e => e.kind === 'contact_rejected' && /organization mismatch/.test(e.value)), 'the missing refusal card self-heals on replay')
})

test('OWNER RETRY SCOPE: releasing one held claim never releases or runs the other provider', async () => {
  const { db, jobId, leads } = seed(1, true) // both providers configured
  const { auditTryReserve, auditSettleClaim } = await import('../lib/connectors/store.ts')
  const { claimKeysFor, retryHeldEnrichment, heldEnrichments } = await import('../lib/enrich/index.ts')
  const k = claimKeysFor(leads[0])
  const g1 = auditTryReserve(db, { tenantId: 'u1', connector: 'enrich:apollo', jobId, lookup: k.stepOrg, status: 'reserved', results: 0 })
  const memo = { v: 1, website: 'https://harbordental.example', domain: 'harbordental.example', name: 'Harbor Dental', place: null, address: null, established: true, keyedOnLeadDomain: true }
  auditSettleClaim(db, { tenantId: 'u1', connector: 'enrich:apollo', jobId, lookup: k.stepOrg, status: 'ok', results: 1 }, (g1 as { id: string }).id, 'ok', 1, JSON.stringify(memo))
  auditTryReserve(db, { tenantId: 'u1', connector: 'enrich:apollo', jobId, lookup: k.stepPeople, status: 'reserved', results: 0 })
  auditTryReserve(db, { tenantId: 'u1', connector: 'enrich:pdl', jobId, lookup: k.legacyPeople, status: 'reserved', results: 0 })
  db.prepare('UPDATE connector_claims SET claimed_at = 0').run()
  assert.equal(heldEnrichments(db, 'u1').length, 2, 'the lead holds one apollo step and one pdl attempt')
  const calls: Calls = { apollo: 0, pdl: 0 }
  const r = await retryHeldEnrichment(db, 'u1', 'lead1', { provider: 'apollo', step: 'people' }, { fetchImpl: router(async () => ok({ people: [] }), async () => ok(PDL_OK), calls), master })
  assert.deepEqual(r, { status: 'retried', attached: 0, releases: ['apollo people'] })
  assert.equal(calls.apollo, 1, 'only the selected apollo people step re-ran')
  assert.equal(calls.pdl, 0, 'PDL was neither released nor run by the apollo action')
  const pdl = db.prepare("SELECT status FROM connector_claims WHERE connector = 'enrich:pdl'").get() as { status: string }
  assert.equal(pdl.status, 'reserved', 'the PDL claim stays held for its own owner action')
})

test('OWNER RETRY SAFETY: a terminal memo claim refuses release, and a release keeps the full audit lineage', async () => {
  const { db, jobId, leads } = seed(1, false)
  const { auditTryReserve, auditSettleClaim, releaseHeldClaim } = await import('../lib/connectors/store.ts')
  const { claimKeysFor } = await import('../lib/enrich/index.ts')
  const k = claimKeysFor(leads[0])
  const org = { tenantId: 'u1', connector: 'enrich:apollo', jobId, lookup: k.stepOrg, status: 'reserved', results: 0 }
  const g = auditTryReserve(db, org)
  const memo = { v: 1, website: null, domain: 'harbordental.example', name: 'Harbor Dental', place: null, address: null, established: true, keyedOnLeadDomain: true }
  auditSettleClaim(db, { ...org, status: 'ok', results: 1 }, (g as { id: string }).id, 'ok', 1, JSON.stringify(memo))
  assert.equal(releaseHeldClaim(db, { tenantId: 'u1', connector: 'enrich:apollo', jobId, lookup: k.stepOrg }, 'owner retry: test'), false, 'a settled paid outcome (incl. its memo) can never be released')
  const kept = db.prepare('SELECT status, memo FROM connector_claims WHERE lookup = ?').get(k.stepOrg) as { status: string; memo: string }
  assert.equal(kept.status, 'ok')
  assert.ok(kept.memo.includes('harbordental.example'), 'the memo survives untouched')
  assert.equal((db.prepare("SELECT count(*) n FROM connector_audit WHERE lookup = ? AND status LIKE 'owner released%'").get(k.stepOrg) as { n: number }).n, 0, 'no release audit row for a refused release')
  auditTryReserve(db, { tenantId: 'u1', connector: 'enrich:apollo', jobId, lookup: k.stepPeople, status: 'reserved', results: 0 })
  assert.equal(releaseHeldClaim(db, { tenantId: 'u1', connector: 'enrich:apollo', jobId, lookup: k.stepPeople }, 'owner retry: test'), true)
  const rows = db.prepare('SELECT status FROM connector_audit WHERE lookup = ? ORDER BY created_at, insert_seq').all(k.stepPeople) as { status: string }[]
  assert.equal(rows.length, 2, 'the original reservation and the release both survive on the audit record')
  assert.equal(rows[0].status, 'reserved')
  assert.match(rows[1].status, /^owner released held claim of \d{4}-\d{2}-\d{2}T.*: owner retry: test$/, 'the release names the released claim (lineage) and its disclosure')
})
