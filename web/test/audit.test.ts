// Durable audit trail (lib/audit.ts, #371), on both engines: append-only in the database, redacted summaries,
// searches scoped to one workspace, and Stripe's plan changes recorded in the transaction that applies them.
// Synthetic rows only; nothing is fetched or sent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { AUDIT_RETENTION_MIN_DAYS, auditRetention, cursorOf, parseCursor, purgeAudit, record, redact, searchAudit } from '../lib/audit.ts'
import { applyStripeEvent, type StripeEvent } from '../lib/billing/stripe.ts'
import { readPlan } from '../lib/plans.ts'
import type { Db } from '../lib/db/client.ts'
import { bothEngines } from './helpers/engines.ts'
import { setErrorSinks, type ErrorRecord } from '../lib/ops/errors.ts'
import { StaleLeaseWrite, tryLease } from '../lib/shared/lease.ts'
import { randomBytes } from 'node:crypto'

const NOW = Math.floor(Date.now() / 1000)
const DAY = 24 * 60 * 60
const all = (db: Db) => db.all<Record<string, unknown>>('SELECT * FROM audit_events')
const T = 'a'.repeat(32)
const ev = (id: string, type: string, created: number, object: StripeEvent['data']['object']): StripeEvent => ({ id, type, created, data: { object } })

bothEngines('events are append-only in the database; only the retention purge deletes, and only old events', async ({ db }) => {
  await record(db, { tenantId: 'A', actorId: 'A', action: 'x.old', resourceType: 't' }, NOW - 400 * DAY - 10)
  await record(db, { tenantId: 'A', actorId: 'A', action: 'x.new', resourceType: 't' }, NOW)
  await assert.rejects(db.run("UPDATE audit_events SET action = 'tampered'"))
  await assert.rejects(db.run("UPDATE audit_events SET tenant_id = 'B'"))
  await assert.rejects(db.run('DELETE FROM audit_events'))
  assert.equal((await all(db)).length, 2)
  assert.equal(await purgeAudit(db, { now: NOW, retainS: 400 * DAY }), 1)
  assert.deepEqual((await searchAudit(db, 'A')).map(e => e.action), ['x.new'])
  assert.equal((await db.all('SELECT * FROM audit_purge_gate')).length, 0, 'the gate exists only inside the purge')
  await assert.rejects(db.run('DELETE FROM audit_events'), 'still append-only after a purge')
  // Postgres row triggers do not see TRUNCATE; its own statement trigger refuses it (SQLite has no TRUNCATE)
  if (db.kind === 'pg') await assert.rejects(db.run('TRUNCATE audit_events'), /append-only/)
  assert.equal((await all(db)).length, 1)
})

test('automatic deletion is off until the owner sets an explicit period; off and invalid never purge', () => {
  // unset, empty, off and 0 are off: the deployed default
  for (const v of [undefined, '', '  ', 'off', 'OFF', 'Off', '0']) assert.deepEqual(auditRetention({ AUDIT_RETENTION_DAYS: v }), { state: 'off' }, JSON.stringify(v))
  assert.deepEqual(auditRetention({}), { state: 'off' })
  // not a whole number of days of at least the floor: invalid, which purges nothing either (the tick reports it)
  for (const v of ['abc', '-5', '1.5', '400d', '0x10', '1e3', ' 29', String(AUDIT_RETENTION_MIN_DAYS - 1), '00', '007', '123456', 'true', 'null']) assert.deepEqual(auditRetention({ AUDIT_RETENTION_DAYS: v }), { state: 'invalid' }, v)
  // an explicit choice
  assert.deepEqual(auditRetention({ AUDIT_RETENTION_DAYS: String(AUDIT_RETENTION_MIN_DAYS) }), { state: 'on', days: AUDIT_RETENTION_MIN_DAYS, retainS: AUDIT_RETENTION_MIN_DAYS * DAY })
  assert.deepEqual(auditRetention({ AUDIT_RETENTION_DAYS: ' 400 ' }), { state: 'on', days: 400, retainS: 400 * DAY })
})

bothEngines('the purge refuses a missing or too-short period, and a lost lease fence inside its transaction deletes nothing and leaves no gate', async ({ db }) => {
  await record(db, { tenantId: 'A', actorId: 'A', action: 'x.old', resourceType: 't' }, NOW - 1000 * DAY)
  await record(db, { tenantId: 'A', actorId: 'A', action: 'x.new', resourceType: 't' }, NOW)
  for (const retainS of [undefined, 0, -1, 1.5, NaN, (AUDIT_RETENTION_MIN_DAYS - 1) * DAY]) {
    await assert.rejects(purgeAudit(db, { now: NOW, retainS: retainS as number }), /explicit retention period/, String(retainS))
  }
  // the fence runs first, in the purge's own transaction: a refused fence rolls the whole purge back
  await assert.rejects(purgeAudit(db, { now: NOW, retainS: 400 * DAY, fence: function* () { throw new Error('lost lease') } }), /lost lease/)
  assert.deepEqual((await searchAudit(db, 'A')).map(e => e.action), ['x.new', 'x.old'])
  assert.equal((await db.all('SELECT * FROM audit_purge_gate')).length, 0, 'no gate row left behind by the refused purge')
  await assert.rejects(db.run('DELETE FROM audit_events'), 'still append-only')
  // the same period with a passing fence is the fenced, bounded path a future policy uses
  assert.equal(await purgeAudit(db, { now: NOW, retainS: 400 * DAY, fence: function* () { /* lease held */ } }), 1)
  assert.deepEqual((await searchAudit(db, 'A')).map(e => e.action), ['x.new'])
})

bothEngines('a summary that does not parse is reported and read as unreadable, never silently empty', async ({ db }) => {
  await record(db, { tenantId: 'A', actorId: 'A', action: 'x.fine', resourceType: 't', summary: { n: 1 } }, NOW - 1)
  await db.run("INSERT INTO audit_events (id, tenant_id, actor_id, actor_kind, action, resource_type, decision, summary, at, seq) VALUES (?, 'A', 'A', 'user', 'x.corrupt', 't', 'allowed', 'not json', ?, 1)", ['c'.repeat(24), NOW])
  const caught: ErrorRecord[] = []
  const restore = setErrorSinks([r => { caught.push(r) }])
  try {
    assert.deepEqual((await searchAudit(db, 'A')).map(e => [e.action, e.summary]), [['x.corrupt', { unreadable: true }], ['x.fine', { n: 1 }]])
  } finally { restore() }
  assert.deepEqual(caught.map(r => r.where), ['audit:summary'])
})

// From the adversarial probe of the PR (kept as permanent tests): the purge under the REAL lease, as the tick runs it.
const count = async (db: Db) => Number((await db.get<{ n: number | string }>('SELECT count(*) AS n FROM audit_events'))!.n)
const gateRows = async (db: Db) => Number((await db.get<{ n: number | string }>('SELECT count(*) AS n FROM audit_purge_gate'))!.n)
const bulk = (db: Db, tenant: string, n: number, at: (i: number) => number) => db.tx(function* (t) {
  for (let i = 0; i < n; i++) yield* t.run("INSERT INTO audit_events (id, tenant_id, actor_id, actor_kind, action, resource_type, decision, summary, at, seq) VALUES (?, ?, ?, 'user', 'x.bulk', 't', 'allowed', '{}', ?, 0)", [randomBytes(12).toString('hex'), tenant, tenant, at(i)])
})
const LEASE = { ttlMs: 60_000, stepBudgetMs: 1000, heartbeat: false as const }

bothEngines('two purges at once under one real lease: each bounded to 1000, no gate row left, still append-only, fresh events untouched', async ({ db }) => {
  await bulk(db, 'A', 2500, i => NOW - 500 * DAY + i)
  await record(db, { tenantId: 'A', actorId: 'A', action: 'x.fresh', resourceType: 't' }, NOW)
  const lease = (await tryLease(db, 'internal-tick', LEASE))!
  try {
    const fence = (t: Parameters<typeof lease.fence>[0]) => lease.fence(t)
    const results = await Promise.allSettled([purgeAudit(db, { now: NOW, retainS: 400 * DAY, fence }), purgeAudit(db, { now: NOW, retainS: 400 * DAY, fence })])
    // one may be refused by the engine's locking; whichever ran deleted at most its bound, and the rows gone match
    for (const r of results) if (r.status === 'fulfilled') assert.ok(r.value <= 1000, 'bounded')
    const total = results.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value : 0), 0)
    assert.ok(total >= 1000 && total <= 2000, `deleted ${total}`)
    assert.equal(await count(db), 2501 - total, 'the deleted count matches the rows gone')
    assert.equal(await gateRows(db), 0)
    await assert.rejects(db.run('DELETE FROM audit_events'), /append-only/)
    assert.deepEqual((await searchAudit(db, 'A', { limit: 1 })).map(e => e.action), ['x.fresh'])
  } finally { await lease.release() }
})

bothEngines('the lease taken over before the purge: the old holder is refused inside the transaction, nothing deleted, no gate; the new holder purges once', async ({ db }) => {
  await bulk(db, 'A', 5, i => NOW - 500 * DAY + i)
  let clock = 1_000_000
  const l1 = (await tryLease(db, 'internal-tick', { ...LEASE, clock: () => clock }))!
  clock += LEASE.ttlMs + 1 // l1 expired; a second tick takes over
  const l2 = (await tryLease(db, 'internal-tick', { ...LEASE, clock: () => clock }))!
  try {
    assert.equal(l2.generation, l1.generation + 1)
    await assert.rejects(purgeAudit(db, { now: NOW, retainS: 400 * DAY, fence: t => l1.fence(t) }), (e: unknown) => e instanceof StaleLeaseWrite)
    assert.equal(await count(db), 5)
    assert.equal(await gateRows(db), 0)
    assert.equal(await purgeAudit(db, { now: NOW, retainS: 400 * DAY, fence: t => l2.fence(t) }), 5)
  } finally { await l2.release() }
})

bothEngines('the gate table gone: the purge is refused and deletes nothing, and a plain DELETE is still refused (fails closed)', async ({ db }) => {
  await bulk(db, 'A', 3, i => NOW - 500 * DAY + i)
  await db.run('DROP TABLE audit_purge_gate')
  await assert.rejects(purgeAudit(db, { now: NOW, retainS: 400 * DAY }))
  assert.equal(await count(db), 3)
  await assert.rejects(db.run('DELETE FROM audit_events'))
  assert.equal(await count(db), 3)
})

test('summaries keep short scalars only: no secrets, tokens, hashes or message content', () => {
  assert.deepEqual(redact({ role: 'admin', count: 3, ok: true, none: null, password: 'hunter22', api_key: 'x', token: 't', reply_body: 'hi', text: 'msg',
    note: 'a'.repeat(121), nested: { a: 1 }, hexy: 'f'.repeat(64), stripe: 'sk_live_abc', 'bad key': 1 }), { role: 'admin', count: 3, ok: true, none: null })
})

bothEngines('a summary never outgrows its column: fields past 2000 characters are dropped, the event is still written', async ({ db }) => {
  const big = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field_${i}`, `${i} ${'word '.repeat(23)}`]))
  const kept = redact(big)
  assert.ok(JSON.stringify(kept).length <= 2000)
  assert.ok(Object.keys(kept).length >= 10 && Object.keys(kept).length < 20)
  await record(db, { tenantId: 'A', actorId: 'A', action: 'x.big', resourceType: 't', summary: big })
  assert.deepEqual((await searchAudit(db, 'A'))[0].summary, kept)
})

bothEngines("searches see one workspace only, newest first; filters match literally and never widen the scope", async ({ db }) => {
  await record(db, { tenantId: 'A', actorId: 'A', action: 'credential.saved', resourceType: 'llm_key' }, NOW - 2)
  await record(db, { tenantId: 'A', actorId: 'M', action: 'credential.removed', resourceType: 'llm_key' }, NOW - 1)
  await record(db, { tenantId: 'A', actorId: 'A', action: 'export.leads', resourceType: 'leads' }, NOW)
  await record(db, { tenantId: 'B', actorId: 'B', action: 'credential.saved', resourceType: 'crm' }, NOW)
  assert.deepEqual((await searchAudit(db, 'A')).map(e => e.action), ['export.leads', 'credential.removed', 'credential.saved'])
  assert.deepEqual((await searchAudit(db, 'A', { action: 'credential.' })).map(e => e.actor_id), ['M', 'A'])
  assert.deepEqual((await searchAudit(db, 'A', { actor: 'M' })).map(e => e.action), ['credential.removed'])
  const first = await searchAudit(db, 'A', { limit: 1 })
  assert.deepEqual((await searchAudit(db, 'A', { after: parseCursor(cursorOf(first[0])) })).map(e => e.action), ['credential.removed', 'credential.saved'])
  // LIKE wildcards in the prefix are literal characters, not patterns
  assert.deepEqual(await searchAudit(db, 'A', { action: '%' }), [])
  assert.deepEqual(await searchAudit(db, 'A', { action: 'credential_' }), [])
  // B's actor named in A's search finds nothing of B's
  assert.deepEqual(await searchAudit(db, 'A', { actor: 'B' }), [])
  assert.deepEqual((await searchAudit(db, 'B')).map(e => e.resource_type), ['crm'])
})

bothEngines('paging by cursor returns every event once, also when a page ends inside one second', async ({ db }) => {
  for (let i = 0; i < 5; i++) await record(db, { tenantId: 'A', actorId: 'A', action: `x.e${i}`, resourceType: 't' }, NOW)
  await record(db, { tenantId: 'A', actorId: 'A', action: 'x.older', resourceType: 't' }, NOW - 1)
  const seen: string[] = []
  for (let after = null as ReturnType<typeof parseCursor>, n = 0; n < 10; n++) {
    const page = await searchAudit(db, 'A', { after, limit: 2 })
    seen.push(...page.map(e => e.action))
    if (page.length < 2) break
    after = parseCursor(cursorOf(page[page.length - 1]))
  }
  assert.deepEqual(seen, ['x.e4', 'x.e3', 'x.e2', 'x.e1', 'x.e0', 'x.older'])
  assert.equal(parseCursor('1.2.not-an-id'), null)
})

bothEngines("Stripe's plan changes are the Stripe service's events, written with the change, once per event", async ({ db }) => {
  await db.run("INSERT INTO users (id, email, password_hash, salt) VALUES (?, 't@example.test', 'h', 's')", [T])
  assert.equal(await applyStripeEvent(db, ev('evt_1', 'checkout.session.completed', 100, { mode: 'subscription', client_reference_id: T, customer: 'cus_t', subscription: 'sub_1' })), 'applied')
  assert.equal(await applyStripeEvent(db, ev('evt_1', 'checkout.session.completed', 100, { mode: 'subscription', client_reference_id: T, customer: 'cus_t', subscription: 'sub_1' })), 'duplicate')
  assert.equal(await applyStripeEvent(db, ev('evt_2', 'customer.subscription.deleted', 300, { id: 'sub_1', customer: 'cus_t', status: 'canceled' })), 'applied')
  // an older event that arrives late changes nothing, so it leaves no event
  assert.equal(await applyStripeEvent(db, ev('evt_3', 'customer.subscription.updated', 200, { id: 'sub_1', customer: 'cus_t', status: 'active' })), 'stale')
  assert.equal(await readPlan(db, T), 'free')
  const events = (await searchAudit(db, T)).reverse()
  assert.deepEqual(events.map(e => [e.actor_id, e.actor_kind, e.action, e.resource_id, e.correlation_id, e.summary.plan, e.summary.previous]), [
    ['stripe', 'service', 'billing.plan_changed', 'evt_1', 'evt_1', 'pro', 'free'],
    ['stripe', 'service', 'billing.plan_changed', 'evt_2', 'evt_2', 'free', 'pro'],
  ])
  assert.equal(events[0].summary.event_type, 'checkout.session.completed')
  assert.ok(!JSON.stringify(await all(db)).includes('cus_t'), 'no Stripe customer id in the trail')
})

bothEngines("Stripe's held reconciliation and failed payments are recorded too, in the same transaction", async ({ db }) => {
  await db.run("INSERT INTO users (id, email, password_hash, salt) VALUES (?, 't@example.test', 'h', 's')", [T])
  assert.equal(await applyStripeEvent(db, ev('evt_1', 'checkout.session.completed', 100, { mode: 'subscription', client_reference_id: T, customer: 'cus_t', subscription: 'sub_1' })), 'applied')
  assert.equal(await applyStripeEvent(db, ev('evt_pf', 'invoice.payment_failed', 150, { customer: 'cus_t', subscription: 'sub_1' })), 'applied')
  // a same-second event that would change the plan, and a status from Stripe the policy does not know: held
  assert.equal(await applyStripeEvent(db, ev('evt_h', 'customer.subscription.updated', 150, { id: 'sub_1', customer: 'cus_t', status: 'unpaid' }), { subscriptionStatus: async () => 'not_a_status' }), 'held')
  const events = (await searchAudit(db, T)).reverse()
  assert.deepEqual(events.map(e => [e.actor_kind, e.action, e.resource_id, e.correlation_id]), [
    ['service', 'billing.plan_changed', 'evt_1', 'evt_1'],
    ['service', 'billing.payment_failed', 'evt_pf', 'evt_pf'],
    ['service', 'billing.plan_held', 'evt_h', 'evt_h'],
  ])
  assert.deepEqual([events[1].summary.status, events[2].summary.plan, events[2].summary.previous], ['past_due', 'free', 'pro'])
})

bothEngines('a plan change that does not commit leaves no audit event', async ({ db }) => {
  await db.run("INSERT INTO users (id, email, password_hash, salt) VALUES (?, 't@example.test', 'h', 's')", [T])
  // the plan row cannot take this change (the tenant's row is forced to fail its write): the transaction rolls back
  await db.run('INSERT INTO tenant_plans (tenant_id) VALUES (?)', [T])
  await db.run(db.kind === 'pg'
    ? "CREATE FUNCTION dazl_test_refuse_plan() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$"
    : "CREATE TRIGGER dazl_test_refuse_plan BEFORE UPDATE OF plan ON tenant_plans BEGIN SELECT RAISE(ABORT, 'refused'); END")
  if (db.kind === 'pg') await db.run('CREATE TRIGGER dazl_test_refuse_plan BEFORE UPDATE OF plan ON tenant_plans FOR EACH ROW EXECUTE FUNCTION dazl_test_refuse_plan()')
  await assert.rejects(applyStripeEvent(db, ev('evt_9', 'checkout.session.completed', 100, { mode: 'subscription', client_reference_id: T, customer: 'cus_t', subscription: 'sub_1' })))
  assert.deepEqual(await all(db), [])
})
