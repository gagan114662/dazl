// #922: durable enrichment claim keys keep the whole company/domain-or-lead identity, however long the label.
// Stubbed providers only (invented companies, .test domains); no network, no credits, no live data.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { enrichLeadContacts, claimKeysFor, legacyTruncatedKeysFor, heldEnrichments, retryHeldEnrichment } from '../lib/enrich/index.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential, setEnrichFallback, auditTryReserve, auditSettleClaim } from '../lib/connectors/store.ts'

process.env.DAZL_ENRICH_RETRY_COST_VERIFIED = 'apollo,pdl'
const master = randomBytes(32)
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
const ICP = JSON.stringify({ summary: 'x', where: ['New York City'], who: ['Practice manager'], signals: [] })
const LONG = 'A'.repeat(150)
const PREFIX = 'x'.repeat(40)
type L = { id: string; company: string; company_domain: string | null }
const PAIR: L[] = [{ id: 'a', company: LONG, company_domain: `${PREFIX}.alpha.test` }, { id: 'b', company: LONG, company_domain: `${PREFIX}.beta.test` }]

function seed(leads: L[], provs: ('apollo' | 'pdl')[]) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(ICP, jobId)
  for (const l of leads) db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES (?, ?, '', ?, ?, 'opened', 'https://x.example/1')").run(l.id, jobId, l.company, l.company_domain)
  if (provs.includes('apollo')) saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  if (provs.includes('pdl')) { saveCredential(db, 'u1', 'enrich:pdl', 'test-pdl-key-5678', master); if (provs.includes('apollo')) setEnrichFallback(db, 'u1', true) }
  return { db, jobId }
}
const calls = () => ({ apollo: 0, apolloOrg: 0, pdl: 0 })
const stub = (c: ReturnType<typeof calls>) => (async (u: RequestInfo | URL) => {
  const s = String(u)
  if (s.includes('apollo.io')) { c.apollo++; if (s.includes('organizations')) { c.apolloOrg++; return ok({ organization: null }) } return ok({ people: [] }) }
  c.pdl++; return ok({ data: [] })
}) as typeof fetch

test('#922 keys: long same-name companies at distinct domains get distinct bounded keys', () => {
  const [a, b] = PAIR.map(claimKeysFor)
  for (const k of ['legacyPeople', 'stepOrg', 'stepPeople'] as const) {
    assert.notEqual(a[k], b[k], `${k} must not collide`)
    assert.ok(a[k].length <= 200 && b[k].length <= 200, `${k} stays bounded`)
    assert.match(a[k], /#h:[0-9a-f]{32}$/)
  }
  assert.ok(claimKeysFor(PAIR[0]).stepOrg.startsWith('step:org '), 'the readable step: prefix survives')
  assert.deepEqual(claimKeysFor(PAIR[0]), claimKeysFor({ ...PAIR[0] }), 'deterministic: the same identity keeps one key')
})

test('#922 keys: two long no-domain leads differ by lead id', () => {
  const a = claimKeysFor({ id: 'id-1', company: LONG + 'B'.repeat(80), company_domain: null })
  const b = claimKeysFor({ id: 'id-2', company: LONG + 'B'.repeat(80), company_domain: null })
  assert.notEqual(a.stepPeople, b.stepPeople); assert.notEqual(a.legacyPeople, b.legacyPeople)
})

test('#922 compatibility: keys that already fit are unchanged (existing valid claims keep replaying)', () => {
  const k = claimKeysFor({ id: 'lead1', company: 'Harbor Dental', company_domain: 'harbordental.example' })
  assert.deepEqual(k, { legacyPeople: 'people Harbor Dental (harbordental.example)', stepOrg: 'step:org Harbor Dental (harbordental.example)', stepPeople: 'step:people Harbor Dental (harbordental.example)' })
  assert.deepEqual(legacyTruncatedKeysFor({ id: 'lead1', company: 'Harbor Dental', company_domain: 'harbordental.example' }), { legacyPeople: null, stepOrg: null, stepPeople: null })
})

test('#922 PDL: distinct long identities are each looked up; a true same-lookup replay is free', async () => {
  const { db, jobId } = seed(PAIR, ['pdl']); const c = calls()
  const r = await enrichLeadContacts(db, 'u1', jobId, PAIR, { fetchImpl: stub(c), master })
  assert.equal(c.pdl, 2, 'B is looked up, not silenced by A')
  assert.deepEqual(r.outcomes.map(o => `${o.leadId}:${o.outcome}`), ['a:empty', 'b:empty'])
  const r2 = await enrichLeadContacts(db, 'u1', jobId, PAIR, { fetchImpl: stub(c), master })
  assert.equal(c.pdl, 2, 'the replayed job pays for neither again')
  assert.equal(r2.skipped.filter(s => s.why === 'replayed').length, 2)
})

test('#922 Apollo per-step: distinct long identities each run org + people; replay is free', async () => {
  const { db, jobId } = seed(PAIR, ['apollo']); const c = calls()
  await enrichLeadContacts(db, 'u1', jobId, PAIR, { fetchImpl: stub(c), master })
  assert.equal(c.apolloOrg, 2, 'each company gets its own org lookup')
  const before = { ...c }
  await enrichLeadContacts(db, 'u1', jobId, PAIR, { fetchImpl: stub(c), master })
  assert.deepEqual(c, before, 'no provider call on replay')
})

test('#922 legacy truncated row shared by two identities: neither replays it, neither pays; both fail closed', async () => {
  const { db, jobId } = seed(PAIR, ['pdl']); const c = calls()
  const t = legacyTruncatedKeysFor(PAIR[0]).legacyPeople!
  assert.equal(t, legacyTruncatedKeysFor(PAIR[1]).legacyPeople, 'the pre-#922 collision this guards')
  const g = auditTryReserve(db, { tenantId: 'u1', connector: 'enrich:pdl', jobId, lookup: t, status: 'reserved', results: 0 })
  auditSettleClaim(db, { tenantId: 'u1', connector: 'enrich:pdl', jobId, lookup: t, status: 'empty', results: 0 }, (g as { id: string }).id, 'empty', 0)
  const r = await enrichLeadContacts(db, 'u1', jobId, PAIR, { fetchImpl: stub(c), master })
  assert.equal(c.pdl, 0, 'no repay on an assumed identity')
  assert.equal(r.skipped.filter(s => s.why === 'uncertain').length, 2, 'unattributable: held, not replayed')
})

test('#922 legacy truncated row owned by one identity: it still replays free', async () => {
  const one = [PAIR[0]]
  const { db, jobId } = seed(one, ['pdl']); const c = calls()
  const t = legacyTruncatedKeysFor(PAIR[0]).legacyPeople!
  const g = auditTryReserve(db, { tenantId: 'u1', connector: 'enrich:pdl', jobId, lookup: t, status: 'reserved', results: 0 })
  auditSettleClaim(db, { tenantId: 'u1', connector: 'enrich:pdl', jobId, lookup: t, status: 'empty', results: 0 }, (g as { id: string }).id, 'empty', 0)
  const r = await enrichLeadContacts(db, 'u1', jobId, one, { fetchImpl: stub(c), master })
  assert.equal(c.pdl, 0); assert.equal(r.skipped[0]?.why, 'replayed')
})

test('#922 legacy truncated HELD Apollo step claim: never auto-released, stays held, owner retry resolves it', async () => {
  const one = [PAIR[0]]
  const { db, jobId } = seed(one, ['apollo']); const c = calls()
  const t = legacyTruncatedKeysFor(PAIR[0]).stepOrg!
  assert.ok('id' in auditTryReserve(db, { tenantId: 'u1', connector: 'enrich:apollo', jobId, lookup: t, status: 'reserved', results: 0 }))
  db.prepare('UPDATE connector_claims SET claimed_at = 0').run()
  const r = await enrichLeadContacts(db, 'u1', jobId, one, { fetchImpl: stub(c), master })
  assert.equal(c.apollo, 0, 'a maybe-billed org call is never repeated automatically')
  assert.equal(r.skipped[0]?.why, 'uncertain')
  const held = heldEnrichments(db, 'u1')
  assert.deepEqual(held.map(h => `${h.leadId}:${h.step}:${h.lookup === t}`), ['a:org:true'], 'the old row surfaces for the owner')
  const rr = await retryHeldEnrichment(db, 'u1', 'a', { provider: 'apollo', step: 'org' }, { fetchImpl: stub(c), master })
  assert.equal(rr.status, 'retried'); assert.equal(c.apolloOrg, 1, 'the owner retry runs on the new full-identity key')
})
