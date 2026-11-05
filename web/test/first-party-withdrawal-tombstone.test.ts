// #390 / #618 review: a consent withdrawal must be REMEMBERED. Erasing the subject's leads is not enough: an
// older-dated `granted` event for the same person that arrives after the withdrawal (retry, delayed queue, backfill)
// must not resurrect the lead. The fix keeps a minimal tombstone per tenant + person key (the tenant-namespaced fp:p: hash and
// the withdrawal time - never the email or name), bounded by the tenant's recorded retention and erased by
// eraseFirstParty. Red on 172aaa1d: R1 resurrects (1 lead); R2/R5 pass; R3/R4 pin the new store.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { bothEngines, type EngineCtx } from './helpers/engines.ts'
import type { Db } from '../lib/db/client.ts'
import { ingest, recordConfig, eraseFirstParty, purgeFirstPartyRetention, signBody, readConfig, type FpConfigInput } from '../lib/signals/first-party.ts'

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

// R3: the tombstone holds no email and no name - only the tenant-namespaced hash and the withdrawal time.
bothEngines('R3: the withdrawal tombstone holds no email or name, only the namespaced key and time', async ({ db, kind, raw }) => {
  await recordConfig(db, 'A', CFG, 'actor-a', NOW)
  await run(db, 'A', grant('g1', 'jane@acme.io', NOW - 7200))
  await run(db, 'A', withdraw('w1', 'jane@acme.io', NOW - 3600))
  // Column-bound: the tombstone carries exactly the namespaced hash and two timestamps - no column can hold the email or
  // a name. (Absence of a string in a dump is not a privacy proof; the hash is itself pseudonymous personal data, bounded by
  // retention and erase - see the module header.)
  const ts = await tombstones(db, 'A')
  assert.equal(ts.length, 1)
  assert.deepEqual(Object.keys(ts[0]).sort(), ['person_key', 'withdrawn_at'])
  assert.match(ts[0].person_key, /^fp:p:[a-f0-9]{40}$/)
  assert.equal(Number(ts[0].withdrawn_at), NOW - 3600)
  const cols = kind === 'sqlite'
    ? (raw!.prepare("SELECT name FROM pragma_table_info('first_party_withdrawals')").all() as { name: string }[]).map(c => c.name).sort()
    : (await db.all<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'first_party_withdrawals' ORDER BY 1", [])).map(c => c.column_name)
  assert.deepEqual(cols, ['person_key', 'recorded_at', 'tenant_id', 'withdrawn_at'])
  // hygiene: the erased leads and events left nothing behind either
  assert.equal((await db.all("SELECT 1 FROM lead_enrichments WHERE tenant_id = 'A' AND connector = 'first_party'")).length, 0)
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

// R5: tenant B's tombstone for the same email does not affect tenant A (behavioral isolation; keys also differ by construction).
bothEngines('R5: a tombstone in tenant B does not affect tenant A', async ({ db }) => {
  await recordConfig(db, 'A', CFG, 'actor-a', NOW)
  await recordConfig(db, 'B', { ...CFG, site_domain: 'other.test', privacy_url: 'https://other.test/p' }, 'actor-b', NOW)
  await run(db, 'B', grant('g1', 'jane@acme.io', NOW - 7200))
  await run(db, 'B', withdraw('w1', 'jane@acme.io', NOW - 3600))
  const [bt] = await tombstones(db, 'B')
  const r = await run(db, 'A', grant('g2', 'jane@acme.io', NOW - 7000))
  assert.deepEqual(r.results.map(r => r.outcome), ['created'])
  assert.equal(await leadCount(db, 'A'), 1)
  const aKeys = (await tombstones(db, 'A')).map(t => t.person_key)
  assert.ok(!aKeys.includes(bt.person_key), 'keys derive from the tenant id, so they differ by construction; the isolation assertion above is behavioral, not this')
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

// R6: after retention purges the tombstone, a replayed grant dated at/before the withdrawal is still not accepted -
// it is older than the retention window and rejected:bad_time. Expiry cannot reopen resurrection.
bothEngines('R6: a grant replayed after the tombstone aged out is rejected:bad_time, not created', async ({ db }) => {
  await recordConfig(db, 'A', CFG, 'actor-a', NOW)
  await run(db, 'A', grant('g1', 'jane@acme.io', NOW - 7200))
  await run(db, 'A', withdraw('w1', 'jane@acme.io', NOW - 3600))
  const later = NOW + 91 * 86400
  await purgeFirstPartyRetention(db, { now: later })
  assert.equal((await tombstones(db, 'A')).length, 0)
  const raw = JSON.stringify({ events: [grant('g2', 'jane@acme.io', NOW - 7000)] })
  const r = await ingest(db, 'A', raw, signBody('s', later, raw), later)
  assert.deepEqual(r.results.map(x => x.outcome), ['rejected:bad_time'])
  assert.equal(await leadCount(db, 'A'), 0)
})

// R7: same-batch ordering, both directions: grant-then-withdrawal erases what the batch just made; withdrawal-then-
// older-grant is refused by the tombstone written earlier in the same transaction.
bothEngines('R7: grant and withdrawal in ONE batch settle with no resurrection, either order', async ({ db }) => {
  await recordConfig(db, 'A', CFG, 'actor-a', NOW)
  const r1 = await run(db, 'A', grant('g1', 'jane@acme.io', NOW - 7200), withdraw('w1', 'jane@acme.io', NOW - 3600))
  assert.deepEqual(r1.results.map(x => x.outcome), ['created', 'withdrawn'])
  assert.equal(await leadCount(db, 'A'), 0)
  const r2 = await run(db, 'A', withdraw('w2', 'sam@corp.io', NOW - 3600), grant('g2', 'sam@corp.io', NOW - 7000))
  assert.deepEqual(r2.results.map(x => x.outcome), ['withdrawn', 'not_consented'])
  assert.equal(await leadCount(db, 'A'), 0)
  assert.equal((await db.all("SELECT 1 FROM lead_enrichments WHERE tenant_id = 'A' AND connector = 'first_party'")).length, 0)
})

const d = 86400

// (a) A FUTURE-dated withdrawal is clamped to the receipt time: it must not block later-dated grants forever nor
// outlive the retention purge. Red before the clamp: withdrawn_at stored as the claimed future time.
bothEngines('(a) a future-dated withdrawal is clamped to now; a grant within the replay window after now still creates', async ({ db }) => {
  await recordConfig(db, 'A', CFG, 'actor-a', NOW)
  const w = await run(db, 'A', withdraw('w1', 'jane@acme.io', NOW + 1000))
  assert.deepEqual(w.results.map(r => r.outcome), ['withdrawn'])
  const [t] = await tombstones(db, 'A')
  assert.equal(Number(t.withdrawn_at), NOW, 'clamped to receipt time, not the claimed future')
  const r = await run(db, 'A', grant('g1', 'jane@acme.io', NOW + 200))
  assert.deepEqual(r.results.map(x => x.outcome), ['created'])
  await purgeFirstPartyRetention(db, { now: NOW + 91 * d })
  assert.equal((await tombstones(db, 'A')).length, 0)
})

// (b) Repeated withdrawals keep the LATEST withdrawal time; an older replay never moves it backwards (the upsert
// must be portable SQL: two-argument MAX is SQLite-only; PG runs this in CI).
bothEngines('(b) a repeated withdrawal keeps the latest time; an older replay is ignored', async ({ db }) => {
  await recordConfig(db, 'A', CFG, 'actor-a', NOW)
  await run(db, 'A', withdraw('w1', 'jane@acme.io', NOW - 3600))
  await run(db, 'A', withdraw('w2', 'jane@acme.io', NOW - 1800))
  let [t] = await tombstones(db, 'A')
  assert.equal(Number(t.withdrawn_at), NOW - 1800)
  await run(db, 'A', withdraw('w3', 'jane@acme.io', NOW - 7000))
  t = (await tombstones(db, 'A'))[0]
  assert.equal(Number(t.withdrawn_at), NOW - 1800, 'an older-dated replay never moves the tombstone backwards')
})

// (c1) Retention RAISED before the tombstone purges: the tombstone must live by the highest retention the tenant has
// recorded, or a grant dated inside the raised window resurrects the subject. Red without max-ever retention.
bothEngines('(c1) a retention raise before purge does not resurrect: the tombstone lives by the highest recorded retention', async ({ db }) => {
  await recordConfig(db, 'A', CFG, 'actor-a', NOW) // 90d
  await run(db, 'A', grant('g1', 'jane@acme.io', NOW - 50 * d))
  await run(db, 'A', withdraw('w1', 'jane@acme.io', NOW))
  await recordConfig(db, 'A', { ...CFG, retention_days: 180 }, 'actor-a', NOW + 50 * d) // raise before any purge
  const later = NOW + 95 * d // past the OLD 90d purge horizon, inside the raised 180d
  await purgeFirstPartyRetention(db, { now: later })
  assert.equal((await tombstones(db, 'A')).length, 1, 'the raised retention still covers the withdrawal')
  const raw = JSON.stringify({ events: [grant('g2', 'jane@acme.io', NOW - 50 * d)] })
  const r = await ingest(db, 'A', raw, signBody('s', later, raw), later)
  assert.notEqual(r.results[0].outcome, 'created')
  assert.equal(await leadCount(db, 'A'), 0)
})

// (d) Multi-key batches in OPPOSITE key orders concurrently: deterministic sorted lock acquisition must serialize
// them without deadlock. On SQLite the driver serializes; the real deadlock probe is the PG half in CI (pool >= 2).
bothEngines('(d) concurrent multi-key batches in opposite orders settle without deadlock or resurrection', async ({ db }) => {
  await recordConfig(db, 'A', CFG, 'actor-a', NOW)
  const b1 = run(db, 'A', withdraw('wa', 'a@x.io', NOW - 3600), grant('ga', 'a@x.io', NOW - 7000), withdraw('wb', 'b@y.io', NOW - 3600), grant('gb', 'b@y.io', NOW - 7000))
  const b2 = run(db, 'A', grant('gb2', 'b@y.io', NOW - 7000), withdraw('wb2', 'b@y.io', NOW - 3600), grant('ga2', 'a@x.io', NOW - 7000), withdraw('wa2', 'a@x.io', NOW - 3600))
  const [r1, r2] = await Promise.all([b1, b2])
  for (const r of [r1, r2]) assert.equal(r.status, 'ok')
  assert.equal(await leadCount(db, 'A'), 0)
  assert.equal((await db.all("SELECT 1 FROM lead_enrichments WHERE tenant_id = 'A' AND connector = 'first_party'")).length, 0)
}, { pgMax: 2 })

// (c2) Retention RAISED AFTER the tombstone purged: without a prospective-acceptance floor the raised window reopens
// already-expired events and a pre-withdrawal grant resurrects the subject. Red before the floor.
bothEngines('(c2) a retention raise after purge does not reopen already-expired events: no resurrection', async ({ db }) => {
  await recordConfig(db, 'A', CFG, 'actor-a', NOW) // 90d
  await run(db, 'A', grant('g1', 'jane@acme.io', NOW - 50 * d))
  await run(db, 'A', withdraw('w1', 'jane@acme.io', NOW))
  const purged = NOW + 91 * d
  await purgeFirstPartyRetention(db, { now: purged })
  assert.equal((await tombstones(db, 'A')).length, 0, 'the tombstone aged out under the 90d period')
  await recordConfig(db, 'A', { ...CFG, retention_days: 180 }, 'actor-a', purged + d) // raised after the purge
  const arrive = purged + 2 * d
  const raw = JSON.stringify({ events: [grant('g2', 'jane@acme.io', NOW - 50 * d)] }) // inside the raised 180d window
  const r = await ingest(db, 'A', raw, signBody('s', arrive, raw), arrive)
  assert.notEqual(r.results[0].outcome, 'created', 'an already-expired event must stay expired across a retention raise')
  assert.equal(await leadCount(db, 'A'), 0)
})

// (e) The acceptance floor is monotonic under CONCURRENT and STALE config writes: two re-records racing (the higher
// candidate must survive regardless of commit order) and a re-record with a stale `now` (floor never moves back).
// Red pre-fix: recordConfig reads the previous config OUTSIDE its transaction, so the loser of the race can write
// the smaller floor last.
bothEngines('(e) concurrent and stale config writes keep the acceptance floor monotonic', async ({ db }) => {
  await recordConfig(db, 'A', CFG, 'actor-a', NOW) // 90d, no floor yet
  const floorOf = async () => (await readConfig(db, 'A'))!.config.accept_floor ?? 0
  const raise = recordConfig(db, 'A', { ...CFG, retention_days: 180 }, 'actor-a', NOW + 20_000)
  const lower = recordConfig(db, 'A', { ...CFG, retention_days: 30 }, 'actor-a', NOW + 10_000)
  await Promise.all([raise, lower]) // started in this order: pre-fix the smaller floor (lower's) lands last
  const want = NOW + 20_000 - 90 * d // the higher candidate, from the previous 90d window edge
  assert.equal(await floorOf(), want, 'the smaller racing candidate must never overwrite the larger floor')
  // stale execution: a re-record whose clock is behind moves nothing BACK - it can only keep or advance the floor
  // (the floor never drops below any previously committed value, so non-resurrection boundaries never reopen)
  await recordConfig(db, 'A', { ...CFG, retention_days: 30 }, 'actor-a', NOW + 5_000)
  const afterStale = Math.max(want, NOW + 5_000 - 30 * d)
  assert.equal(await floorOf(), afterStale, 'a stale now never lowers the floor')
  // and the floor still moves forward honestly when a later re-record's own window edge is ahead
  await recordConfig(db, 'A', { ...CFG, retention_days: 60 }, 'actor-a', NOW + 40 * d)
  assert.equal(await floorOf(), Math.max(afterStale, NOW + 40 * d - 30 * d)) // prev period is the stale write's 30d
})
