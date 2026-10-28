// Billing in the app, end to end on a production build (Stripe TEST mode only; nothing reaches Stripe). NOT part of
// `npm test`. Run after `npm run build`:  npm run test:smoke:billing [-- <screenshot dir>]
// Two tenants: A (the signed-in smoke user, Free) and B (already Pro with its own customer). Signed test-mode webhook
// events are delivered to the server's real /api/stripe, and Settings > Plan is screenshotted after each:
//   1 Free  ->  2 checkout.session.completed: Pro  ->  3 invoice.payment_failed: Pro, payment-failed note
//   ->  4 customer.subscription.deleted: Free, ended note;  plus the return from Checkout (?billing=success)
// The return URL is not evidence of payment (anyone can type it). Before any webhook, with no plan row at all, and
// again after the subscription ended, ?billing=success must only say it is checking, then that nothing is confirmed;
// ?billing=cancelled must state only the plan the server holds; any other value shows nothing.
// Every step also checks tenant B's plan row is unchanged, and a replayed event is a no-op.
// The webhook secret is generated per run and passed under a neutral name (test/smoke/stripe-test-env.mjs).
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { loadPlaywright, newContext, root, startServer } from './harness.mjs'
const { chromium } = loadPlaywright()
const require = createRequire(path.join(root, 'package.json'))

const out = path.resolve(process.argv[2] ?? path.join(root, 'preview', 'billing'))
mkdirSync(out, { recursive: true })
const WHSEC = 'whsec_smoke_' + randomBytes(12).toString('hex')
const A = 'smoke-user', B = 'b'.repeat(32)
let dbPath
const db = () => new (require('better-sqlite3'))(dbPath)
const planRow = t => { const d = db(); try { return d.prepare('SELECT plan, subscription_status, stripe_customer_id, stripe_subscription_id FROM tenant_plans WHERE tenant_id = ?').get(t) ?? null } finally { d.close() } }

const srv = await startServer({
  env: {
    NODE_OPTIONS: `--experimental-strip-types --import ${path.join(root, 'test/helpers/net-fence.ts')} --import ${path.join(root, 'test/smoke/stripe-test-env.mjs')}`,
    SMOKE_STRIPE_WHSEC: WHSEC, SMOKE_STRIPE_SK: 'sk_test_smoke', STRIPE_PRICE_PRO: 'price_smoke',
  },
  prepare: async p => {
    dbPath = p
    const { migrateAllSqlite } = await import('../../lib/db/sqlite-migrations.ts')
    const { migratePlans } = await import('../../lib/plans.ts')
    const { migrateBilling } = await import('../../lib/billing/stripe.ts')
    const d = db()
    try {
      migrateAllSqlite(d); migratePlans(d); migrateBilling(d)
      d.prepare("INSERT INTO users (id, email, password_hash, salt) VALUES (?, 'b@example.test', 'x', 'y')").run(B)
      d.prepare("INSERT INTO tenant_plans (tenant_id, plan, subscription_status, stripe_customer_id, stripe_subscription_id) VALUES (?, 'pro', 'active', 'cus_tenant_b', 'sub_tenant_b')").run(B)
    } finally { d.close() }
  },
})
const event = (name, id, created) => readFileSync(path.join(root, `test/fixtures/stripe/${name}.json`), 'utf8')
  .replaceAll('{{TENANT}}', A).replaceAll('{{CUSTOMER}}', 'cus_smoke_a').replaceAll('{{SUBSCRIPTION}}', 'sub_smoke_a')
  .replace(/"id": "evt_[^"]+"/, `"id": "${id}"`).replace(/"created": \d+/, `"created": ${created}`)
const deliver = async body => {
  const t = Math.floor(Date.now() / 1000)
  const r = await fetch(`${srv.base}/api/stripe`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${createHmac('sha256', WHSEC).update(`${t}.${body}`).digest('hex')}` } })
  return { status: r.status, ...(await r.json()) }
}

const shots = []
let browser
try {
  const bBefore = planRow(B)
  browser = await chromium.launch()
  const ctx = await newContext(browser, srv)
  const page = await ctx.newPage()
  const step = async (n, label, url = '/app/settings') => {
    await page.goto(srv.base + url, { waitUntil: 'networkidle' })
    const panel = page.getByTestId('plan-panel')
    await panel.waitFor()
    const file = `billing-${n}.png`
    await panel.screenshot({ path: path.join(out, file) })
    shots.push({ file, label })
    const text = await panel.innerText()
    assert.deepEqual(planRow(B), bBefore, `${label}: tenant B changed`)
    return { badge: await page.getByTestId('plan-badge').innerText(), text }
  }

  let s = await step(1, 'Before: Free')
  assert.equal(s.badge, 'Free'); assert.match(s.text, /Upgrade to Pro/)
  assert.equal(planRow(A), null, 'tenant A has no plan row yet')

  // the return URL alone, before any payment or webhook: never claims a payment
  const NEVER = /Payment received|payment received|Nothing was charged|You are on Pro|Pro plan is active/
  s = await step('1b', 'Typed ?billing=success with no payment: checking only', '/app/settings?billing=success')
  assert.equal(s.badge, 'Free'); assert.match(s.text, /Checking your subscription with Stripe/); assert.doesNotMatch(s.text, NEVER)
  await page.getByText('No confirmed subscription yet').waitFor({ timeout: 30000 }) // after the bounded re-reads
  await page.getByTestId('plan-panel').screenshot({ path: path.join(out, 'billing-1c.png') })
  shots.push({ file: 'billing-1c.png', label: 'Typed ?billing=success, after the re-reads: nothing confirmed' })
  assert.doesNotMatch(await page.getByTestId('plan-panel').innerText(), NEVER)
  s = await step('1d', 'Typed ?billing=cancelled: states only the plan held', '/app/settings?billing=cancelled')
  assert.match(s.text, /Checkout was not completed\. Your plan is still Free\./); assert.doesNotMatch(s.text, NEVER)
  s = await step('1e', 'Any other ?billing= value: no return notice', '/app/settings?billing=paid')
  assert.equal(await page.getByTestId('billing-return').count(), 0); assert.equal(s.badge, 'Free')
  assert.equal(planRow(A), null, 'none of the return URLs changed anything')

  const created = Math.floor(Date.now() / 1000) - 600
  const checkout = event('checkout.session.completed', 'evt_smoke_checkout_' + randomBytes(6).toString('hex'), created)
  assert.deepEqual(await deliver(checkout), { status: 200, result: 'applied' })
  assert.deepEqual(await deliver(checkout), { status: 200, result: 'duplicate' }, 'a replay is a no-op')
  s = await step(2, 'After checkout.session.completed: Pro')
  assert.equal(s.badge, 'Pro'); assert.match(s.text, /Manage billing/); assert.match(s.text, /no monthly scan cap/i)
  assert.deepEqual(planRow(A), { plan: 'pro', subscription_status: 'active', stripe_customer_id: 'cus_smoke_a', stripe_subscription_id: 'sub_smoke_a' })

  s = await step(3, 'Back from Checkout (?billing=success) after the webhook: Pro confirmed by the server', '/app/settings?billing=success')
  assert.match(s.text, /Your Pro plan is active\./); assert.doesNotMatch(s.text, /Payment received|Nothing was charged/)

  assert.equal((await deliver(event('invoice.payment_failed', 'evt_smoke_pf_' + randomBytes(6).toString('hex'), created + 60))).result, 'applied')
  s = await step(4, 'After invoice.payment_failed: Pro, Stripe retrying')
  assert.equal(s.badge, 'Pro'); assert.match(s.text, /last payment failed/)

  assert.equal((await deliver(event('customer.subscription.deleted', 'evt_smoke_del_' + randomBytes(6).toString('hex'), created + 120))).result, 'applied')
  s = await step(5, 'After customer.subscription.deleted: Free, ended')
  assert.equal(s.badge, 'Free'); assert.match(s.text, /subscription has ended/); assert.match(s.text, /Upgrade to Pro/)
  assert.equal(planRow(A).plan, 'free')

  // a stale return URL after the subscription ended: checking only, never "active"
  s = await step(6, 'Stale ?billing=success after the subscription ended', '/app/settings?billing=success')
  assert.equal(s.badge, 'Free'); assert.match(s.text, /Checking your subscription with Stripe/); assert.match(s.text, /subscription has ended/)
  assert.doesNotMatch(s.text, /Pro plan is active|Payment received/)

  // an unsigned or wrongly signed event changes nothing
  const forged = event('checkout.session.completed', 'evt_smoke_forged_' + randomBytes(6).toString('hex'), created + 180)
  assert.equal((await fetch(`${srv.base}/api/stripe`, { method: 'POST', body: forged, headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=00' } })).status, 400)
  assert.equal(planRow(A).plan, 'free')
  assert.deepEqual(planRow(B), bBefore)
  for (const x of shots) console.log(`ok   ${x.label} (${x.file})`)
} finally {
  await browser?.close()
  srv.stop()
}
writeFileSync(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>dazl billing preview</title>
<style>body{font:14px system-ui;margin:24px}figure{margin:0 0 24px}img{border:1px solid #ccc;max-width:720px}</style>
<h1>Settings &gt; Plan, through signed Stripe test-mode webhooks</h1><p>Tenant B (already Pro) is checked unchanged after every step.</p>
${shots.map(x => `<figure><figcaption>${x.label}</figcaption><img src="${x.file}" alt="${x.label}"></figure>`).join('\n')}`)
console.log(`\nBilling flow shown in Settings at every step; tenant B unchanged. Screenshots in ${out}`)
