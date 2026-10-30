// The tick's per-tenant work on the shared queue (lib/queue/tick-work.ts, #355), on both engines: durable carry-over
// between ticks, round-robin across tenants, a failing tenant isolated and dead-lettered, a dead tick's claim reaped,
// and a lost lease stopping the drain without touching its claim. Synthetic tenants; the handlers only record calls
// and advance a fake clock, nothing is fetched or sent.
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { DbQueue } from '../lib/queue/db.ts'
import { drainTickWork, enqueueTickWork, TICK_ITEM_LEASE_S, type TickHandler } from '../lib/queue/tick-work.ts'

const T0 = 1_800_000_000
const MIN = 60_000
class Fence extends Error {}

// A fake clock shared by the drain (ms) and the queue (s); handlers spend time by advancing it.
function sim(db: ConstructorParameters<typeof DbQueue>[0]) {
  let ms = T0 * 1000
  const q = new DbQueue(db, { rng: () => 0.5 })
  const served: string[] = []
  const spend: Record<string, number> = {}
  const handler = (kind: string): TickHandler => async id => { served.push(`${kind}:${id}`); ms += spend[id] ?? MIN }
  const handlers = { followup: handler('followup'), sequence: handler('sequence') }
  const tick = async (due: string[], budgetMs = 10 * MIN, h = handlers) => {
    await enqueueTickWork(q, [{ kind: 'followup', tenantIds: due }], Math.floor(ms / 1000))
    return drainTickWork(q, h, { budgetMs, clock: () => ms, now: () => Math.floor(ms / 1000), isFenceError: e => e instanceof Fence })
  }
  return { q, served, spend, handlers, tick, advance: (d: number) => { ms += d }, nowS: () => Math.floor(ms / 1000) }
}

bothEngines('a slow tenant spends the budget; the others carry over and go first next tick, nothing lost or doubled', async ({ db }) => {
  const s = sim(db)
  s.spend.A = 12 * MIN // one tenant whose reply sync is slow (more than a whole budget)
  const due = ['A', 'B', 'C', 'D', 'E']
  await enqueueTickWork(s.q, [{ kind: 'followup', tenantIds: ['A'] }], s.nowS() - 10) // the slow tenant is queued first
  const r1 = await s.tick(due)
  assert.equal(r1.stoppedBy, 'budget')
  const first = [...s.served], left = due.filter(t => !first.includes(`followup:${t}`))
  assert.deepEqual(first, ['followup:A'], 'the budget ran out on the slow tenant with the others still queued')
  assert.equal(await s.q.depth({ kind: 'followup', status: 'pending' }), left.length, 'the rest stay queued')
  // The next tick re-enqueues every due tenant: the carried-over items answer the dedupe, the served ones get fresh
  // items, and round-robin serves the tenants left over first.
  s.advance(5 * MIN)
  s.served.length = 0
  const r2 = await s.tick(due)
  assert.deepEqual(s.served.slice(0, left.length).sort(), left.map(t => `followup:${t}`))
  assert.ok(r2.done >= left.length)
  assert.equal(new Set(s.served).size, s.served.length, 'no tenant twice in one tick')
  assert.equal(await s.q.depth({ kind: 'followup', status: 'claimed' }), 0)
})

bothEngines('round-robin across ticks: with a budget for two tenants a tick, every tenant is served within three ticks', async ({ db }) => {
  const s = sim(db)
  for (const t of ['A', 'B', 'C', 'D', 'E', 'F']) s.spend[t] = 5 * MIN
  const lastServed: Record<string, number> = {}
  for (let k = 0; k < 9; k++) {
    s.served.length = 0
    await s.tick(['A', 'B', 'C', 'D', 'E', 'F'], 10 * MIN)
    assert.equal(s.served.length, 2, `tick ${k} serves two`)
    for (const x of s.served) lastServed[x] = k
    s.advance(MIN)
    if (k >= 2) for (const t of ['A', 'B', 'C', 'D', 'E', 'F']) assert.ok(k - lastServed[`followup:${t}`] < 3, `tick ${k}: ${t} waited three ticks`)
  }
})

bothEngines('a failing tenant is retried with backoff and dead-lettered; the others are served every tick', async ({ db }) => {
  const s = sim(db)
  const failing = { ...s.handlers, followup: async (id: string, c: Parameters<TickHandler>[1]) => { if (id === 'B') throw new Error('synthetic provider error'); await s.handlers.followup(id, c) } }
  const errors: string[] = []
  for (let k = 0; k < 6; k++) {
    s.served.length = 0
    await enqueueTickWork(s.q, [{ kind: 'followup', tenantIds: ['A', 'B', 'C'] }], s.nowS())
    await drainTickWork(s.q, failing, { budgetMs: 30 * MIN, clock: () => s.nowS() * 1000, now: s.nowS, onError: (e, item) => errors.push(`${item.tenantId}:${(e as Error).message}`) })
    assert.ok(s.served.includes('followup:A') && s.served.includes('followup:C'), `tick ${k}: A and C served`)
    s.advance(60 * MIN) // past any backoff
  }
  const dead = await s.q.failed({ kind: 'followup' })
  assert.ok(dead.length >= 1 && dead.every(d => d.tenantId === 'B' && d.lastError === 'synthetic provider error'))
  assert.ok(errors.length >= 3 && errors.every(e => e === 'B:synthetic provider error'))
  // Replay puts the dead letter back.
  assert.equal(await s.q.replay(dead[0].id, s.nowS()), true)
})

bothEngines('a lost lease stops the drain and leaves the claim; a dead tick\'s claim is reaped and served by a later tick', async ({ db }) => {
  const s = sim(db)
  const lost = { ...s.handlers, followup: async (id: string) => { if (id === 'A') throw new Fence('lease lost'); s.served.push(`followup:${id}`) } }
  await enqueueTickWork(s.q, [{ kind: 'followup', tenantIds: ['A'] }], s.nowS() - 10) // A is queued first
  await assert.rejects(s.tick(['A', 'B'], 10 * MIN, lost), Fence)
  assert.deepEqual(s.served, [], 'nothing after the lost lease')
  const a = (await db.all<{ status: string; tenant_id: string }>("SELECT status, tenant_id FROM work_queue WHERE kind = 'followup' ORDER BY tenant_id")).map(r => `${r.tenant_id}:${r.status}`)
  assert.deepEqual(a, ['A:claimed', 'B:pending'], 'the claim is not completed or failed by a tick that lost the store')
  // Before the item lease runs out A stays held (one in flight per tenant); B is served.
  s.advance(MIN)
  await s.tick(['A', 'B'])
  assert.deepEqual(s.served, ['followup:B'])
  // After it, the dead claim is reaped (backoff) and a later tick serves A once.
  s.advance((TICK_ITEM_LEASE_S + 3600) * 1000)
  s.served.length = 0
  await s.tick(['A', 'B'])
  assert.deepEqual(s.served.filter(x => x === 'followup:A'), ['followup:A'])
})

bothEngines('enqueue is one active item per tenant and kind, whatever the tick count', async ({ db }) => {
  const q = new DbQueue(db)
  for (let i = 0; i < 3; i++) await enqueueTickWork(q, [{ kind: 'followup', tenantIds: ['A', 'A', 'B'] }, { kind: 'sequence', tenantIds: ['A'] }], T0 + i)
  assert.equal(await q.depth({ status: 'pending' }), 3)
  assert.equal(await q.depth({ tenantId: 'A', kind: 'followup' }), 1)
})

bothEngines('round-robin, not FIFO: a tenant with follow-ups and sequences due does not take two turns while another waits', async ({ db }) => {
  const s = sim(db)
  s.spend.A = 10 * MIN; s.spend.B = 10 * MIN // one item fits each tick's budget
  await enqueueTickWork(s.q, [{ kind: 'followup', tenantIds: ['A'] }, { kind: 'sequence', tenantIds: ['A'] }], s.nowS() - 20)
  await enqueueTickWork(s.q, [{ kind: 'followup', tenantIds: ['B'] }], s.nowS() - 10)
  await s.tick(['A', 'B'])
  assert.equal(s.served.length, 1); assert.match(s.served[0], /:A$/)
  s.served.length = 0
  await s.tick(['A', 'B'])
  // FIFO would serve A's other (older) item here and make B wait a second tick.
  assert.deepEqual(s.served, ['followup:B'])
})
