// The beta rules at the routes (test/beta-rules-routes.test.ts), whatever a page shows:
//   A. POST /api/outreach/autopilot refuses to enable or resume while autopilot is not available, and changes nothing; pause and
//      turn off still work; GET says it is not available, with the sentence the page shows.
//   D. POST /api/billing/checkout refuses and never calls Stripe while billing is not available.
// Each rule is also run with its switch on, to show the refusal is the switch and nothing else. Route modules load through the
// resolver hook, so this runs in its own process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { completeOAuth, startOAuth } from '../../lib/gmail/oauth.ts'
import { saveSettings } from '../../lib/outreach/service.ts'
import { ATTESTATIONS, CONSENT_VERSION, enable, getState } from '../../lib/outreach/autopilot.ts'
import { AUTOPILOT_BETA_TEXT, BILLING_BETA_TEXT } from '../../lib/beta.ts'

process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
Object.assign(process.env, { STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_PRICE_PRO: 'price_fixture_pro', PUBLIC_BASE_URL: 'https://dazl.test', GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs' })
for (const k of ['AUTOPILOT_AVAILABLE', 'AUTOPILOT_ENABLED', 'AUTOPILOT_KILL', 'BILLING_AVAILABLE']) delete process.env[k]

const autopilot = await import('../../app/api/outreach/autopilot/route.ts')
const checkout = await import('../../app/api/billing/checkout/route.ts')
const usage = await import('../../app/api/usage/route.ts')
const outreachSettings = await import('../../app/api/outreach/settings/route.ts')

const stripeCalls: string[] = []
globalThis.fetch = (async (input: unknown) => {
  const u = new URL(String(input))
  if (u.hostname !== 'api.stripe.com') throw new Error(`Unexpected network call to ${u.href}`)
  stripeCalls.push(u.pathname)
  return new Response(JSON.stringify({ id: 'cs_test_fixture', url: 'https://checkout.stripe.test/c/pay/cs_test_fixture' }), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

const T = 't'.repeat(32)
const post = (path: string, body: unknown) => new NextRequest(`https://dazl.test${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', host: 'dazl.test', origin: 'https://dazl.test' } })
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })

async function account() {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const env = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://dazl.test' }
  const now = Math.floor(Date.now() / 1000)
  const master = Buffer.from(process.env.DAZL_MASTER_KEY!, 'base64')
  const state = new URL(startOAuth(db, T, { env, now })).searchParams.get('state')!
  const idToken = 'x.' + Buffer.from(JSON.stringify({ email: 'me@seller.example', email_verified: true })).toString('base64url') + '.y'
  await completeOAuth(db, T, 'c', state, { env, master, now, fetchImpl: (async () => json({ refresh_token: 'rt', scope: 'https://www.googleapis.com/auth/gmail.send', id_token: idToken })) as unknown as typeof fetch })
  saveSettings(db, T, { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  setScanDb(db); setUser({ id: T, business_name: 'Seller', email: 'me@seller.example' })
  return db
}
const enableBody = { action: 'enable', version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 5 }

test('A: the server refuses to turn autopilot on while it is not available, and an enabled account can still pause or turn off', async () => {
  const db = await account()
  // the older operator flag alone (a server configured before the beta rule) does not make it available
  process.env.AUTOPILOT_ENABLED = '1'
  const info = await (await autopilot.GET()).json() as { available: boolean; unavailable_text: string }
  assert.equal(info.available, false)
  assert.equal(info.unavailable_text, 'Autopilot is not available during the beta. Every message is reviewed and sent by you.')
  assert.equal((await (await outreachSettings.GET()).json() as { autopilot_available: boolean }).autopilot_available, false, 'the pages that mention autopilot are told it is not offered')

  const r = await autopilot.POST(post('/api/outreach/autopilot', enableBody))
  assert.equal(r.status, 404)
  assert.deepEqual(await r.json(), { error: AUTOPILOT_BETA_TEXT, code: 'autopilot_unavailable' })
  assert.equal(getState(db, T).enabled, false, 'nothing was enabled')
  assert.equal(db.prepare('SELECT 1 FROM autopilot_settings WHERE tenant_id = ?').get(T), undefined, 'no setting was written')

  // an account that already has it on in the database: resume is refused, pause and turn off work
  enable(db, T, { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 5 })
  assert.equal((await autopilot.POST(post('/api/outreach/autopilot', { action: 'pause' }))).status, 200)
  assert.equal(getState(db, T).paused, true)
  const resume = await autopilot.POST(post('/api/outreach/autopilot', { action: 'resume' }))
  assert.equal(resume.status, 404)
  assert.equal(getState(db, T).paused, true, 'still paused')
  for (const action of ['accept_launch_policy', 'launch_calibrated', 'reaccept_product_truth']) assert.equal((await autopilot.POST(post('/api/outreach/autopilot', { action }))).status, 404, action)
  assert.equal((await autopilot.POST(post('/api/outreach/autopilot', { action: 'disable' }))).status, 200)
  assert.equal(getState(db, T).enabled, false)

  // the switch on: the same request enables (the code is kept, only gated)
  process.env.AUTOPILOT_AVAILABLE = '1'
  try {
    assert.equal((await (await autopilot.GET()).json() as { available: boolean }).available, true)
    const ok = await autopilot.POST(post('/api/outreach/autopilot', enableBody))
    assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()))
    assert.equal(getState(db, T).enabled, true)
  } finally { delete process.env.AUTOPILOT_AVAILABLE; delete process.env.AUTOPILOT_ENABLED }
  console.log('BETA_ROUTES autopilot')
})

test('D: no checkout is started while billing is not available', async () => {
  await account()
  const u = await (await usage.GET(new NextRequest('https://dazl.test/api/usage'))).json() as { plan: string }
  assert.equal(u.plan, 'free')
  const r = await checkout.POST(post('/api/billing/checkout', {}))
  assert.equal(r.status, 403)
  assert.deepEqual(await r.json(), { error: BILLING_BETA_TEXT, code: 'billing_unavailable' })
  assert.equal(BILLING_BETA_TEXT, 'dazl is free during the beta. We don\'t charge you anything.')
  assert.deepEqual(stripeCalls, [], 'Stripe was never called')

  process.env.BILLING_AVAILABLE = '1'
  try {
    const ok = await checkout.POST(post('/api/billing/checkout', {}))
    assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()))
    assert.equal((await ok.json()).url, 'https://checkout.stripe.test/c/pay/cs_test_fixture')
    assert.deepEqual(stripeCalls, ['/v1/checkout/sessions'])
  } finally { delete process.env.BILLING_AVAILABLE }
  console.log('BETA_ROUTES billing')
})
