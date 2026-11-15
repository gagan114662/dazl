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
import { createPairing, PAIR_TTL_S, redeemPairing, recordAccount, saveSessionFromDevice, DEVICE_CONNECTOR } from '../../lib/advanced/linkedin-connect.ts'
import { encryptSecret, decryptSecret } from '../../lib/secrets.ts'
import type { Db, Tx } from '../../lib/db/client.ts'
import { setEnabled } from '../../lib/connectors/store.ts'
import { reserveRequest } from '../../lib/advanced/request-budget.ts'
import * as settings from '../../app/api/settings/advanced/route.ts'
import * as ext from '../../app/api/extension/linkedin/route.ts'

const db = new Database(':memory:')
migrateAllSqlite(db)
setScanDb(db)
const adb = sqliteDb(db)
for (const [t, m, role] of [['A', 'A', 'owner'], ['B', 'B', 'owner']]) db.prepare('INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, ?, 0)').run(t, m, role)

// The worker's /linkedin/me, stubbed: a fixed invented member; every other outbound call fails the test.
const workerCalls: { url: string; body: string }[] = []
let duringWorkerCall: (() => Promise<void>) | null = null   // runs INSIDE the worker call: a race window
let workerAnswer: { status: number; body: unknown } = { status: 200, body: { name: 'Dana Okoye', public_id: 'dana-okoye-test', upstream_requests: 1 } }
globalThis.fetch = (async (u: string, init?: RequestInit) => {
  const url = String(u)
  if (url !== 'https://worker.invalid/linkedin/me') throw new Error(`unexpected outbound call ${url}`)
  workerCalls.push({ url, body: String(init?.body) })
  if (duringWorkerCall) { const f = duringWorkerCall; duringWorkerCall = null; await f() }
  return new Response(JSON.stringify(workerAnswer.body), { status: workerAnswer.status })
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

test('Connect LinkedIn review fixes: a Disconnect during a sync is not undone; a switched-off connector stays off; the account check obeys the cooldown and the shared budget', async () => {
  const pairNew = async (id: string) => { await consent(id); asUser(id); const c = (await (await settingsPost({ action: 'pair', platform: 'linkedin' })).json() as { code: string }).code; return (await (await extPost(c, { action: 'pair' })).json() as { device_token: string }).device_token }
  db.prepare('DELETE FROM rate_limits').run()   // the per-IP limit counts every earlier test's calls from the one fixture address
  for (const [t] of [['C'], ['D'], ['E']]) db.prepare('INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, ?, 0)').run(t, t, 'owner')

  // (a) Disconnect lands while the save's account check is in flight: the device and the session stay gone, the token is dead.
  const tok = await pairNew('C')
  duringWorkerCall = async () => { asUser('C'); assert.equal((await settings.DELETE(new NextRequest('http://localhost/api/settings/advanced?platform=linkedin', { method: 'DELETE' }))).status, 200) }
  const raced = await extPost(tok, { action: 'session', li_at: LI_AT, jsessionid: JSID })
  assert.equal(raced.status, 401, 'the account write after a Disconnect is refused')
  assert.equal((await extPost(tok, { action: 'status' })).status, 401)
  assert.equal(await readEnabledCredential(adb, 'C', 'adv:linkedin'), null, 'the session is not brought back')
  assert.equal((await extPost(tok, { action: 'session', li_at: LI_AT, jsessionid: JSID })).status, 401)
  // ... and a Disconnect between the device check and the session write: nothing is written
  const tok2 = await pairNew('C')
  duringWorkerCall = null
  assert.equal((await extPost(tok2, { action: 'session', li_at: LI_AT, jsessionid: JSID })).status, 200)
  asUser('C'); await settings.DELETE(new NextRequest('http://localhost/api/settings/advanced?platform=linkedin', { method: 'DELETE' }))
  assert.equal((await extPost(tok2, { action: 'session', li_at: LI_AT, jsessionid: JSID })).status, 401)
  assert.equal(await readEnabledCredential(adb, 'C', 'adv:linkedin'), null)

  // (b) The reader (or the user) switched the connector off: a cookie rotation saves the new session but leaves it OFF, and makes no account read.
  const tokD = await pairNew('D')
  assert.equal((await extPost(tokD, { action: 'session', li_at: LI_AT, jsessionid: JSID })).status, 200)
  await setEnabled(adb, 'D', 'adv:linkedin', false)
  const before = workerCalls.length
  assert.equal((await extPost(tokD, { action: 'session', li_at: `${LI_AT}9`, jsessionid: JSID, check: true })).status, 200)
  assert.equal(await readEnabledCredential(adb, 'D', 'adv:linkedin'), null, 'still off: a rotation never switches it back on')
  assert.equal((db.prepare("SELECT enabled FROM tenant_connectors WHERE tenant_id = 'D' AND connector = 'adv:linkedin'").get() as { enabled: number }).enabled, 0)
  assert.equal(workerCalls.length, before, 'no LinkedIn read through a switched-off connector')
  asUser('D'); assert.deepEqual(await (await settingsPost({ action: 'test', platform: 'linkedin' })).json(), { ok: false, outcome: 'connector_off' })

  // (c) A cooldown after a challenge, and an exhausted shared hourly budget: no account read.
  const tokE = await pairNew('E')
  db.prepare("INSERT INTO connector_audit (id, tenant_id, connector, scan_job_id, lookup, status, results, created_at) VALUES ('cool-e', 'E', 'adv:linkedin', NULL, 'people', 'stopped_challenge', 0, ?)").run(Math.floor(Date.now() / 1000))
  const b2 = workerCalls.length
  const r = await (await extPost(tokE, { action: 'session', li_at: LI_AT, jsessionid: JSID, check: true })).json() as { ok: boolean; check: string | null }
  assert.equal(r.ok, true); assert.equal(r.check, 'cooldown'); assert.equal(workerCalls.length, b2)
  db.prepare("DELETE FROM connector_audit WHERE id = 'cool-e'").run()
  for (let i = 0; i < 3; i++) await reserveRequest(adb, 'E', 'adv:linkedin', 3, 'people')
  const r2 = await (await extPost(tokE, { action: 'session', li_at: LI_AT, jsessionid: JSID, check: true })).json() as { check: string | null }
  assert.equal(r2.check, 'budget'); assert.equal(workerCalls.length, b2)
})

test('Connect LinkedIn review round 2: a same-device concurrent write is not a revocation; the account check needs the notice, stops on a challenge, and never re-runs on a rotation', async () => {
  db.prepare('DELETE FROM rate_limits').run()
  const pairNew = async (id: string) => { await consent(id); asUser(id); const c = (await (await settingsPost({ action: 'pair', platform: 'linkedin' })).json() as { code: string }).code; return (await (await extPost(c, { action: 'pair' })).json() as { device_token: string }).device_token }
  for (const t of ['F', 'G', 'H', 'I']) db.prepare('INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, ?, 0)').run(t, t, 'owner')

  // (R7) a rotation sync by the SAME device lands during its own first sync's account check, and a Settings "Test connection" during a
  // check:true sync: every request answers 200 and the browser stays paired.
  const tokF = await pairNew('F')
  let inner = 0
  duringWorkerCall = async () => { inner = (await extPost(tokF, { action: 'session', li_at: `${LI_AT}r`, jsessionid: JSID })).status }
  assert.equal((await extPost(tokF, { action: 'session', li_at: LI_AT, jsessionid: JSID })).status, 200)
  assert.equal(inner, 200)
  let fromSettings: unknown = null
  duringWorkerCall = async () => { duringWorkerCall = null; asUser('F'); fromSettings = await (await settingsPost({ action: 'test', platform: 'linkedin' })).json() }
  assert.equal((await extPost(tokF, { action: 'session', li_at: LI_AT, jsessionid: JSID, check: true })).status, 200)
  assert.deepEqual(fromSettings, { ok: true, name: 'Dana Okoye' })
  assert.equal((await extPost(tokF, { action: 'status' })).status, 200, 'still paired')

  // (R8) the notice withdrawn, the connector switched back on by hand: "Test connection" makes no LinkedIn read.
  const tokG = await pairNew('G')
  assert.equal((await extPost(tokG, { action: 'session', li_at: LI_AT, jsessionid: JSID })).status, 200)
  asUser('G')
  assert.equal((await settingsPost({ action: 'revoke', platform: 'linkedin' })).status, 200)
  assert.equal((await settingsPost({ action: 'toggle', platform: 'linkedin', enabled: true })).status, 200)
  const nG = workerCalls.length
  assert.deepEqual(await (await settingsPost({ action: 'test', platform: 'linkedin' })).json(), { ok: false, outcome: 'no_consent' })
  assert.equal(workerCalls.length, nG)

  // (R9) LinkedIn answers the account check with a challenge: the session goes off and a cooldown starts, visibly; the next check reads nothing.
  const tokH = await pairNew('H')
  workerAnswer = { status: 502, body: { error: 'fetch_failed', outcome: 'challenge' } }
  const first = await (await extPost(tokH, { action: 'session', li_at: LI_AT, jsessionid: JSID })).json() as { check: string | null }
  assert.equal(first.check, 'challenge')
  assert.equal((db.prepare("SELECT enabled FROM tenant_connectors WHERE tenant_id = 'H' AND connector = 'adv:linkedin'").get() as { enabled: number }).enabled, 0)
  assert.deepEqual((db.prepare("SELECT status FROM connector_audit WHERE tenant_id = 'H' AND connector = 'adv:linkedin' ORDER BY created_at, rowid").all() as { status: string }[]).map(r => r.status), ['stopped_challenge', 'session_disabled'])
  const nH = workerCalls.length
  asUser('H')
  assert.deepEqual(await (await settingsPost({ action: 'test', platform: 'linkedin' })).json(), { ok: false, outcome: 'connector_off' })
  assert.equal(workerCalls.length, nH)

  // (R10) the first check failed (a worker error, name still unknown): a later background rotation makes NO account read.
  const tokI = await pairNew('I')
  workerAnswer = { status: 502, body: { error: 'fetch_failed', outcome: 'upstream_error' } }
  assert.equal(((await (await extPost(tokI, { action: 'session', li_at: LI_AT, jsessionid: JSID })).json()) as { check: string }).check, 'upstream_error')
  const nI = workerCalls.length
  assert.equal((await extPost(tokI, { action: 'session', li_at: `${LI_AT}x`, jsessionid: JSID })).status, 200)
  assert.equal(workerCalls.length, nI, 'a rotation never re-runs the check')
  workerAnswer = { status: 200, body: { name: 'Dana Okoye', public_id: 'dana-okoye-test', upstream_requests: 1 } }
})

test('Connect LinkedIn review round 3: the device secret is the write key (a replaced browser writes nothing); a same-device write underneath is absorbed by the retry', async () => {
  db.prepare('DELETE FROM rate_limits').run()
  db.prepare("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES ('J', 'J', 'owner', 0)").run()
  await consent('J'); asUser('J')
  const pair = async () => { const c = (await (await settingsPost({ action: 'pair', platform: 'linkedin' })).json() as { code: string }).code; return (await (await extPost(c, { action: 'pair' })).json() as { device_token: string }).device_token }
  const d1 = await pair()
  assert.equal((await extPost(d1, { action: 'session', li_at: LI_AT, jsessionid: JSID })).status, 200)
  const d2 = await pair()   // the user paired again (another browser): d1 is replaced
  const credBefore = (db.prepare("SELECT ciphertext FROM tenant_connectors WHERE tenant_id = 'J' AND connector = 'adv:linkedin'").get() as { ciphertext: string }).ciphertext
  const devBefore = (db.prepare("SELECT ciphertext FROM tenant_connectors WHERE tenant_id = 'J' AND connector = ?").get(DEVICE_CONNECTOR) as { ciphertext: string }).ciphertext
  assert.equal(await saveSessionFromDevice(adb, 'J', d1.split('.')[1], `li_at=${LI_AT}OLD; JSESSIONID="ajax:1234567890123456789"`), false, "the replaced browser's secret writes nothing")
  assert.equal(await recordAccount(adb, 'J', d1.split('.')[1], { name: 'Someone Else', public_id: null }), false)
  assert.equal((db.prepare("SELECT ciphertext FROM tenant_connectors WHERE tenant_id = 'J' AND connector = 'adv:linkedin'").get() as { ciphertext: string }).ciphertext, credBefore)
  assert.equal((db.prepare("SELECT ciphertext FROM tenant_connectors WHERE tenant_id = 'J' AND connector = ?").get(DEVICE_CONNECTOR) as { ciphertext: string }).ciphertext, devBefore)
  assert.equal((await extPost(d1, { action: 'session', li_at: LI_AT, jsessionid: JSID })).status, 401)
  assert.equal((await extPost(d2, { action: 'status' })).status, 200)

  // The retry: a Db whose transaction re-encrypts the device row (the same device, a fresh IV) just before the conditional UPDATE runs, as a
  // concurrent same-device write would on Postgres. The write still lands (on the second try) and keeps the other write's content.
  const ctxOf = `connector:J:${DEVICE_CONNECTOR}`
  let interfered = 0
  const racing: Db = { ...adb, tx: (body: (t: Tx) => ReturnType<Parameters<Db['tx']>[0]>) => adb.tx(function* (t: Tx) {
    const wrapped: Tx = { ...t, run: function* (sql: string, params?: unknown[]) {
      if (interfered === 0 && /^UPDATE tenant_connectors SET ciphertext = \? WHERE .* AND ciphertext = \?$/.test(sql) && params?.[2] === DEVICE_CONNECTOR) {
        interfered++
        const cur = db.prepare('SELECT ciphertext FROM tenant_connectors WHERE tenant_id = ? AND connector = ?').get('J', DEVICE_CONNECTOR) as { ciphertext: string }
        db.prepare('UPDATE tenant_connectors SET ciphertext = ? WHERE tenant_id = ? AND connector = ?').run(encryptSecret(decryptSecret(cur.ciphertext, ctxOf), ctxOf), 'J', DEVICE_CONNECTOR)
      }
      return yield* t.run(sql, params as never)
    } } as Tx
    return yield* body(wrapped)
  }) } as Db
  assert.equal(await recordAccount(racing, 'J', d2.split('.')[1], { name: 'Dana Okoye', public_id: null }), true, 'absorbed by the retry')
  assert.equal(interfered, 1)
  const st = JSON.parse(decryptSecret((db.prepare('SELECT ciphertext FROM tenant_connectors WHERE tenant_id = ? AND connector = ?').get('J', DEVICE_CONNECTOR) as { ciphertext: string }).ciphertext, ctxOf)) as { name: string }
  assert.equal(st.name, 'Dana Okoye')
})
