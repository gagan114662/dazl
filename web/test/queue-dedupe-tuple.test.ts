// #909: the reference InProcessQueue must scope dedupe keys by the exact (tenantId, kind, dedupeKey) tuple, like the
// durable adapters' (tenant_id, kind, dedupe_key) unique index. A plain string concatenation let ('a','bc','d') and
// ('ab','c','d') collide, suppressing the second tenant's work and returning the first tenant's item id.
import test from 'node:test'
import assert from 'node:assert/strict'
import { InProcessQueue } from '../lib/queue/memory.ts'
import { DbQueue } from '../lib/queue/db.ts'
import type { EnqueueInput, EnqueueResult, Claim, FailOptions, FailOutcome } from '../lib/queue/types.ts'
import { bothEngines } from './helpers/engines.ts'

const T0 = 1_800_000_000

// Minimal async view over both adapters so one scenario runs against each.
interface Q {
  enqueue(i: EnqueueInput): Promise<EnqueueResult>
  claim(o: Parameters<InProcessQueue['claim']>[0]): Promise<Claim | null>
  complete(token: number): Promise<boolean>
  fail(token: number, o?: FailOptions): Promise<FailOutcome>
  depth(o: { tenantId?: string; kind?: string }): Promise<number>
}
const mem = (): Q => {
  const q = new InProcessQueue({ rng: () => 0.5 })
  return {
    enqueue: async (i) => q.enqueue(i),
    claim: async (o) => q.claim(o),
    complete: async (t) => q.complete(t),
    fail: async (t, o) => q.fail(t, o),
    depth: async (o) => q.depth(o),
  }
}

// Tuples that a naive concatenation (with or without a delimiter) would merge.
const COLLIDING: ReadonlyArray<readonly [EnqueueInput, EnqueueInput]> = [
  // boundary shift between tenant and kind
  [{ tenantId: 'a', kind: 'bc', dedupeKey: 'd' }, { tenantId: 'ab', kind: 'c', dedupeKey: 'd' }],
  // boundary shift between kind and key
  [{ tenantId: 't', kind: 'ab', dedupeKey: 'c' }, { tenantId: 't', kind: 'a', dedupeKey: 'bc' }],
  // a delimiter inside the values: 'x:y' + ':' + 'z' vs 'x' + ':' + 'y:z'
  [{ tenantId: 'x:y', kind: 'k', dedupeKey: 'z' }, { tenantId: 'x', kind: 'y:k', dedupeKey: 'z' }],
  [{ tenantId: 't', kind: 'a\u0000b', dedupeKey: 'c' }, { tenantId: 't', kind: 'a', dedupeKey: 'b\u0000c' }],
  // same tenant, different kind, same key
  [{ tenantId: 't', kind: 'monitor', dedupeKey: 'k1' }, { tenantId: 't', kind: 'sequence', dedupeKey: 'k1' }],
]

async function scenario(make: () => Q): Promise<void> {
  for (const [a, b] of COLLIDING) {
    const q = make()
    const ra = await q.enqueue({ ...a, id: 'first', now: T0 })
    const rb = await q.enqueue({ ...b, id: 'second', now: T0 })
    assert.deepEqual(ra, { id: 'first', created: true })
    assert.deepEqual(rb, { id: 'second', created: true }, `distinct tuple suppressed: ${JSON.stringify([a, b])}`)
    assert.equal(await q.depth({ tenantId: b.tenantId, kind: b.kind }), 1)
    // the same tuple still dedupes to its own item
    assert.deepEqual(await q.enqueue({ ...a, id: 'first-dup', now: T0 }), { id: 'first', created: false })
    assert.deepEqual(await q.enqueue({ ...b, id: 'second-dup', now: T0 }), { id: 'second', created: false })
  }

  // completion releases only the completed tuple; the neighbour keeps deduping
  {
    const q = make()
    const [a, b] = COLLIDING[0]
    await q.enqueue({ ...a, id: 'first', now: T0 })
    await q.enqueue({ ...b, id: 'second', now: T0 + 1 })
    const c = (await q.claim({ now: T0 + 5, tenants: [a.tenantId], perTenantInFlight: 5 }))!
    assert.equal(c.item.id, 'first')
    assert.equal(await q.complete(c.token), true)
    assert.deepEqual(await q.enqueue({ ...a, id: 'first-next', now: T0 + 6 }), { id: 'first-next', created: true })
    assert.deepEqual(await q.enqueue({ ...b, id: 'second-dup', now: T0 + 6 }), { id: 'second', created: false })
  }

  // terminal failure releases only the failed tuple
  {
    const q = make()
    const [a, b] = COLLIDING[1]
    await q.enqueue({ ...a, id: 'first', now: T0 })
    await q.enqueue({ ...b, id: 'second', now: T0 + 1 })
    const c = (await q.claim({ now: T0 + 5, tenants: [b.tenantId], kinds: [b.kind], perTenantInFlight: 5 }))!
    assert.equal(c.item.id, 'second')
    assert.equal(await q.fail(c.token, { retryable: false, error: 'x', now: T0 + 6 }), 'failed')
    assert.deepEqual(await q.enqueue({ ...b, id: 'second-next', now: T0 + 7 }), { id: 'second-next', created: true })
    assert.deepEqual(await q.enqueue({ ...a, id: 'first-dup', now: T0 + 7 }), { id: 'first', created: false })
  }
}

test('InProcessQueue: dedupe tuple is collision-safe (#909)', async () => {
  await scenario(mem)
})

// Parity: the durable adapter gives the same answers for the same scenarios.
bothEngines('DbQueue parity: dedupe tuple is collision-safe (#909)', async ({ db }) => {
  await scenario(() => {
    // fresh ids per scenario on one shared DB would collide, so isolate each make() by tenant prefix
    const q = new DbQueue(db, { rng: () => 0.5 })
    const p = `p${Math.random().toString(36).slice(2, 8)}-`
    const pre = (i: EnqueueInput): EnqueueInput => ({ ...i, id: i.id ? p + i.id : undefined, tenantId: p + i.tenantId })
    const un = (r: EnqueueResult): EnqueueResult => ({ ...r, id: r.id.startsWith(p) ? r.id.slice(p.length) : r.id })
    return {
      enqueue: async (i) => un(await q.enqueue(pre(i))),
      claim: async (o) => {
        const c = await q.claim({ ...o, tenants: o?.tenants?.map((t) => p + t) ?? undefined, kinds: o?.kinds })
        if (!c) return c
        return { ...c, item: { ...c.item, id: c.item.id.slice(p.length), tenantId: c.item.tenantId.slice(p.length) } }
      },
      complete: (t) => q.complete(t),
      fail: (t, o) => q.fail(t, o),
      depth: (o) => q.depth({ ...o, tenantId: o.tenantId ? p + o.tenantId : undefined }),
    }
  })
})
