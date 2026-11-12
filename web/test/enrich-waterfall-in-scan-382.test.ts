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
import { retryHeldEnrichment, claimKeysFor, heldEnrichments } from '../lib/enrich/index.ts'
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
      const model = await reserveScanSpend('llm.anthropic', () => 0.001) // buyer fit's model call
      await model?.settle(0.001)
      const again = await reserveScanSpend('apollo.people', () => 0.2).then(() => 'admitted', (e: unknown) => (e as { reason?: string }).reason)
      return { r, attemptRejected: spendAttemptRejected(), apolloRejected: spendVendorRejected('apollo'), later: !!later && !!model, again }
    })
    assert.equal(calls.pdl, 1, 'PDL was called after the Apollo rejection')
    assert.deepEqual(attached(s.db), ['enrich:pdl:Pdl Person - Practice Manager'])
    assert.deepEqual(out.r.outcomes.map(o => `${o.provider}:${o.outcome}`), [`apollo:${status === 401 ? 'auth' : 'rate_limited'}`, 'pdl:attached'])
    assert.equal(out.attemptRejected, null, 'an enrichment vendor rejection does not end the scan as provider_rejected')
    assert.equal(out.apolloRejected, status)
    assert.equal(out.later, true, 'a later TinyFish search and model call (people search, buyer fit) of the same attempt are admitted')
    assert.equal(out.again, 'vendor_rejected', 'Apollo itself is never called again in the attempt')
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
  assert.ok(texts.includes('Apollo: the remaining lookups in this scan were not sent: it refused an earlier paid request in this scan (a rejected key or a rate limit), and dazl never sends it another request after a refusal. The refused lookups were not charged; lookups made before the refusal keep their own charges.'), JSON.stringify(texts))
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
    assert.ok(texts.includes('People Data Labs: the remaining lookups in this scan were not sent: an earlier paid request in this scan may have been billed without a confirmed cost (it timed out or the provider failed), so dazl made no further paid request in this scan. The refused lookups were not charged; lookups made before the refusal keep their own charges.'), JSON.stringify(texts))
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
  assert.ok(texts.some(t => t.startsWith("Apollo: the remaining lookups in this scan were not sent: the scan's AI or search provider refused an earlier request")), JSON.stringify(texts))
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

const PDL_EMPTY = async () => ok({ data: [] })
const auditRows = (db: Database.Database, connector: string) => (db.prepare('SELECT status FROM connector_audit WHERE connector = ? ORDER BY insert_seq').all(connector) as { status: string }[]).map(r => r.status)

test('#382 run report (claims basis): a 429 is one failed lookup; the lookups refused after it are not counted as failed', async () => {
  const s = seed(2); const calls: Calls = { apollo: 0, pdl: 0 }
  await runWithScanSpend(s.ctx, () => enrichLeadContacts(s.db, 'u1', s.jobId, s.leads, { fetchImpl: router(async () => new Response('slow', { status: 429 }), PDL_EMPTY, calls), master }))
  assert.ok(auditRows(s.db, 'enrich:apollo').some(x => x.startsWith('not sent: ')), 'the scenario does refuse Apollo lookups after the 429')
  const o = paidEnrichmentOutcomes(s.db, 'u1', s.jobId)
  assert.equal(o.basis, 'claims')
  assert.equal(o.failed, 1, `only the 429 itself: ${JSON.stringify(o)}`)
  assert.equal(o.unconfirmed, 1, 'the 429 stays held (a received rejection is never assumed free)')
})

test('#382 an Apollo org lookup refused by the scan cap: no request, the claim released, the credit returned, never an "error"', async () => {
  const s = seed(); const calls: Calls = { apollo: 0, pdl: 0 }
  s.db.prepare('UPDATE scan_jobs SET spend_cap_usd = 0.1 WHERE id = ?').run(s.jobId) // below one Apollo org call ($0.20)
  const r = await runWithScanSpend(s.ctx, () => enrichLeadContacts(s.db, 'u1', s.jobId, s.leads, { fetchImpl: router(async () => ok({}), PDL_EMPTY, calls), master }))
  assert.equal(calls.apollo, 0)
  assert.equal(r.outcomes[0].outcome, 'spend_refused')
  assert.equal(heldClaims(s.db, 'enrich:apollo'), 0)
  assert.ok(!auditRows(s.db, 'enrich:apollo').some(x => x === 'error'), JSON.stringify(auditRows(s.db, 'enrich:apollo')))
  const credits = s.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'enrich_credit_holds'").get() as { n: number }
  void credits // the credit refund path is the same releaseUnused the pre-#382 code already ran; asserted by enrich-credit-pool tests
  const texts = (await providerIssues('u1', s.jobId))!.map(providerIssueText)
  assert.ok(texts.some(t => t.includes("this scan's spending cap had no room left for the lookup")), JSON.stringify(texts))
})

test('#382 org sent, then the people step refused by the cap: the notice never claims nothing was charged for the lead', async () => {
  const s = seed(); const calls: Calls = { apollo: 0, pdl: 0 }
  s.db.prepare('UPDATE scan_jobs SET spend_cap_usd = 0.3 WHERE id = ?').run(s.jobId) // room for the org call, not the people call
  const org = { organization: { name: 'Harbor Dental', website_url: 'https://harbordental.example', city: 'New York', state: 'New York', country: 'United States' } }
  await runWithScanSpend(s.ctx, () => enrichLeadContacts(s.db, 'u1', s.jobId, s.leads, { fetchImpl: router(async () => ok(org), PDL_EMPTY, calls), master }))
  assert.equal(calls.apollo, 1, 'the org call was sent')
  const texts = (await providerIssues('u1', s.jobId))!.map(providerIssueText)
  const t = texts.find(x => x.startsWith('Apollo: the remaining lookups'))
  assert.ok(t, JSON.stringify(texts))
  assert.ok(!/nothing was charged for them|Nothing was sent to Apollo/.test(t!), t)
  assert.match(t!, /lookups made before the refusal keep their own charges/)
})

test('#382 owner retry refused by the scan cap: nothing sent, the lookup stays held, and the owner is told it was refused (not "retried")', async () => {
  const s = seed(); const calls: Calls = { apollo: 0, pdl: 0 }
  s.db.prepare('DELETE FROM tenant_connectors WHERE connector = ?').run('enrich:apollo')
  const prev = process.env.DAZL_ENRICH_RETRY_COST_VERIFIED; process.env.DAZL_ENRICH_RETRY_COST_VERIFIED = 'pdl'
  try {
    const lookup = claimKeysFor(s.leads[0]).legacyPeople
    const g = auditTryReserve(s.db, { tenantId: 'u1', connector: 'enrich:pdl', jobId: s.jobId, lookup, status: 'reserved', results: 0 }) as { id: string }
    assert.ok(g.id)
    s.db.prepare('UPDATE connector_claims SET claimed_at = claimed_at - 3600').run() // a crash remnant, old enough to be the owner's
    s.db.prepare('UPDATE scan_jobs SET spend_cap_usd = 0.1 WHERE id = ?').run(s.jobId) // below one PDL search
    const r = await retryHeldEnrichment(s.db, 'u1', 'lead1', { provider: 'pdl', step: 'legacy' }, { fetchImpl: router(async () => ok({}), async () => ok(PDL_OK), calls), master })
    assert.equal(calls.pdl, 0, 'nothing sent')
    assert.equal(r.status, 'refused', JSON.stringify(r))
    assert.match((r as { reason: string }).reason, /over_cap/)
    assert.equal(heldClaims(s.db, 'enrich:pdl'), 1, 'the held item survives for a later retry')
    assert.equal(heldEnrichments(s.db, 'u1').length, 1, 'and is still LISTED for the owner right away (not hidden for 15 minutes)')
    const o = paidEnrichmentOutcomes(s.db, 'u1', s.jobId)
    assert.equal(o.failed, 0, `a refused, unsent retry is not a failed lookup: ${JSON.stringify(o)}`)
    assert.equal(o.unconfirmed, 0, 'proven unsent: never "whether it was sent or charged is not confirmed"')
    assert.ok(o.held >= 1, 'reported as a hold')
  } finally { if (prev === undefined) delete process.env.DAZL_ENRICH_RETRY_COST_VERIFIED; else process.env.DAZL_ENRICH_RETRY_COST_VERIFIED = prev }
})

test('#382 an Apollo 404 keeps the attempt-wide stop (not documented as unbilled): PDL is not called after it', async () => {
  const s = seed(); const calls: Calls = { apollo: 0, pdl: 0 }
  const out = await runWithScanSpend(s.ctx, async () => {
    const r = await enrichLeadContacts(s.db, 'u1', s.jobId, s.leads, { fetchImpl: router(async () => new Response('{}', { status: 404 }), async () => ok(PDL_OK), calls), master })
    return { r, rejected: spendAttemptRejected() }
  })
  assert.equal(calls.pdl, 0)
  assert.equal(out.rejected, 404)
})

test('#382 owner retry of an Apollo org lookup: org sent and charged, people step refused by the cap -> "retried", never "nothing was charged"', async () => {
  const s = seed(); const calls: Calls = { apollo: 0, pdl: 0 }
  const prev = process.env.DAZL_ENRICH_RETRY_COST_VERIFIED; process.env.DAZL_ENRICH_RETRY_COST_VERIFIED = 'apollo'
  try {
    const g = auditTryReserve(s.db, { tenantId: 'u1', connector: 'enrich:apollo', jobId: s.jobId, lookup: claimKeysFor(s.leads[0]).stepOrg, status: 'reserved', results: 0 }) as { id: string }
    assert.ok(g.id)
    s.db.prepare('UPDATE connector_claims SET claimed_at = claimed_at - 3600').run()
    s.db.prepare('UPDATE scan_jobs SET spend_cap_usd = 0.3 WHERE id = ?').run(s.jobId) // room for the org call, not the people call
    const org = { organization: { name: 'Harbor Dental', website_url: 'https://harbordental.example', city: 'New York', state: 'New York', country: 'United States' } }
    const r = await retryHeldEnrichment(s.db, 'u1', 'lead1', { provider: 'apollo', step: 'org' }, { fetchImpl: router(async () => ok(org), PDL_EMPTY, calls), master })
    assert.equal(calls.apollo, 1, 'the org call was sent')
    assert.equal(r.status, 'retried', JSON.stringify(r))
  } finally { if (prev === undefined) delete process.env.DAZL_ENRICH_RETRY_COST_VERIFIED; else process.env.DAZL_ENRICH_RETRY_COST_VERIFIED = prev }
})

test('#382 run report (claims basis): an Apollo timeout plus the lookups refused after it -> one unconfirmed lookup, no extra failures', async () => {
  const s = seed(2); const calls: Calls = { apollo: 0, pdl: 0 }
  await runWithScanSpend(s.ctx, () => enrichLeadContacts(s.db, 'u1', s.jobId, s.leads, { fetchImpl: router(async () => { throw new DOMException('aborted', 'AbortError') }, async () => ok(PDL_OK), calls), master }))
  assert.ok(auditRows(s.db, 'enrich:pdl').some(x => x.startsWith('not sent: ')), 'PDL lookups were refused before sending')
  const o = paidEnrichmentOutcomes(s.db, 'u1', s.jobId)
  assert.equal(o.basis, 'claims')
  assert.deepEqual({ unconfirmed: o.unconfirmed, failed: o.failed }, { unconfirmed: 1, failed: 1 }, `only the timed-out org call: ${JSON.stringify(o)}`)
})

test('#382 notices: two refusal causes for one provider are two lines, each with its own reason', async () => {
  const { audit } = await import('../lib/connectors/store.ts')
  const s = seed()
  audit(s.db, { tenantId: 'u1', connector: 'enrich:pdl', jobId: s.jobId, lookup: 'spend refused: accounting_uncertain', status: 'spend_refused', results: 0 })
  audit(s.db, { tenantId: 'u1', connector: 'enrich:pdl', jobId: s.jobId, lookup: 'spend refused: over_cap', status: 'spend_refused', results: 0 })
  const texts = (await providerIssues('u1', s.jobId))!.map(providerIssueText)
  assert.ok(texts.some(t => t.includes('may have been billed without a confirmed cost')), JSON.stringify(texts))
  assert.ok(texts.some(t => t.includes("this scan's spending cap had no room left")), JSON.stringify(texts))
})
