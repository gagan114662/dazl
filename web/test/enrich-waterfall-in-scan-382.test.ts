// #382 live-check failure (Hermes-PC, staging 223b3a4b): inside a real scan an Apollo 401 / 429 latched the scan's spend gate for
// EVERY vendor, so PDL was refused before it was called, the refusal was recorded as a generic PDL 'error' (and held as a
// possible charge), and the notice blamed PDL for "repeated failures". These legs run the waterfall INSIDE runWithScanSpend,
// as the scan runner does, with stubbed providers (invented company and people; no network, no credits).
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { enrichLeadContacts } from '../lib/enrich/index.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential, enrichmentsForLeads, setEnrichFallback, auditTryReserve, auditSettleClaim, auditReleaseUnsent } from '../lib/connectors/store.ts'
import { runWithScanSpend, reserveScanSpend, scanCapConfig, scanSpendCalls, spendAttemptRejected, spendVendorRejected } from '../lib/scan/spend-cap.ts'
import { setDb, asDb } from '../lib/db/client.ts'
import { providerIssues, providerIssueText } from '../lib/scan/provider-issues.ts'
import { paidEnrichmentOutcomes } from '../lib/scan/enrichment-trace.ts'

const master = randomBytes(32)
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
const NYC = JSON.stringify({ summary: 'NYC dental', where: ['New York City'], who: ['Practice manager'], signals: [] })
const PDL_OK = { data: [{ full_name: 'Pdl Person', job_title: 'Practice Manager', job_company_website: 'harbordental.example', job_company_location_locality: 'new york', job_company_location_region: 'new york', job_company_location_country: 'united states' }] }
type Calls = { apollo: number; pdl: number }

function seed(n = 1) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  setDb(asDb(db))
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', attempts = 1, icp = ? WHERE id = ?").run(NYC, jobId)
  const leads = Array.from({ length: n }, (_, i) => ({ id: `lead${i + 1}`, company: i === 0 ? 'Harbor Dental' : `Harbor Dental ${i + 1}`, company_domain: i === 0 ? 'harbordental.example' : null as string | null }))
  for (const l of leads) db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES (?, ?, '', ?, ?, 'opened', 'https://x.example/1')").run(l.id, jobId, l.company, l.company_domain)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(jobId) // post-finish, as the runner's enrichment pass
  saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  saveCredential(db, 'u1', 'enrich:pdl', 'test-pdl-key-5678', master); setEnrichFallback(db, 'u1', true)
  const ctx = { db, jobId, tenantId: 'u1', attempt: 1, cap: scanCapConfig({}) }
  return { db, jobId, leads, ctx }
}
const router = (apollo: () => Promise<Response>, pdl: () => Promise<Response>, calls: Calls) => (async (u: RequestInfo | URL) => { if (String(u).includes('apollo.io')) { calls.apollo++; return apollo() } calls.pdl++; return pdl() }) as typeof fetch
const attached = (db: Database.Database, id = 'lead1') => (enrichmentsForLeads(db, 'u1', [id])[id] ?? []).filter(e => e.kind === 'contact').map(e => `${e.connector}:${e.value}`)
const heldClaims = (db: Database.Database, connector: string) => (db.prepare("SELECT count(*) AS n FROM connector_claims WHERE tenant_id = 'u1' AND connector = ? AND status = 'reserved'").get(connector) as { n: number }).n

for (const [why, status] of [['401', 401], ['429', 429]] as const) {
  test(`#382 inside a scan: Apollo ${why} -> PDL is still called and its agreeing person attached; the scan's own later paid steps are not blocked`, async () => {
    const s = seed(); const calls: Calls = { apollo: 0, pdl: 0 }
    const out = await runWithScanSpend(s.ctx, async () => {
      const r = await enrichLeadContacts(s.db, 'u1', s.jobId, s.leads, { fetchImpl: router(async () => new Response('no', { status }), async () => ok(PDL_OK), calls), master })
      // The people search (TinyFish) and buyer fit (model) run after this pass on the same attempt: an Apollo refusal must not refuse them.
      const later = await reserveScanSpend('tinyfish.search', () => 0)
      await later?.settle(0)
      return { r, attemptRejected: spendAttemptRejected(), apolloRejected: spendVendorRejected('apollo'), later: !!later }
    })
    assert.equal(calls.pdl, 1, 'PDL was called after the Apollo rejection')
    assert.deepEqual(attached(s.db), ['enrich:pdl:Pdl Person - Practice Manager'])
    assert.deepEqual(out.r.outcomes.map(o => `${o.provider}:${o.outcome}`), [`apollo:${status === 401 ? 'auth' : 'rate_limited'}`, 'pdl:attached'])
    assert.equal(out.attemptRejected, null, 'an enrichment vendor rejection does not end the scan as provider_rejected')
    assert.equal(out.apolloRejected, status)
    assert.equal(out.later, true, 'a later TinyFish search of the same attempt is admitted')
    const kinds = (await scanSpendCalls(s.db, s.jobId, 'u1')).map(c => `${c.kind}:${c.status}`)
    assert.ok(kinds.includes('pdl.people:settled'), `PDL went through the scan ledger: ${JSON.stringify(kinds)}`)
  })
}

test('#382 inside a scan: a rate-limited Apollo is never called again in the attempt; later leads skip it with the real reason and still use PDL', async () => {
  const s = seed(2); const calls: Calls = { apollo: 0, pdl: 0 }
  const r = await runWithScanSpend(s.ctx, () => enrichLeadContacts(s.db, 'u1', s.jobId, s.leads, { fetchImpl: router(async () => new Response('slow', { status: 429 }), async () => ok(PDL_OK), calls), master }))
  assert.equal(calls.apollo, 1, 'one rejected request, never repeated')
  assert.equal(calls.pdl, 2, 'PDL answered for both leads')
  assert.deepEqual(r.outcomes.map(o => `${o.leadId}:${o.provider}:${o.outcome}`), ['lead1:apollo:rate_limited', 'lead1:pdl:attached', 'lead2:apollo:spend_refused', 'lead2:pdl:attached'])
  assert.equal(heldClaims(s.db, 'enrich:apollo') >= 1, true, 'the 429 itself stays held (a received rejection is never assumed free)')
  const texts = (await providerIssues('u1', s.jobId))!.map(providerIssueText)
  assert.ok(texts.includes('Apollo not tried for the remaining leads in this scan: it refused an earlier paid request in this scan (a rejected key or a rate limit), and dazl never sends it another request after a refusal. Nothing was sent to Apollo for those leads, so nothing was charged for them.'), JSON.stringify(texts))
  assert.ok(!texts.some(t => t.startsWith('People Data Labs')), `PDL did not fail and must not be blamed: ${JSON.stringify(texts)}`)
})

test('#382 a circuit opened by ONE rejected key says so, never "repeated failures"', async () => {
  const s = seed(2); const calls: Calls = { apollo: 0, pdl: 0 }
  const r = await runWithScanSpend(s.ctx, () => enrichLeadContacts(s.db, 'u1', s.jobId, s.leads, { fetchImpl: router(async () => new Response('no', { status: 401 }), async () => ok(PDL_OK), calls), master }))
  assert.deepEqual(r.skipped.filter(x => x.provider === 'apollo').map(x => x.why), ['key_rejected'])
  const texts = (await providerIssues('u1', s.jobId))!.map(providerIssueText)
  assert.ok(texts.includes('Apollo was skipped for the remaining leads in this scan after the saved key was rejected.'), JSON.stringify(texts))
  assert.ok(texts.includes('Apollo could not be used in this scan: the saved key was rejected. Check Settings > Enrichment.'))
  assert.ok(!texts.some(t => t.includes('repeated failures')), JSON.stringify(texts))
  assert.equal(calls.pdl, 2)
})

for (const [why, apollo] of [
  ['timeout', async () => { throw new DOMException('aborted', 'AbortError') }],
  ['5xx', async () => new Response('x', { status: 503 })],
] as [string, () => Promise<Response>][]) {
  test(`#382 inside a scan: Apollo ${why} (maybe billed) still stops paid calls, and PDL is reported "not tried" with that reason, its claim released`, async () => {
    const s = seed(); const calls: Calls = { apollo: 0, pdl: 0 }
    const r = await runWithScanSpend(s.ctx, () => enrichLeadContacts(s.db, 'u1', s.jobId, s.leads, { fetchImpl: router(apollo, async () => ok(PDL_OK), calls), master }))
    assert.equal(calls.pdl, 0, 'the uncertain = stop paying rule is kept')
    assert.deepEqual(r.outcomes.map(o => `${o.provider}:${o.outcome}`), [`apollo:${why === 'timeout' ? 'timeout' : 'upstream'}`, 'pdl:spend_refused'])
    assert.equal(heldClaims(s.db, 'enrich:pdl'), 0, 'a refused-before-sending PDL lookup is not held as a possible charge (no "Retry unavailable")')
    const pdlAudit = s.db.prepare("SELECT status FROM connector_audit WHERE connector = 'enrich:pdl' ORDER BY insert_seq").all() as { status: string }[]
    assert.ok(!pdlAudit.some(a => a.status === 'error'), `never recorded as a PDL failure: ${JSON.stringify(pdlAudit)}`)
    const texts = (await providerIssues('u1', s.jobId))!.map(providerIssueText)
    assert.ok(texts.includes('People Data Labs not tried for the remaining leads in this scan: an earlier paid request in this scan may have been billed without a confirmed cost (it timed out or the provider failed), so dazl made no further paid request in this scan. Nothing was sent to People Data Labs for those leads, so nothing was charged for them.'), JSON.stringify(texts))
  })
}

test('#382 a model / search provider rejection is still attempt-wide: no enrichment vendor is paid after it, and the notice names that cause', async () => {
  const s = seed(); const calls: Calls = { apollo: 0, pdl: 0 }
  const r = await runWithScanSpend(s.ctx, async () => {
    const h = await reserveScanSpend('tinyfish.search', () => 0); await h!.settle(null); h!.rejected(429)
    return { r: await enrichLeadContacts(s.db, 'u1', s.jobId, s.leads, { fetchImpl: router(async () => ok({}), async () => ok(PDL_OK), calls), master }), rejected: spendAttemptRejected() }
  })
  assert.equal(r.rejected, 429)
  assert.deepEqual([calls.apollo, calls.pdl], [0, 0])
  assert.deepEqual(r.r.outcomes.map(o => `${o.provider}:${o.outcome}`), ['apollo:spend_refused', 'pdl:spend_refused'])
  assert.equal(heldClaims(s.db, 'enrich:apollo') + heldClaims(s.db, 'enrich:pdl'), 0, 'nothing sent, nothing held')
  const texts = (await providerIssues('u1', s.jobId))!.map(providerIssueText)
  assert.ok(texts.some(t => t.startsWith("Apollo not tried for the remaining leads in this scan: the scan's AI or search provider refused an earlier request")), JSON.stringify(texts))
})

test('#382 a PDL rejection latches PDL only: Apollo keeps working for later leads', async () => {
  const s = seed(2); const calls: Calls = { apollo: 0, pdl: 0 }
  // Apollo: org found, people empty (so the waterfall falls to PDL); PDL: rejects its key.
  const apollo = (async (u: RequestInfo | URL) => { calls.apollo++; return String(u).includes('organizations') ? ok({ organization: { name: 'Harbor Dental', website_url: 'https://harbordental.example', city: 'New York', state: 'New York', country: 'United States' } }) : ok({ people: [] }) })
  const f = (async (u: RequestInfo | URL) => String(u).includes('apollo.io') ? apollo(u) : (calls.pdl++, new Response('no', { status: 401 }))) as typeof fetch
  await runWithScanSpend(s.ctx, () => enrichLeadContacts(s.db, 'u1', s.jobId, s.leads, { fetchImpl: f, master }))
  assert.equal(calls.pdl, 1)
  assert.ok(calls.apollo >= 3, `Apollo still ran for the second lead after PDL's rejection (${calls.apollo} calls)`)
})

test('#382 store: releasing an unsent lookup never removes a settled or memo-carrying claim', () => {
  const s = seed()
  const a = { tenantId: 'u1', connector: 'enrich:apollo', jobId: s.jobId, lookup: 'step:org Settled Co (settled.example)', status: 'reserved', results: 0 }
  const g = auditTryReserve(s.db, a) as { id: string }
  auditSettleClaim(s.db, a, g.id, 'ok', 1, JSON.stringify({ v: 1 }))
  auditReleaseUnsent(s.db, a, g.id, 'not sent: spend refused: over_cap')
  assert.deepEqual(auditTryReserve(s.db, a), { prior: 'ok' }, 'the settled claim still replays')
  const b = { ...a, lookup: 'step:org Unsent Co (unsent.example)' }
  const g2 = auditTryReserve(s.db, b) as { id: string }
  auditReleaseUnsent(s.db, b, g2.id, 'not sent: spend refused: over_cap')
  assert.ok('id' in auditTryReserve(s.db, b), 'the released (never sent) lookup can be claimed again')
})

test('#382 run report: lookups the spend gate refused before sending are holds, never failed or completed lookups', async () => {
  const s = seed(2); const calls: Calls = { apollo: 0, pdl: 0 }
  await runWithScanSpend(s.ctx, async () => {
    const h = await reserveScanSpend('tinyfish.search', () => 0); await h!.settle(null); h!.rejected(429) // attempt-wide: nothing of the pass is sent
    await enrichLeadContacts(s.db, 'u1', s.jobId, s.leads, { fetchImpl: router(async () => ok({}), async () => ok(PDL_OK), calls), master })
  })
  const o = paidEnrichmentOutcomes(s.db, 'u1', s.jobId)
  assert.deepEqual([calls.apollo, calls.pdl], [0, 0])
  assert.deepEqual({ total: o.total, failed: o.failed, ok: o.ok, unconfirmed: o.unconfirmed }, { total: 0, failed: 0, ok: 0, unconfirmed: 0 }, JSON.stringify(o))
  assert.ok(o.held >= 1, `reported as held: ${JSON.stringify(o)}`)
})
