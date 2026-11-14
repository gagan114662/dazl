// One-click Connect LinkedIn (#1037, F-go step 2) through the real route handlers: Settings asks for a pairing code, the dazl Connect
// extension trades it for a device token and saves the user's own LinkedIn session with it. Synthetic fixture: throwaway SQLite, mocked
// session (tenant-route loader), invented cookies and member; the worker's account check is answered by a stub (no network).
import { randomBytes } from 'node:crypto'
Object.assign(process.env, { ADVANCED_CONNECTORS: '1', ADVANCED_LINKEDIN: '1', ADVANCED_WORKER_URL: 'https://worker.invalid', ADVANCED_WORKER_TOKEN: 'test-token', DAZL_MASTER_KEY: randomBytes(32).toString('base64') })
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { CONSENT_VERSION } from '../../lib/advanced/config.ts'
import { readEnabledCredential, connectorStatus } from '../../lib/connectors/store.ts'
import { createPairing, PAIR_TTL_S, redeemPairing } from '../../lib/advanced/linkedin-connect.ts'
import * as settings from '../../app/api/settings/advanced/route.ts'
import * as ext from '../../app/api/extension/linkedin/route.ts'

const db = new Database(':memory:')
migrateAllSqlite(db)
setScanDb(db)
const adb = sqliteDb(db)
for (const [t, m, role] of [['A', 'A', 'owner'], ['B', 'B', 'owner']]) db.prepare('INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, ?, 0)').run(t, m, role)

// The worker's /linkedin/me, stubbed: a fixed invented member; every other outbound call fails the test.
const workerCalls: { url: string; body: string }[] = []
globalThis.fetch = (async (u: string, init?: RequestInit) => {
  const url = String(u)
  if (url !== 'https://worker.invalid/linkedin/me') throw new Error(`unexpected outbound call ${url}`)
  workerCalls.push({ url, body: String(init?.body) })
  return new Response(JSON.stringify({ name: 'Dana Okoye', public_id: 'dana-okoye-test', upstream_requests: 1 }), { status: 200 })
}) as typeof fetch

const asUser = (id: string, role: 'owner' | 'viewer' = 'owner') => setUser({ id, business_name: `Co ${id}`, role })
const settingsPost = (body: unknown) => settings.POST(new NextRequest('http://localhost/api/settings/advanced', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' }, body: JSON.stringify(body) }))
const extPost = (bearer: string | null, body: unknown) => ext.POST(new NextRequest('http://localhost/api/extension/linkedin', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) }))
const LI_AT = `AQEDAR${'x'.repeat(60)}`, JSID = '"ajax:1234567890123456789"'
const consent = async (id: string) => { asUser(id); assert.equal((await settingsPost({ action: 'consent', platform: 'linkedin', accept: true, version: CONSENT_VERSION })).status, 200) }

test('Connect LinkedIn: pair, trade the code once, save the session, name the account; isolation, revocation and Disconnect', async () => {
  // A pairing code needs the risk notice first, and is this workspace's only.
  asUser('A')
  assert.equal((await settingsPost({ action: 'pair', platform: 'linkedin' })).status, 403)
  await consent('A')
  const pr = await settingsPost({ action: 'pair', platform: 'linkedin' })
  assert.equal(pr.status, 200)
  const { code, expires_at } = await pr.json() as { code: string; expires_at: number }
  assert.match(code, /^A\.[A-Za-z0-9_-]{43}$/); assert.ok(expires_at - Math.floor(Date.now() / 1000) <= PAIR_TTL_S)
  // the internal rows are never listed as connectors
  assert.deepEqual((await connectorStatus(adb, 'A')).map(c => c.connector), [])

  // The extension: no bearer, a wrong or malformed code -> 401; the right code once -> a device token; the same code again -> 401.
  assert.equal((await extPost(null, { action: 'pair' })).status, 401)
  assert.equal((await extPost(`A.${'x'.repeat(43)}`, { action: 'pair' })).status, 401)
  assert.equal((await extPost('not-a-code-at-all', { action: 'pair' })).status, 401)
  const paired = await extPost(code, { action: 'pair' })
  assert.equal(paired.status, 200)
  assert.equal(paired.headers.get('access-control-allow-origin'), null, 'no CORS: another site cannot read or call it')
  const { device_token } = await paired.json() as { device_token: string }
  assert.match(device_token, /^A\.[A-Za-z0-9_-]{43}$/); assert.notEqual(device_token, code)
  assert.equal((await extPost(code, { action: 'pair' })).status, 401, 'a code is spent once')
  // the code is not a device token, the device token is not a code
  assert.equal((await extPost(code, { action: 'status' })).status, 401)
  assert.equal((await extPost(device_token, { action: 'pair' })).status, 401)

  // Save: cookies that are not a signed-in session are refused; real-shaped ones are stored as the tenant's LinkedIn session, and the
  // account is named by ONE worker read.
  for (const bad of [{ li_at: 'short', jsessionid: JSID }, { li_at: LI_AT, jsessionid: 'nope' }, { li_at: `${LI_AT};evil=1`, jsessionid: JSID }, {}])
    assert.equal((await extPost(device_token, { action: 'session', ...bad })).status, 400, JSON.stringify(bad))
  const saved = await extPost(device_token, { action: 'session', li_at: LI_AT, jsessionid: JSID })
  assert.equal(saved.status, 200)
  assert.deepEqual(await saved.json(), { ok: true, name: 'Dana Okoye', check: null })
  assert.equal(await readEnabledCredential(adb, 'A', 'adv:linkedin'), `li_at=${LI_AT}; JSESSIONID="ajax:1234567890123456789"`)
  assert.equal(workerCalls.length, 1); assert.deepEqual(JSON.parse(workerCalls[0].body), { session: `li_at=${LI_AT}; JSESSIONID="ajax:1234567890123456789"` })
  // a cookie rotation re-saves without another account read
  assert.equal((await extPost(device_token, { action: 'session', li_at: `${LI_AT}2`, jsessionid: JSID })).status, 200)
  assert.equal(workerCalls.length, 1)
  assert.equal(await readEnabledCredential(adb, 'A', 'adv:linkedin'), `li_at=${LI_AT}2; JSESSIONID="ajax:1234567890123456789"`)
  // Settings shows it, without any secret
  asUser('A')
  const st = await (await settings.GET()).json() as { linkedin_connect: { connected: boolean; name: string | null; synced_at: number | null } }
  assert.equal(st.linkedin_connect.connected, true); assert.equal(st.linkedin_connect.name, 'Dana Okoye'); assert.ok(st.linkedin_connect.synced_at)
  assert.ok(!JSON.stringify(st).includes(LI_AT) && !JSON.stringify(st).includes(device_token.split('.')[1]))
  // "Test connection" from Settings: one read, the name
  assert.deepEqual(await (await settingsPost({ action: 'test', platform: 'linkedin' })).json(), { ok: true, name: 'Dana Okoye' })
  assert.equal(workerCalls.length, 2)

  // Another workspace: its own code pairs its own device; A's device token never writes B's session, B's never A's.
  await consent('B')
  asUser('B')
  const bCode = (await (await settingsPost({ action: 'pair', platform: 'linkedin' })).json() as { code: string }).code
  const bDev = (await (await extPost(bCode, { action: 'pair' })).json() as { device_token: string }).device_token
  assert.ok(bDev.startsWith('B.'))
  assert.equal((await extPost(`B.${device_token.split('.')[1]}`, { action: 'session', li_at: LI_AT, jsessionid: JSID })).status, 401, "A's secret under B's prefix")
  assert.equal(await readEnabledCredential(adb, 'B', 'adv:linkedin'), null)

  // The risk notice withdrawn: nothing new is stored.
  asUser('A')
  assert.equal((await settingsPost({ action: 'revoke', platform: 'linkedin' })).status, 200)
  assert.equal((await extPost(device_token, { action: 'session', li_at: `${LI_AT}3`, jsessionid: JSID })).status, 403)
  await consent('A')

  // The pairing member's role lowered, or removed from the workspace: the device stops at once.
  db.prepare("UPDATE memberships SET role = 'viewer' WHERE tenant_id = 'A' AND member_id = 'A'").run()
  assert.equal((await extPost(device_token, { action: 'status' })).status, 401)
  db.prepare("UPDATE memberships SET role = 'owner' WHERE tenant_id = 'A' AND member_id = 'A'").run()
  assert.equal((await extPost(device_token, { action: 'status' })).status, 200)
  db.prepare("DELETE FROM memberships WHERE tenant_id = 'A' AND member_id = 'A'").run()
  assert.equal((await extPost(device_token, { action: 'status' })).status, 401)
  db.prepare("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES ('A', 'A', 'owner', 0)").run()

  // Disconnect: the device, any pending code and the session go; the token is dead.
  asUser('A')
  assert.equal((await settings.DELETE(new NextRequest('http://localhost/api/settings/advanced?platform=linkedin', { method: 'DELETE' }))).status, 200)
  assert.equal((await extPost(device_token, { action: 'status' })).status, 401)
  assert.equal(await readEnabledCredential(adb, 'A', 'adv:linkedin'), null)
  const after = await (await settings.GET()).json() as { linkedin_connect: { connected: boolean } }
  assert.equal(after.linkedin_connect.connected, false)
  // B is untouched by A's Disconnect
  assert.equal((await extPost(bDev, { action: 'status' })).status, 200)
})

test('Connect LinkedIn: an expired code is spent and refused; a viewer cannot ask for a code; the operator switch hides the endpoint', async () => {
  const past = Math.floor(Date.now() / 1000) - PAIR_TTL_S - 1
  const old = await createPairing(adb, 'A', 'A', past)
  assert.equal(await redeemPairing(adb, old.code), null)
  assert.equal(await redeemPairing(adb, old.code), null)
  // two redeems of one code at the same moment: exactly one device token
  for (let i = 0; i < 5; i++) {
    const c = await createPairing(adb, 'B', 'B')
    const both = await Promise.all([redeemPairing(adb, c.code), redeemPairing(adb, c.code)])
    assert.equal(both.filter(Boolean).length, 1, JSON.stringify(both.map(x => !!x)))
  }
  asUser('A', 'viewer')
  assert.equal((await settingsPost({ action: 'pair', platform: 'linkedin' })).status, 403)
  const keep = process.env.ADVANCED_LINKEDIN
  process.env.ADVANCED_LINKEDIN = '0'
  try { assert.equal((await extPost('A.whatever', { action: 'pair' })).status, 404) } finally { process.env.ADVANCED_LINKEDIN = keep }
})
