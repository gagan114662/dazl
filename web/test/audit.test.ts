// Durable audit trail (lib/audit.ts, #371), on both engines: append-only in the database, redacted summaries,
// searches scoped to one workspace, and Stripe's plan changes recorded in the transaction that applies them.
// Synthetic rows only; nothing is fetched or sent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { AUDIT_RETAIN_S, cursorOf, parseCursor, purgeAudit, record, redact, searchAudit } from '../lib/audit.ts'
import { applyStripeEvent, type StripeEvent } from '../lib/billing/stripe.ts'
import { readPlan } from '../lib/plans.ts'
import type { Db } from '../lib/db/client.ts'
import { bothEngines } from './helpers/engines.ts'

const NOW = Math.floor(Date.now() / 1000)
const all = (db: Db) => db.all<Record<string, unknown>>('SELECT * FROM audit_events')
const T = 'a'.repeat(32)
const ev = (id: string, type: string, created: number, object: StripeEvent['data']['object']): StripeEvent => ({ id, type, created, data: { object } })

bothEngines('events are append-only in the database; only the retention purge deletes, and only old events', async ({ db }) => {
  await record(db, { tenantId: 'A', actorId: 'A', action: 'x.old', resourceType: 't' }, NOW - AUDIT_RETAIN_S - 10)
  await record(db, { tenantId: 'A', actorId: 'A', action: 'x.new', resourceType: 't' }, NOW)
  await assert.rejects(db.run("UPDATE audit_events SET action = 'tampered'"))
  await assert.rejects(db.run("UPDATE audit_events SET tenant_id = 'B'"))
  await assert.rejects(db.run('DELETE FROM audit_events'))
  assert.equal((await all(db)).length, 2)
  assert.equal(await purgeAudit(db, { now: NOW }), 1)
  assert.deepEqual((await searchAudit(db, 'A')).map(e => e.action), ['x.new'])
  assert.equal((await db.all('SELECT * FROM audit_purge_gate')).length, 0, 'the gate exists only inside the purge')
  await assert.rejects(db.run('DELETE FROM audit_events'), 'still append-only after a purge')
  // Postgres row triggers do not see TRUNCATE; its own statement trigger refuses it (SQLite has no TRUNCATE)
  if (db.kind === 'pg') await assert.rejects(db.run('TRUNCATE audit_events'), /append-only/)
  assert.equal((await all(db)).length, 1)
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
