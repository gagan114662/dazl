// #390 / #618 review: a consent withdrawal must be REMEMBERED. Erasing the subject's leads is not enough: an
// older-dated `granted` event for the same person that arrives after the withdrawal (retry, delayed queue, backfill)
// must not resurrect the lead. The fix keeps a minimal tombstone per tenant + person key (the salted fp:p: hash and
// the withdrawal time - never the email or name), bounded by the tenant's recorded retention and erased by
// eraseFirstParty. Red on 172aaa1d: R1 resurrects (1 lead); R2/R5 pass; R3/R4 pin the new store.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { bothEngines, type EngineCtx } from './helpers/engines.ts'
import type { Db } from '../lib/db/client.ts'
import { ingest, recordConfig, eraseFirstParty, purgeFirstPartyRetention, signBody, type FpConfigInput } from '../lib/signals/first-party.ts'

process.env.DAZL_MASTER_KEY ??= randomBytes(32).toString('base64')
const NOW = 1_793_000_000
const CFG: FpConfigInput = { site_domain: 'seller.test', basis: 'consent', privacy_url: 'https://seller.test/privacy', retention_days: 90 }
const iso = (s: number) => new Date(s * 1000).toISOString()
const grant = (id: string, email: string, at: number) => ({ id, type: 'demo_request', occurred_at: iso(at), page_url: 'https://seller.test/demo', consent: 'granted', person: { email, name: 'Jane Doe', company: 'Acme' } })
const withdraw = (id: string, email: string, at: number) => ({ id, type: 'demo_request', occurred_at: iso(at), page_url: 'https://seller.test/demo', consent: 'withdrawn', person: { email } })
const run = (db: Db, tenant: string, ...events: unknown[]) => { const raw = JSON.stringify({ events }); return ingest(db, tenant, raw, signBody('s', NOW, raw), NOW) }
const leadCount = async (db: Db, tenant: string) => (await db.all("SELECT 1 FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ? AND l.source_kind = 'first_party'", [tenant])).length
const tombstones = (db: Db, tenant: string) => db.all<{ person_key: string; withdrawn_at: number }>('SELECT person_key, withdrawn_at FROM first_party_withdrawals WHERE tenant_id = ?', [tenant])

// R1: grant at T-7200 -> withdraw at T-3600 -> a grant dated T-7000 (BEFORE the withdrawal) delivered late must not
// recreate the lead. Outcome is not `created`; no lead; no event stored.
bothEngines('R1: an older-dated grant delivered after the withdrawal does not resurrect the subject', async ({ db }) => {
  await recordConfig(db, 'A', CFG, 'actor-a', NOW)
  const r1 = await run(db, 'A', grant('g1', 'jane@acme.io', NOW - 7200))
  assert.deepEqual(r1.results.map(r => r.outcome), ['created'])
  assert.equal(await leadCount(db, 'A'), 1)
  const w = await run(db, 'A', withdraw('w1', 'jane@acme.io', NOW - 3600))
  assert.deepEqual(w.results.map(r => r.outcome), ['withdrawn'])
  assert.equal(await leadCount(db, 'A'), 0)
  const r2 = await run(db, 'A', grant('g2', 'jane@acme.io', NOW - 7000))
  assert.notEqual(r2.results[0].outcome, 'created', 'a grant older than the withdrawal must not create')
  assert.ok(['not_consented', 'withdrawn'].includes(r2.results[0].outcome), r2.results[0].outcome)
  assert.equal(await leadCount(db, 'A'), 0)
  assert.equal((await db.all("SELECT 1 FROM lead_enrichments WHERE tenant_id = 'A' AND connector = 'first_party'")).length, 0)
})

// R2: a grant dated AFTER the withdrawal is a new consent and is allowed.
bothEngines('R2: a newer-dated grant after the withdrawal is a new consent and creates', async ({ db }) => {
  await recordConfig(db, 'A', CFG, 'actor-a', NOW)
  await run(db, 'A', grant('g1', 'jane@acme.io', NOW - 7200))
  await run(db, 'A', withdraw('w1', 'jane@acme.io', NOW - 3600))
  const r = await run(db, 'A', grant('g3', 'jane@acme.io', NOW - 1800))
  assert.deepEqual(r.results.map(r => r.outcome), ['created'])
  assert.equal(await leadCount(db, 'A'), 1)
})

// R3: the tombstone holds no email and no name - only the tenant-salted hash and the withdrawal time.
bothEngines('R3: the withdrawal tombstone holds no email or name, only the salted key and time', async ({ db, kind, raw }) => {
  await recordConfig(db, 'A', CFG, 'actor-a', NOW)
  await run(db, 'A', grant('g1', 'jane@acme.io', NOW - 7200))
  await run(db, 'A', withdraw('w1', 'jane@acme.io', NOW - 3600))
  const ts = await tombstones(db, 'A')
  assert.equal(ts.length, 1)
  assert.match(ts[0].person_key, /^fp:p:[a-f0-9]{40}$/)
  assert.equal(Number(ts[0].withdrawn_at), NOW - 3600)
  const tables = kind === 'sqlite'
    ? (raw!.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(t => t.name)
    : (await db.all<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = current_schema()", [])).map(t => t.tablename)
  const dump: unknown[] = []
  for (const t of tables) dump.push(await db.all(`SELECT * FROM "${t}"`))
  assert.ok(!/jane/i.test(JSON.stringify(dump)), 'no trace of the email or name anywhere')
})

// R4: eraseFirstParty removes tombstones; retention purges them once the withdrawal is older than the recorded period.
bothEngines('R4: eraseFirstParty and retention remove tombstones', async ({ db }) => {
  await recordConfig(db, 'A', CFG, 'actor-a', NOW)
  await run(db, 'A', grant('g1', 'jane@acme.io', NOW - 7200))
  await run(db, 'A', withdraw('w1', 'jane@acme.io', NOW - 3600))
  assert.equal((await tombstones(db, 'A')).length, 1)
  await eraseFirstParty(db, 'A')
  assert.equal((await tombstones(db, 'A')).length, 0, 'erase removes the tombstone')
  await recordConfig(db, 'A', CFG, 'actor-a', NOW)
  await run(db, 'A', grant('g2', 'jane@acme.io', NOW - 7200))
  await run(db, 'A', withdraw('w2', 'jane@acme.io', NOW - 3600))
  await purgeFirstPartyRetention(db, { now: NOW + 91 * 86400 })
  assert.equal((await tombstones(db, 'A')).length, 0, 'retention purges the tombstone with the period')
})

// R5: tenant B's tombstone for the same email does not affect tenant A (the salt already differs; assert it).
bothEngines('R5: a tombstone in tenant B does not affect tenant A', async ({ db }) => {
  await recordConfig(db, 'A', CFG, 'actor-a', NOW)
  await recordConfig(db, 'B', { ...CFG, site_domain: 'other.test', privacy_url: 'https://other.test/p' }, 'actor-b', NOW)
  await run(db, 'B', grant('g1', 'jane@acme.io', NOW - 7200))
  await run(db, 'B', withdraw('w1', 'jane@acme.io', NOW - 3600))
  const [bt] = await tombstones(db, 'B')
  const r = await run(db, 'A', grant('g2', 'jane@acme.io', NOW - 7000))
  assert.deepEqual(r.results.map(r => r.outcome), ['created'])
  assert.equal(await leadCount(db, 'A'), 1)
  assert.notEqual(bt.person_key, (await tombstones(db, 'A')).length && '')
  const aKeys = (await tombstones(db, 'A')).map(t => t.person_key)
  assert.ok(!aKeys.includes(bt.person_key), 'per-tenant salt: keys are never shared')
})

// Concurrency (review clarification): a grant and a withdrawal for the same key in parallel requests settle to the
// withdrawal winning when the grant predates it - the end state has no lead and no event, on both engines.
bothEngines('concurrent grant + withdrawal for one key settle with no resurrection', async ({ db }) => {
  await recordConfig(db, 'A', CFG, 'actor-a', NOW)
  const g = run(db, 'A', grant('g1', 'jane@acme.io', NOW - 7200))
  const w = run(db, 'A', withdraw('w1', 'jane@acme.io', NOW - 3600))
  await Promise.all([g, w])
  assert.equal(await leadCount(db, 'A'), 0)
  assert.equal((await db.all("SELECT 1 FROM lead_enrichments WHERE tenant_id = 'A' AND connector = 'first_party'")).length, 0)
})
