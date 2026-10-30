// Fair service in the shared queue (lib/queue/db.ts, #355), on both engines: lanes, round-robin tenant order, per-tenant
// admission, dead-letter replay, stats and alerts. Synthetic tenants and kinds; the "work" is claim/complete only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { DbQueue } from '../lib/queue/db.ts'
import { LANES } from '../lib/queue/types.ts'
import { queueAlerts, DEFAULT_THRESHOLDS } from '../lib/queue/alerts.ts'
import { InProcessQueue } from '../lib/queue/memory.ts'
import { pgDb, type Db } from '../lib/db/client.ts'

const T0 = 1_800_000_000
const replies = { kinds: [...LANES.replies.kinds], lane: true, maxInFlight: LANES.replies.maxInFlight }
const research = { kinds: [...LANES.research.kinds], lane: true, maxInFlight: LANES.research.maxInFlight }

bothEngines('lanes: research holding every slot does not block a reply check; without a lane it would', async ({ db }) => {
  const q = new DbQueue(db, { rng: () => 0.5 })
  for (const t of ['A', 'B', 'C', 'D']) await q.enqueue({ tenantId: t, kind: 'scan', now: T0 })
  await q.enqueue({ tenantId: 'A', kind: 'reply-check', now: T0 + 1 })
  for (let i = 0; i < 3; i++) assert.ok(await q.claim({ ...research, now: T0 + 2, perTenantInFlight: 1 }))
  assert.equal(await q.claim({ ...research, now: T0 + 2 }), null, 'the research lane is full')
  // The old global caps: three claimed scans fill maxInFlight 3, so the reply check waits behind research.
  assert.equal(await q.claim({ kinds: [...LANES.replies.kinds], maxInFlight: 3, now: T0 + 2 }), null)
  // In its lane it is claimed at once, even though tenant A already holds a research claim.
  const r = await q.claim({ ...replies, now: T0 + 2 })
  assert.deepEqual([r?.item.kind, r?.item.tenantId], ['reply-check', 'A'])
  await assert.rejects(q.claim({ lane: true, now: T0 }), /needs kinds/)
})

bothEngines('round-robin: a tenant with a 60-item backlog cannot make another tenant wait behind it; FIFO would', async ({ db }) => {
  const drain = async (order: 'fifo' | 'round_robin') => {
    await db.run('DELETE FROM work_queue'); await db.run("DELETE FROM work_queue_meta WHERE k <> 'token'")
    const q = new DbQueue(db, { rng: () => 0.5 })
    for (let i = 0; i < 60; i++) await q.enqueue({ tenantId: 'A', kind: 'scan', id: `a${i}`, now: T0 + i })
    await q.enqueue({ tenantId: 'B', kind: 'scan', id: 'b0', now: T0 + 30 })
    await q.enqueue({ tenantId: 'C', kind: 'scan', id: 'c0', now: T0 + 59 })
    const served: string[] = []
    for (;;) { // one slot: claim, run, complete
      const c = await q.claim({ ...research, maxInFlight: 1, order, now: T0 + 100 })
      if (!c) break
      served.push(c.item.id); await q.complete(c.token)
    }
    return served
  }
  const fifo = await drain('fifo')
  assert.equal(fifo.indexOf('b0'), 31, 'FIFO: B waits for 31 of A\'s items (a30 ties on time and sorts first)')
  assert.equal(fifo.indexOf('c0'), 61)
  const rr = await drain('round_robin')
  assert.equal(rr.length, 62)
  assert.ok(rr.indexOf('b0') <= 2 && rr.indexOf('c0') <= 2, `round-robin serves B and C within the first turns: ${rr.slice(0, 4)}`)
  assert.deepEqual(rr.filter(x => x.startsWith('a')), Array.from({ length: 60 }, (_, i) => `a${i}`), 'A\'s own items stay in order')
})

// One simulated minute per round: four quiet tenants each ask for a reply check every minute and a scan every fifth
// minute, while one tenant has 300 scans queued first and a slow provider (ten minutes per scan). Research lets a tenant
// hold two slots. Returns how long the quiet tenants' work waited.
async function flood(db: Db, order: 'fifo' | 'round_robin', lanes = true) {
  const q = new DbQueue(db, { rng: () => 0.5 })
  let now = T0
  for (let i = 0; i < 300; i++) await q.enqueue({ tenantId: 'flood', kind: 'scan', now })
  const waits: Record<string, number[]> = { 'reply-check': [], scan: [] }
  const enqueuedAt = new Map<string, number>()
  const running: { token: number; until: number }[] = []
  for (let round = 0; round < 40; round++, now += 60) {
    for (const t of ['t1', 't2', 't3', 't4']) {
      const r = await q.enqueue({ tenantId: t, kind: 'reply-check', now }); enqueuedAt.set(r.id, now)
      if (round % 5 === 0) { const s = await q.enqueue({ tenantId: t, kind: 'scan', now }); enqueuedAt.set(s.id, now) }
    }
    // Finish what is due: the flood's scans take ten minutes (a slow provider), everything else one.
    for (const r of running.splice(0).filter(x => { if (x.until <= now) return true; running.push(x); return false })) await q.complete(r.token)
    // Without lanes: one worker pool of 3 for every kind, as the caps counted before this change.
    const pools = lanes ? [{ ...replies, perTenantInFlight: 1 }, { ...research, perTenantInFlight: 2 }] : [{ kinds: [...LANES.replies.kinds, ...LANES.research.kinds], maxInFlight: 3, perTenantInFlight: 2 }]
    for (const lane of pools) {
      for (;;) {
        const c = await q.claim({ ...lane, order, now })
        if (!c) break
        if (c.item.tenantId !== 'flood') waits[c.item.kind].push(now - enqueuedAt.get(c.item.id)!)
        running.push({ token: c.token, until: now + (c.item.tenantId === 'flood' ? 600 : 60) })
      }
    }
  }
  return waits
}

bothEngines('load: one tenant floods research with a slow backlog; with lanes and round-robin no other tenant\'s reply checks or scans are starved', async ({ db }) => {
  const rr = await flood(db, 'round_robin')
  assert.equal(rr['reply-check'].length, 160, 'every reply check was served')
  assert.equal(Math.max(...rr['reply-check']), 0, 'in its own lane, no reply check waited past its minute')
  assert.equal(rr.scan.length, 32, 'every quiet tenant\'s scan was served')
  assert.ok(Math.max(...rr.scan) <= 4 * 60, `a quiet tenant\'s scan waited at most four rounds (${Math.max(...rr.scan)}s)`)
  await db.run('DELETE FROM work_queue'); await db.run("DELETE FROM work_queue_meta WHERE k <> 'token'")
  // The same load with one shared pool (no lanes), FIFO: the reply checks queue behind research.
  const shared = await flood(db, 'fifo', false)
  // Measured: 32 of 160 reply checks served, the longest after 32 minutes; 8 of 32 quiet scans.
  assert.ok(shared['reply-check'].length <= 40, `without lanes most reply checks are never reached (${shared['reply-check'].length} of 160)`)
  assert.ok(Math.max(...shared['reply-check']) > 15 * 60, 'and those served waited past the 15-minute alert')
})

bothEngines('admission: a tenant\'s backlog of one kind is bounded; a refusal writes nothing and other tenants and kinds are unaffected', async ({ db }) => {
  const q = new DbQueue(db)
  for (let i = 0; i < 5; i++) assert.equal((await q.enqueue({ tenantId: 'A', kind: 'scan', maxBacklog: 5, now: T0 })).created, true)
  assert.deepEqual(await q.enqueue({ tenantId: 'A', kind: 'scan', maxBacklog: 5, now: T0 }), { id: '', created: false, refused: 'backlog' })
  assert.equal(await q.depth({ tenantId: 'A', kind: 'scan' }), 5)
  assert.equal((await q.enqueue({ tenantId: 'B', kind: 'scan', maxBacklog: 5, now: T0 })).created, true)
  assert.equal((await q.enqueue({ tenantId: 'A', kind: 'reply-check', maxBacklog: 5, now: T0 })).created, true)
  // A dedupe hit on an active item answers with that item even when the backlog is full.
  await db.run("DELETE FROM work_queue WHERE tenant_id = 'A' AND kind = 'scan' AND id = (SELECT id FROM work_queue WHERE tenant_id = 'A' AND kind = 'scan' ORDER BY id LIMIT 1)")
  const d1 = await q.enqueue({ tenantId: 'A', kind: 'scan', maxBacklog: 5, dedupeKey: 'k', now: T0 })
  const d2 = await q.enqueue({ tenantId: 'A', kind: 'scan', maxBacklog: 5, dedupeKey: 'k', now: T0 })
  assert.deepEqual([d1.created, d2.created, d2.id], [true, false, d1.id])
  // Finishing work makes room again.
  const c = (await q.claim({ kinds: ['scan'], tenants: ['A'], now: T0 }))!
  await q.complete(c.token)
  assert.equal((await q.enqueue({ tenantId: 'A', kind: 'scan', maxBacklog: 5, now: T0 })).created, true)
  await assert.rejects(q.enqueue({ tenantId: 'A', kind: 'scan', maxBacklog: -1 }), /non-negative/)
})

bothEngines('dead letters: failed items are listed and replayed with attempts reset; a stale token from the dead attempt cannot commit', async ({ db }) => {
  const q = new DbQueue(db, { rng: () => 0.5 })
  const { id } = await q.enqueue({ tenantId: 'A', kind: 'scan', maxAttempts: 1, now: T0 })
  const dead = (await q.claim({ kinds: ['scan'], now: T0 }))!
  assert.equal(await q.fail(dead.token, { error: 'provider_500', now: T0 }), 'failed')
  assert.deepEqual((await q.failed({ kind: 'scan' })).map(i => [i.id, i.lastError]), [[id, 'provider_500']])
  assert.equal(await q.replay(id, T0 + 10), true)
  assert.equal(await q.replay(id, T0 + 10), false, 'only a failed item replays')
  const again = (await q.claim({ kinds: ['scan'], now: T0 + 10 }))!
  assert.deepEqual([again.item.id, again.item.attempts], [id, 1])
  assert.equal(await q.complete(dead.token), false, 'the dead attempt\'s token is stale')
  assert.equal(await q.complete(again.token), true)
  assert.equal(await q.replay(id), false, 'a done item does not replay')
  assert.equal(await q.replay('nope'), false)
})

bothEngines('a worker that dies mid-claim: the lease runs out, the item is re-claimed once, and the dead token cannot write', async ({ db }) => {
  const q = new DbQueue(db, { rng: () => 0.5 })
  await q.enqueue({ tenantId: 'A', kind: 'reply-check', now: T0 })
  const dead = (await q.claim({ ...replies, leaseSeconds: 30, now: T0 }))!
  assert.equal(await q.claim({ ...replies, leaseSeconds: 30, now: T0 + 10 }), null, 'still leased')
  const stats = await q.stats(T0 + 31)
  assert.deepEqual(stats.map(s => [s.kind, s.claimed, s.expiredClaims]), [['reply-check', 1, 1]])
  assert.deepEqual(queueAlerts(stats).map(a => a.alert), ['expired_claims'])
  assert.equal(await q.reapExpired(T0 + 31), 1)
  const next = (await q.claim({ ...replies, leaseSeconds: 30, now: T0 + 31 + 60 }))! // past the backoff
  assert.ok(next && next.token !== dead.token)
  assert.equal(await q.fail(dead.token, { now: T0 + 100 }), 'stale')
  assert.equal(await q.complete(next.token), true)
})

bothEngines('stats and alerts: per-kind depth, oldest wait past not_before, dead letters; counts only', async ({ db }) => {
  const q = new DbQueue(db)
  await q.enqueue({ tenantId: 'A', kind: 'reply-check', now: T0 })
  await q.enqueue({ tenantId: 'B', kind: 'reply-check', now: T0 + 100, notBefore: T0 + 5000 }) // not yet due: no wait
  await q.enqueue({ tenantId: 'A', kind: 'scan', now: T0 })
  const s = await q.stats(T0 + 16 * 60)
  assert.deepEqual(s, [
    { kind: 'reply-check', pending: 2, claimed: 0, failed: 0, oldestPendingAgeS: 960, expiredClaims: 0 },
    { kind: 'scan', pending: 1, claimed: 0, failed: 0, oldestPendingAgeS: 960, expiredClaims: 0 },
  ])
  assert.deepEqual(queueAlerts(s), [{ kind: 'reply-check', alert: 'queue_age', value: 960, limit: 900 }], 'a scan may wait an hour, a reply check 15 minutes')
  assert.ok(!JSON.stringify(s).includes('"A"'))
  assert.deepEqual(queueAlerts([{ kind: 'scan', pending: 0, claimed: 0, failed: 21, oldestPendingAgeS: 0, expiredClaims: 0 }], DEFAULT_THRESHOLDS).map(a => a.alert), ['dead_letters'])
})

test('[pg] admission under concurrency: 30 racing enqueues from two instances admit exactly the backlog limit', { skip: !process.env.DAZL_TEST_PG_URL }, async () => {
  const { PG_URL, freshSchema } = await import('./helpers/pg-test.ts')
  const { runPgMigrations } = await import('../lib/db/migrate-pg.ts')
  const s = await freshSchema()
  const a = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 8 }), b = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 8 })
  try {
    await runPgMigrations(a.pool)
    const qa = new DbQueue(a), qb = new DbQueue(b)
    const r = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? qa : qb).enqueue({ tenantId: 'A', kind: 'scan', maxBacklog: 7, now: T0 })))
    assert.equal(r.filter(x => x.created).length, 7)
    assert.equal(await qa.depth({ tenantId: 'A' }), 7)
    // Two instances claiming round-robin in one lane never exceed its cap together.
    for (const t of ['B', 'C', 'D', 'E']) await qa.enqueue({ tenantId: t, kind: 'scan', now: T0 })
    const claims = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? qa : qb).claim({ ...research, order: 'round_robin', now: T0 + 1 })))
    assert.equal(claims.filter(Boolean).length, 3)
    assert.equal(new Set(claims.filter(Boolean).map(c => c!.item.tenantId)).size, 3, 'one per tenant')
  } finally { await a.close(); await b.close(); await s.drop() }
})

test('the in-process and SQLite adapters refuse lane, round-robin and admission options instead of ignoring them', () => {
  const q = new InProcessQueue()
  assert.throws(() => q.claim({ kinds: ['scan'], lane: true }), /DbQueue only/)
  assert.throws(() => q.claim({ order: 'round_robin' }), /DbQueue only/)
  assert.throws(() => q.enqueue({ tenantId: 'A', kind: 'scan', maxBacklog: 1 }), /DbQueue only/)
  assert.ok(q.claim({ order: 'fifo' }) === null)
})

bothEngines('readiness reports the queue alerts (kinds and counts only) and stays ready: a backlog is not a reason to leave rotation', async ({ db }) => {
  const { readiness } = await import('../lib/ops/health.ts')
  const q = new DbQueue(db)
  const old = Math.floor(Date.now() / 1000) - 3600
  await q.enqueue({ tenantId: 'tenant-secret-id', kind: 'reply-check', now: old })
  const r = await readiness({ db: async () => db, sqlite: () => ({ prepare: () => ({ get: () => 1 }) }), migrations: () => [] })
  assert.equal(r.checks.queue.ok, true)
  assert.deepEqual(r.queue?.alerts?.map(a => [a.kind, a.alert]), [['reply-check', 'queue_age']])
  assert.ok(!JSON.stringify(r).includes('tenant-secret-id'))
})
