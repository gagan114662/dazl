// One app instance for test/pg-stripe-instances.test.ts: its own Postgres pool on the shared schema (ST_SCHEMA), serving
// the real /api/billing/checkout, /api/stripe and /api/usage handlers, at the same time as a second instance serving the
// other tenant. Stripe is never reached: api.stripe.com is a stub that answers the checkout call, and webhooks are
// Stripe-shaped fixtures signed with a per-run test secret (test mode only, no charge). Phases, each started by a barrier:
//   1. checkout for its own tenant; its own signed checkout.session.completed and invoice.payment_failed
//   2. the same event delivered by both instances at once (the parent checks exactly one applied)
//   3. the other tenant's events replayed here; then an event naming its OWN tenant with the OTHER tenant's customer
//   4. /api/usage for its own tenant
// Every response is printed as one JSON line; the parent checks the rows.
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { setUser } from './tenant-route-db.ts'
import { pgDb, setDb } from '../../lib/db/client.ts'

// test values from the parent (neutral names: the net fence drops *KEY*/*SECRET* variables)
Object.assign(process.env, { STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_PRICE_PRO: 'price_fixture_pro', STRIPE_WEBHOOK_SECRET: process.env.ST_WEBHOOK, PUBLIC_BASE_URL: 'https://dazl.test' })
const checkoutForms: string[] = []
globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
  const url = new URL(String(u))
  if (url.hostname !== 'api.stripe.com' || url.pathname !== '/v1/checkout/sessions') throw new Error(`Unexpected network call: ${url.href}`)
  if (new Headers(init?.headers).get('authorization') !== 'Bearer sk_test_fixture') throw new Error('not the test-mode key')
  checkoutForms.push(String(init?.body ?? ''))
  return new Response(JSON.stringify({ id: 'cs_test_fixture', url: 'https://checkout.stripe.test/c/pay/cs_test_fixture' }), { status: 200 })
}) as typeof fetch
const db = pgDb({ connectionString: process.env.DAZL_TEST_PG_URL!, searchPath: process.env.ST_SCHEMA, max: 3 })
setDb(db)
const me = JSON.parse(process.env.ST_ME!) as { tag: string; TENANT: string; CUSTOMER: string; SUBSCRIPTION: string }
const other = JSON.parse(process.env.ST_OTHER!) as typeof me
const shared = process.env.ST_SHARED!

const stripe = await import('../../app/api/stripe/route.ts')
const checkout = await import('../../app/api/billing/checkout/route.ts')
const usage = await import('../../app/api/usage/route.ts')

const fixture = (name: string, t: typeof me, id: string) => ['TENANT', 'CUSTOMER', 'SUBSCRIPTION']
  .reduce((s, k) => s.replaceAll(`{{${k}}}`, t[k as 'TENANT']), readFileSync(new URL(`../fixtures/stripe/${name}.json`, import.meta.url), 'utf8'))
  .replace(/"id": "evt_[^"]+"/, `"id": "${id}"`)
const sign = (body: string) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET!).update(`${t}.${body}`).digest('hex')}` }
const deliver = async (body: string) => {
  const r = await stripe.POST(new NextRequest('https://dazl.test/api/stripe', { method: 'POST', body, headers: { 'content-type': 'application/json', 'stripe-signature': sign(body) } }))
  return { status: r.status, ...(await r.json()) as { result?: string } }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const barrier = async (phase: string) => {
  await db.run('INSERT INTO st_barrier (phase, tag) VALUES (?, ?)', [phase, me.tag])
  while (Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM st_barrier WHERE phase = ?', [phase]))!.n) < 2) await sleep(5)
}
const ev = (t: typeof me, kind: string) => `evt_${t.tag}_${kind}`

const out: Record<string, unknown> = { tag: me.tag }
await barrier('start')
// 1. checkout and this tenant's own events
setUser({ id: me.TENANT, business_name: 'Co', email: `${me.tag}@example.test` } as never)
const co = await checkout.POST(new NextRequest('https://dazl.test/api/billing/checkout', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', host: 'dazl.test', origin: 'https://dazl.test' } }))
out.checkout = { status: co.status, form: Object.fromEntries(new URLSearchParams(checkoutForms.at(-1) ?? '')) }
out.completed = await deliver(fixture('checkout.session.completed', me, ev(me, 'co')))
out.failed = await deliver(fixture('invoice.payment_failed', me, ev(me, 'pf')))
// 2. one event, both instances at once
await barrier('race')
out.race = await deliver(fixture('checkout.session.completed', JSON.parse(shared), 'evt_shared_race'))
// 3. the other tenant's events again, here; then this tenant's id with the other tenant's customer
await barrier('cross')
out.replays = [await deliver(fixture('checkout.session.completed', other, ev(other, 'co'))), await deliver(fixture('invoice.payment_failed', other, ev(other, 'pf')))]
// a completed checkout naming this tenant with the other tenant's Stripe customer (a subscription moved between
// customers in Stripe, say): applied, it would link the other tenant's customer to this one
out.forged = await deliver(fixture('checkout.session.completed', { ...me, CUSTOMER: other.CUSTOMER, SUBSCRIPTION: `sub_forged_${me.tag}` }, ev(me, 'forged')).replace(/"created": \d+/, '"created": 1793000300')) // newest event: nothing else would refuse it
// 4. usage for this tenant
await barrier('read')
out.usage = await (await usage.GET(new NextRequest('https://dazl.test/api/usage'))).json()
await db.close()
process.stdout.write(JSON.stringify(out) + '\n')
