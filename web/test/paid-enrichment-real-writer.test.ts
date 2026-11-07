// #923 / PR #961 review: the run report's paid_enrichment stage must describe what the REAL enrichment writer did.
// The writer records an org claim row, a compatibility "org X" row and a people-step row for ONE Apollo attempt; reading
// them as three lookups with two "results" made an org-only success look like a contact success. These tests drive the
// actual enrichLeadContacts writer with injected synthetic provider calls (invented companies, .example domains, no
// network, no credits, no live data) and then the actual notePaidEnrichment + mergeIntoRunReport path, for both providers.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { enrichLeadContacts } from '../lib/enrich/index.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateRunReport } from '../lib/scan/run-report.ts'
import { migrateConnectors, saveCredential, setEnrichFallback } from '../lib/connectors/store.ts'
import { EnrichmentTrace, notePaidEnrichment, mergeIntoRunReport } from '../lib/scan/enrichment-trace.ts'

const master = randomBytes(32)
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
const ICP = JSON.stringify({ summary: 'x', where: ['New York City'], who: ['Practice manager'], signals: [] })
type Lead = { id: string; company: string; company_domain: string }
const L1: Lead = { id: 'l1', company: 'Harbor Dental', company_domain: 'harbordental.example' }
const L2: Lead = { id: 'l2', company: 'Ridge Vision', company_domain: 'ridgevision.example' }

function seed(leads: Lead[], provs: ('apollo' | 'pdl')[]) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateRunReport(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(ICP, jobId)
  for (const l of leads) db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES (?, ?, '', ?, ?, 'opened', 'https://x.example/1')").run(l.id, jobId, l.company, l.company_domain)
  if (provs.includes('apollo')) saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  if (provs.includes('pdl')) { saveCredential(db, 'u1', 'enrich:pdl', 'test-pdl-key-5678', master); if (provs.includes('apollo')) setEnrichFallback(db, 'u1', true) }
  return { db, jobId }
}
// Injected provider calls. `calls` counts the simulated provider requests, so "logical calls" is checked against reality.
function apollo(by: Record<string, { org: unknown; people?: unknown[]; orgStatus?: number }>) {
  const calls = { org: 0, people: 0 }
  const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>
    const key = Object.keys(by).find(k => JSON.stringify(body).includes(k))!
    if (String(u).includes('organizations')) { calls.org++; const c = by[key]; return c.orgStatus ? new Response('err', { status: c.orgStatus }) : ok({ organization: c.org }) }
    calls.people++; return ok({ people: by[key].people ?? [] })
  }) as typeof fetch
  return { fetchImpl, calls }
}
const orgOf = (l: Lead, site = `https://${l.company_domain}`) => ({ name: l.company, website_url: site, city: 'New York', state: 'NY', country: 'United States', estimated_num_employees: 12 })
const personOf = (l: Lead) => ({ name: 'Pat Lee', title: 'Practice Manager', organization: { name: l.company, primary_domain: l.company_domain } })
function pdl(by: Record<string, unknown[]>) {
  const calls = { pdl: 0 }
  const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    calls.pdl++; const q = String(init?.body ?? '').toLowerCase(); const key = Object.keys(by).find(k => q.includes(k.toLowerCase()))!
    return ok({ data: by[key] })
  }) as typeof fetch
  return { fetchImpl, calls }
}
const pdlPerson = (l: Lead, domain = l.company_domain) => ({ full_name: 'Pat Lee', job_title: 'Practice Manager', job_company_website: domain, job_company_location_locality: 'New York' })

async function report(db: Database.Database, jobId: string) {
  const tr = new EnrichmentTrace(); notePaidEnrichment(tr, db, 'u1', jobId)
  // the actual run-report merge: the stage lands in the stored report exactly as the runner writes it
  db.prepare("INSERT INTO scan_run_report (job_id, attempt, report) VALUES (?, 1, '{}')").run(jobId)
  assert.equal(mergeIntoRunReport(db, jobId, 1, { enrichment: tr.stages }), true)
  const stored = JSON.parse((db.prepare('SELECT report FROM scan_run_report WHERE job_id = ? AND attempt = 1').get(jobId) as { report: string }).report) as { enrichment: { stage: string; status: string; reason: string | null; detail?: Record<string, number> }[] }
  return stored.enrichment.find(s => s.stage === 'paid_enrichment')!
}

test('Apollo: organization match + empty people = ONE no-contact outcome, 2 real calls, not a contact success (writer shape)', async () => {
  const { db, jobId } = seed([L1], ['apollo']); const a = apollo({ [L1.company_domain]: { org: orgOf(L1), people: [] } })
  const r = await enrichLeadContacts(db, 'u1', jobId, [L1], { fetchImpl: a.fetchImpl, master })
  assert.deepEqual(r.outcomes.map(o => o.outcome), ['empty']); assert.deepEqual(a.calls, { org: 1, people: 1 })
  assert.equal((db.prepare("SELECT COUNT(*) n FROM lead_enrichments WHERE kind = 'contact'").get() as { n: number }).n, 0)
  const s = await report(db, jobId)
  assert.equal(s.status, 'attempted_no_result', 'a matched company without a contact is not a successful paid enrichment')
  assert.equal(s.detail?.lookups, 2, 'logical provider calls: org + people, the compatibility org row is not a third')
  assert.equal(s.detail?.with_results, 0, 'no contact was attached')
  assert.equal(s.detail?.company_ok, 1); assert.equal(s.detail?.empty, 1); assert.equal(s.detail?.failed, 0)
})

test('Apollo: a rejected wrong-domain organization is one call, zero contacts, a rejection - never ok / 2 results / 3 lookups', async () => {
  const { db, jobId } = seed([L1], ['apollo']); const a = apollo({ [L1.company_domain]: { org: orgOf(L1, 'https://other-company.example'), people: [personOf(L1)] } })
  const r = await enrichLeadContacts(db, 'u1', jobId, [L1], { fetchImpl: a.fetchImpl, master })
  assert.deepEqual(r.outcomes.map(o => o.outcome), ['rejected']); assert.deepEqual(a.calls, { org: 1, people: 0 }, 'the people step never reached the provider')
  const s = await report(db, jobId)
  assert.equal(s.status, 'failed'); assert.equal(s.detail?.lookups, 1, 'only the org call happened'); assert.equal(s.detail?.with_results, 0)
  assert.equal(s.detail?.company_rejected, 1); assert.equal(s.detail?.company_ok, 0); assert.equal(s.detail?.failed, 1)
})

test('Apollo: genuine contact success counts once as company + contact success (2 calls, 1 with results)', async () => {
  const { db, jobId } = seed([L1], ['apollo']); const a = apollo({ [L1.company_domain]: { org: orgOf(L1), people: [personOf(L1)] } })
  await enrichLeadContacts(db, 'u1', jobId, [L1], { fetchImpl: a.fetchImpl, master })
  const s = await report(db, jobId)
  assert.equal(s.status, 'ok'); assert.equal(s.detail?.lookups, 2); assert.equal(s.detail?.with_results, 1)
  assert.equal(s.detail?.company_ok, 1); assert.equal(s.detail?.empty, 0); assert.equal(s.detail?.failed, 0)
})

test('Apollo: mixed run keeps the truth visible - one contact success, one rejected company, one empty', async () => {
  const L3: Lead = { id: 'l3', company: 'Maple Clinic', company_domain: 'mapleclinic.example' }
  const { db, jobId } = seed([L1, L2, L3], ['apollo'])
  const a = apollo({
    [L1.company_domain]: { org: orgOf(L1), people: [personOf(L1)] },
    [L2.company_domain]: { org: orgOf(L2, 'https://elsewhere.example'), people: [] },
    [L3.company_domain]: { org: orgOf(L3), people: [] },
  })
  await enrichLeadContacts(db, 'u1', jobId, [L1, L2, L3], { fetchImpl: a.fetchImpl, master })
  assert.deepEqual(a.calls, { org: 3, people: 2 })
  const s = await report(db, jobId)
  assert.equal(s.status, 'ok', 'a genuine contact success stands even beside failures')
  assert.deepEqual([s.detail?.lookups, s.detail?.with_results, s.detail?.empty, s.detail?.failed, s.detail?.company_ok, s.detail?.company_rejected], [5, 1, 1, 1, 2, 1])
})

test('Apollo: an organization call that fails keeps the failure and does not read as a success', async () => {
  const { db, jobId } = seed([L1], ['apollo']); const a = apollo({ [L1.company_domain]: { org: null, orgStatus: 500, people: [] } })
  await enrichLeadContacts(db, 'u1', jobId, [L1], { fetchImpl: a.fetchImpl, master })
  const s = await report(db, jobId)
  assert.notEqual(s.status, 'ok'); assert.equal(s.detail?.with_results, 0); assert.equal(s.detail?.company_ok, 0); assert.ok((s.detail?.failed ?? 0) >= 1)
  // the unsettled org claim may or may not have reached the provider / been charged: reported, never a completed lookup
  assert.equal(s.detail?.unconfirmed, 1); assert.equal(s.detail?.lookups, 1, 'only the settled people step is a completed lookup')
})

test('PDL: contact success, empty and an all-rejected pass are each ONE logical call (a rejection writes two audit rows)', async () => {
  for (const [name, data, want] of [
    ['success', [pdlPerson(L1)], { status: 'ok', lookups: 1, with_results: 1, empty: 0, failed: 0 }],
    ['empty', [], { status: 'attempted_no_result', lookups: 1, with_results: 0, empty: 1, failed: 0 }],
    ['rejected', [pdlPerson(L1, 'elsewhere.example')], { status: 'failed', lookups: 1, with_results: 0, empty: 0, failed: 1 }],
  ] as const) {
    const { db, jobId } = seed([L1], ['pdl']); const p = pdl({ [L1.company]: [...data] })
    await enrichLeadContacts(db, 'u1', jobId, [L1], { fetchImpl: p.fetchImpl, master })
    assert.equal(p.calls.pdl, 1, `${name}: one simulated PDL call`)
    const s = await report(db, jobId)
    assert.deepEqual({ status: s.status, lookups: s.detail?.lookups, with_results: s.detail?.with_results, empty: s.detail?.empty, failed: s.detail?.failed }, want, name)
  }
})

test('PDL: success beside a rejected lead is ok with the rejection still counted', async () => {
  const { db, jobId } = seed([L1, L2], ['pdl']); const p = pdl({ [L1.company]: [pdlPerson(L1)], [L2.company]: [pdlPerson(L2, 'elsewhere.example')] })
  await enrichLeadContacts(db, 'u1', jobId, [L1, L2], { fetchImpl: p.fetchImpl, master })
  const s = await report(db, jobId)
  assert.deepEqual([s.status, s.detail?.lookups, s.detail?.with_results, s.detail?.failed], ['ok', 2, 1, 1])
})

// ---- second review pass: historical rows, unreadable records, unconfirmed claims, identity binding ----
test('historical job (no claim rows): org success + the duplicate compatibility row is NOT a contact success', async () => {
  const { db, jobId } = seed([L1], ['apollo']); const a = apollo({ [L1.company_domain]: { org: orgOf(L1), people: [] } })
  await enrichLeadContacts(db, 'u1', jobId, [L1], { fetchImpl: a.fetchImpl, master })
  db.prepare('DELETE FROM connector_claims').run() // the job as it was recorded before per-step claims: only the writer's audit rows remain
  const rows = db.prepare("SELECT lookup, status, results FROM connector_audit WHERE connector = 'enrich:apollo' ORDER BY rowid").all()
  assert.equal(rows.length, 3, 'the real writer shape: step:org + compatibility org + people rows')
  const s = await report(db, jobId)
  assert.equal(s.status, 'attempted_no_result'); assert.equal(s.detail?.with_results, 0, 'zero contacts attached')
  assert.equal(s.detail?.company_ok, 1, 'the two org rows are one company outcome'); assert.equal(s.detail?.empty, 1)
  assert.equal(s.detail?.basis, 'audit_rows', 'an audit-row reading says so; it is not presented as an exact lookup count')
})
test('historical job: a genuine contact still reads ok, and a rejected org is a failure, not a success', async () => {
  let r = seed([L1], ['apollo']); let a = apollo({ [L1.company_domain]: { org: orgOf(L1), people: [personOf(L1)] } })
  await enrichLeadContacts(r.db, 'u1', r.jobId, [L1], { fetchImpl: a.fetchImpl, master }); r.db.prepare('DELETE FROM connector_claims').run()
  let s = await report(r.db, r.jobId); assert.deepEqual([s.status, s.detail?.with_results, s.detail?.company_ok], ['ok', 1, 1])
  r = seed([L1], ['apollo']); a = apollo({ [L1.company_domain]: { org: orgOf(L1, 'https://other-company.example'), people: [] } })
  await enrichLeadContacts(r.db, 'u1', r.jobId, [L1], { fetchImpl: a.fetchImpl, master }); r.db.prepare('DELETE FROM connector_claims').run()
  s = await report(r.db, r.jobId); assert.equal(s.status, 'failed'); assert.equal(s.detail?.with_results, 0)
})
test('unreadable claim records: the stage is unknown (failed), never a success from an org-only audit row', async () => {
  const { db, jobId } = seed([L1], ['apollo']); const a = apollo({ [L1.company_domain]: { org: orgOf(L1), people: [] } })
  await enrichLeadContacts(db, 'u1', jobId, [L1], { fetchImpl: a.fetchImpl, master })
  db.exec('DROP TABLE connector_claims') // the claims query now fails; the audit still holds an org row with results = 1
  const s = await report(db, jobId)
  assert.equal(s.status, 'failed'); assert.match(s.reason ?? '', /could not be read/); assert.notEqual(s.status, 'ok'); assert.equal(s.detail?.with_results, 0)
})
test('an unsettled (reserved) claim is unconfirmed: never a completed lookup and never a success', async () => {
  const { db, jobId } = seed([L1], ['pdl']); const p = pdl({ [L1.company]: [pdlPerson(L1)] })
  await enrichLeadContacts(db, 'u1', jobId, [L1], { fetchImpl: p.fetchImpl, master })
  // a request may have been sent but the writer never settled it: put the real claim back to its unsettled state
  db.prepare("UPDATE connector_claims SET status = 'reserved', settled_at = NULL").run(); db.prepare("UPDATE connector_audit SET status = 'reserved', results = 0 WHERE connector = 'enrich:pdl'").run()
  const s = await report(db, jobId)
  assert.equal(s.detail?.unconfirmed, 1); assert.equal(s.detail?.lookups, 0, 'not counted as a verified lookup'); assert.equal(s.detail?.with_results, 0)
  assert.notEqual(s.status, 'ok'); assert.match(s.reason ?? '', /not confirmed/)
})
test('identity binding: Apollo org-rejected lead + PDL fallback rejection with the SAME reason text stay attributed to their own provider step', async () => {
  // Same lead, both providers, and a PDL candidate from the same wrong site: the Apollo people claim (never sent) and the PDL
  // claim (sent) carry the identical rejection text. Reason text alone cannot tell them apart; identity + provider can.
  const { db, jobId } = seed([L1], ['apollo', 'pdl'])
  const a = apollo({ [L1.company_domain]: { org: orgOf(L1, 'https://elsewhere.example'), people: [] } })
  const p = pdl({ [L1.company]: [pdlPerson(L1, 'elsewhere.example')] })
  const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => String(u).includes('apollo.io') ? a.fetchImpl(u, init) : p.fetchImpl(u, init)) as typeof fetch
  await enrichLeadContacts(db, 'u1', jobId, [L1], { fetchImpl, master })
  const reasons = db.prepare("SELECT connector, status FROM connector_claims c WHERE lookup LIKE '%people%' ORDER BY rowid").all() as { connector: string; status: string }[]
  const s = await report(db, jobId)
  assert.deepEqual([a.calls.org, a.calls.people, p.calls.pdl], [1, 0, 1], 'what was really sent: one Apollo org call, no Apollo people call, one PDL call')
  assert.equal(s.detail?.apollo_lookups, 1, 'Apollo: the org lookup only'); assert.equal(s.detail?.pdl_lookups, 1, 'PDL: its own lookup'); assert.equal(s.detail?.lookups, 2)
  assert.ok(reasons.length >= 1)
})
test('identity binding (record-shape check): a PDL claim never consumes another identity or provider\'s org rejection', async () => {
  // Hand-built rows, labelled as such: PDL claim first in rowid order carries the same text as Apollo\'s unsent people claim for a DIFFERENT lead.
  const { db, jobId } = seed([L1, L2], ['apollo'])
  const reason = 'contact rejected: domain mismatch elsewhere.example vs harbordental.example'
  const ins = (connector: string, lookup: string, status: string, memo: string | null, auditStatus: string, results = 0) => {
    db.prepare("INSERT INTO connector_claims (tenant_id, connector, scan_job_id, lookup, status, claimed_at, settled_at, memo) VALUES ('u1', ?, ?, ?, ?, 1, 1, ?)").run(connector, jobId, lookup, status, memo)
    db.prepare("INSERT INTO connector_audit (id, tenant_id, connector, scan_job_id, lookup, status, results) VALUES (?, 'u1', ?, ?, ?, ?, ?)").run(crypto.randomUUID(), connector, jobId, lookup, auditStatus, results)
  }
  ins('enrich:pdl', 'people Ridge Vision (ridgevision.example)', 'rejected', null, reason)            // sent: PDL candidate from the same wrong site
  ins('enrich:apollo', 'step:org Harbor Dental (harbordental.example)', 'ok', JSON.stringify({ v: 1, rejected: reason }), 'ok', 1)
  ins('enrich:apollo', 'step:people Harbor Dental (harbordental.example)', 'rejected', null, reason) // unsent: bound to its own org claim
  const s = await report(db, jobId)
  assert.deepEqual([s.detail?.apollo_lookups, s.detail?.pdl_lookups, s.detail?.lookups], [1, 1, 2], 'PDL counted, Apollo people (unsent) not, Apollo org counted')
})
