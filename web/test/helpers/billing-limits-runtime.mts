// Stripe test mode end to end, through the real routes, down to the plan limit on the next scan (test/billing-limits.test.ts):
// Free at its monthly limit -> scan refused (402); signed checkout webhook -> Pro -> the next scan is accepted; a failed
// payment (subscription past_due, Stripe retrying) keeps Pro and the account reads past_due; the subscription ends ->
// Free -> the next scan is refused again. Signed fixture events, api.stripe.com stubbed, and the scan runner is never
// started (after() is recorded, not run), so no scan runs and nothing is charged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { afterCalls } from './next-server-shim.mjs'
import { setScanDb, setUser } from './tenant-route-db.ts'

process.env.STRIPE_SECRET_KEY = 'sk_test_fixture'
process.env.STRIPE_PRICE_PRO = 'price_fixture_pro'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fixture_' + randomBytes(8).toString('hex')
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')

const { getDb } = await import('../../lib/db/client.ts')
const { getAuthDb } = await import('../../lib/auth-db.ts')
const { saveKey } = await import('../../lib/llm/key-store.ts')
const { PLAN_LIMITS } = await import('../../lib/plans.ts')
const webhook = await import('../../app/api/billing/webhook/route.ts')
const scan = await import('../../app/api/scan/route.ts')
const usage = await import('../../app/api/usage/route.ts')
globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call to ${String(u)}`) }) as typeof fetch

const fixture = (name: string, vars: Record<string, string>) =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, v), readFileSync(new URL(`../fixtures/stripe/${name}.json`, import.meta.url), 'utf8'))
const sign = (body: string) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET!).update(`${t}.${body}`).digest('hex')}` }
const deliver = async (body: string) => (await webhook.POST(new NextRequest('https://dazl.test/api/billing/webhook', { method: 'POST', body, headers: { 'content-type': 'application/json', 'stripe-signature': sign(body) } }))).json()
const startScan = () => scan.POST(new NextRequest('https://dazl.test/api/scan', { method: 'POST', body: JSON.stringify({ query: 'companies hiring sales reps in Toronto' }), headers: { 'content-type': 'application/json', host: 'dazl.test', origin: 'https://dazl.test' } }))
const account = async () => (await (await usage.GET(new NextRequest('https://dazl.test/api/usage')))!.json()) as { plan: string; scans_used: number; scan_limit: number | null; billing_status: string | null }

test('Stripe test mode: plan limits on the next scan follow checkout, a failed payment and the end of the subscription', async () => {
  await getDb()
  const db = getAuthDb()
  setScanDb(db)
  const T = 'd'.repeat(32)
  setUser({ id: T, business_name: 'Acme', email: 'owner@example.test' } as never)
  saveKey(db, T, 'anthropic', 'sk-ant-api03-FIXTUREFIXTUREFIXTUREFIXTURE', Buffer.from(process.env.DAZL_MASTER_KEY!, 'base64')) // own key: not a trial scan
  // this month's Free allowance is used up (finished scans, funded by the tenant's key)
  const limit = PLAN_LIMITS.free.scansPerMonth!
  const ins = db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES (?, ?, 'Acme', 'software', 'Toronto')")
  for (let i = 0; i < limit; i++) ins.run(`done${String(i).padStart(20, '0')}`, T)
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE user_id = ?").run(T)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE user_id = ?").run(T)
  const finishScans = () => { db.prepare("UPDATE scan_jobs SET status = 'running' WHERE user_id = ? AND status = 'pending'").run(T); db.prepare("UPDATE scan_jobs SET status = 'done' WHERE user_id = ? AND status = 'running'").run(T) }

  // 1. Free at its limit: the next scan is refused, nothing queued
  assert.deepEqual(await account(), { ...(await account()), plan: 'free', scans_used: limit, scan_limit: limit, billing_status: null })
  const r1 = await startScan()
  assert.equal(r1.status, 402)
  assert.equal((await r1.json()).error, 'quota_exceeded')

  // 2. Signed checkout webhook -> Pro: the next scan is accepted (queued; the runner is not started here)
  const vars = { TENANT: T, CUSTOMER: 'cus_limits', SUBSCRIPTION: 'sub_limits' }
  assert.deepEqual(await deliver(fixture('checkout.session.completed', vars)), { result: 'applied' })
  assert.deepEqual(await account(), { ...(await account()), plan: 'pro', scan_limit: null, billing_status: 'active' })
  const r2 = await startScan()
  assert.equal(r2.status, 202)
  assert.ok((await r2.json()).job_id)
  assert.equal(afterCalls.length, 1) // the runner kick was recorded, never run
  finishScans()

  // 3. A failed payment: Stripe moves the subscription to past_due and retries. Still Pro; the account reads past_due.
  const pastDue = fixture('customer.subscription.updated.cancel_at_period_end', vars)
    .replace(/"id": "evt_[^"]+"/, '"id": "evt_test_past_due"').replace('"status": "active"', '"status": "past_due"').replace(/"created": \d+/, '"created": 1793000150')
  assert.deepEqual(await deliver(pastDue), { result: 'applied' })
  assert.deepEqual(await account(), { ...(await account()), plan: 'pro', scan_limit: null, billing_status: 'past_due' })
  assert.equal((await startScan()).status, 202)
  finishScans()
  assert.deepEqual(await deliver(pastDue), { result: 'duplicate' }) // replay: processed once

  // 4. The subscription ends (retries exhausted or cancelled) -> Free; the month already has more than 50 scans: refused
  assert.deepEqual(await deliver(fixture('customer.subscription.deleted', vars)), { result: 'applied' })
  const a4 = await account()
  assert.deepEqual([a4.plan, a4.scan_limit, a4.billing_status, a4.scans_used], ['free', limit, 'canceled', limit + 2])
  const r4 = await startScan()
  assert.equal(r4.status, 402)
  assert.deepEqual(await r4.json(), { error: 'quota_exceeded', plan: 'free', used: limit + 2, limit })
  assert.equal(afterCalls.length, 2) // only the two accepted scans were queued
  console.log('BILLING_LIMITS_OK')
})
