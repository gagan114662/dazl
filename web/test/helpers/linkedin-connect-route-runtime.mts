// One-click Connect LinkedIn (#1037, #1122) through the real route handlers: Settings asks for a pairing code, the dazl Connect extension
// trades it for a device token, and with that token asks /api/tasks/next for LinkedIn pages to read in the user's own browser. dazl stores
// no LinkedIn session and makes no LinkedIn or worker request. Synthetic fixture: throwaway SQLite, mocked session (tenant-route loader).
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
import { enqueueTask, migrateLiTasks } from '../../lib/linkedin-tasks/store.ts'
import * as settings from '../../app/api/settings/advanced/route.ts'
import * as ext from '../../app/api/extension/linkedin/route.ts'
import * as next from '../../app/api/tasks/next/route.ts'
import * as complete from '../../app/api/tasks/complete/route.ts'

const db = new Database(':memory:')
migrateAllSqlite(db)
setScanDb(db)
const adb = sqliteDb(db)
for (const [t, m, role] of [['A', 'A', 'owner'], ['B', 'B', 'owner']]) db.prepare('INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, ?, 0)').run(t, m, role)

// No outbound call of any kind: dazl's server never talks to LinkedIn or to a session worker.
const outbound: string[] = []
globalThis.fetch = (async (u: string) => { outbound.push(String(u)); throw new Error(`unexpected outbound call ${u}`) }) as typeof fetch

const asUser = (id: string, role: 'owner' | 'viewer' = 'owner') => setUser({ id, business_name: `Co ${id}`, role })
const settingsPost = (body: unknown) => settings.POST(new NextRequest('http://localhost/api/settings/advanced', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' }, body: JSON.stringify(body) }))
const extPost = (bearer: string | null, body: unknown) => ext.POST(new NextRequest('http://localhost/api/extension/linkedin', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) }))
const nextTask = (bearer: string | null) => next.GET(new NextRequest('http://localhost/api/tasks/next', { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }))
const done = (bearer: string, body: unknown) => complete.POST(new NextRequest('http://localhost/api/tasks/complete', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) }))
const LI_AT = `AQEDAR${'x'.repeat(60)}`, JSID = '"ajax:1234567890123456789"'
const consent = async (id: string) => { asUser(id); assert.equal((await settingsPost({ action: 'consent', platform: 'linkedin', accept: true, version: CONSENT_VERSION })).status, 200) }
const pairBody = { action: 'pair', platform: 'linkedin', timezone: 'America/Toronto' }

test('Connect LinkedIn: pair once, then the device token reads tasks; no session is stored or accepted; isolation, revocation, Disconnect', async () => {
  asUser('A')
  assert.equal((await settingsPost(pairBody)).status, 403, 'the notice first')
  await consent('A')
  assert.equal((await settingsPost({ action: 'pair', platform: 'linkedin' })).status, 400, 'the browser time zone is required')
  const pr = await settingsPost(pairBody)
  assert.equal(pr.status, 200)
  const { code, expires_at } = await pr.json() as { code: string; expires_at: number }
  assert.match(code, /^A\.[A-Za-z0-9_-]{43}$/); assert.ok(expires_at - Math.floor(Date.now() / 1000) <= PAIR_TTL_S)
  assert.deepEqual((await connectorStatus(adb, 'A')).map(c => c.connector), [])

  assert.equal((await extPost(null, { action: 'pair' })).status, 401)
  assert.equal((await extPost(`A.${'x'.repeat(43)}`, { action: 'pair' })).status, 401)
  const paired = await extPost(code, { action: 'pair' })
  assert.equal(paired.status, 200)
  assert.equal(paired.headers.get('access-control-allow-origin'), null, 'no CORS')
  const { device_token } = await paired.json() as { device_token: string }
  assert.equal((await extPost(code, { action: 'pair' })).status, 401, 'a code is spent once')
  assert.equal((await nextTask(code)).status, 401, 'a spent code is not a device token')

  // An old build that still sends cookies: refused with 410, nothing stored. Settings' pasted session and server check: 410.
  assert.equal((await extPost(device_token, { action: 'session', li_at: LI_AT, jsessionid: JSID })).status, 410)
  assert.equal(await readEnabledCredential(adb, 'A', 'adv:linkedin'), null)
  asUser('A')
  assert.equal((await settingsPost({ action: 'save', platform: 'linkedin', session: `li_at=${LI_AT}` })).status, 410)
  assert.equal((await settingsPost({ action: 'test', platform: 'linkedin' })).status, 410)
  assert.equal(await readEnabledCredential(adb, 'A', 'adv:linkedin'), null)

  // The device token reads tasks; the workspace's zone came from the Settings browser.
  assert.equal((await nextTask(null)).status, 401)
  assert.equal((await nextTask(device_token)).status, 200)
  migrateLiTasks(db)
  assert.equal((db.prepare("SELECT tz FROM li_task_gate WHERE tenant_id = 'A'").get() as { tz?: string } | undefined)?.tz, 'America/Toronto')
  await enqueueTask(adb, 'A', 'company_people', 'https://www.linkedin.com/company/acme-test/people/', 'job1')
  const r = await (await nextTask(device_token)).json() as { task?: { id: string }; wait?: string }
  if (r.task) assert.equal((await done(device_token, { id: r.task.id, people: [] })).status, 200)
  else assert.ok(['outside_hours'].includes(r.wait!), JSON.stringify(r))

  // Another workspace: A's secret under B's prefix is refused.
  await consent('B'); asUser('B')
  const bCode = (await (await settingsPost(pairBody)).json() as { code: string }).code
  const bDev = (await (await extPost(bCode, { action: 'pair' })).json() as { device_token: string }).device_token
  assert.equal((await nextTask(`B.${device_token.split('.')[1]}`)).status, 401)

  // The notice withdrawn: the extension gets nothing to read.
  asUser('A')
  assert.equal((await settingsPost({ action: 'revoke', platform: 'linkedin' })).status, 200)
  assert.equal((await nextTask(device_token)).status, 403)
  await consent('A')
  assert.equal((await nextTask(device_token)).status, 200)

  // The pairing member's role lowered: the device stops at once.
  db.prepare("UPDATE memberships SET role = 'viewer' WHERE tenant_id = 'A' AND member_id = 'A'").run()
  assert.equal((await nextTask(device_token)).status, 401)
  db.prepare("UPDATE memberships SET role = 'owner' WHERE tenant_id = 'A' AND member_id = 'A'").run()

  // Disconnect: the token is dead; B is untouched.
  asUser('A')
  assert.equal((await settings.DELETE(new NextRequest('http://localhost/api/settings/advanced?platform=linkedin', { method: 'DELETE' }))).status, 200)
  assert.equal((await nextTask(device_token)).status, 401)
  assert.equal((await nextTask(bDev)).status, 200)
  assert.deepEqual(outbound, [], 'no outbound request at all')
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
  assert.equal((await settingsPost({ action: 'pair', platform: 'linkedin', timezone: 'America/Toronto' })).status, 403)
  // the operator's own switch for Connect LinkedIn; the session-worker switches no longer decide it (every workspace pairs its own browser)
  process.env.DAZL_LINKEDIN_CONNECT = '0'
  try { assert.equal((await extPost('A.whatever', { action: 'pair' })).status, 404) } finally { delete process.env.DAZL_LINKEDIN_CONNECT }
  const keep = { c: process.env.ADVANCED_CONNECTORS, l: process.env.ADVANCED_LINKEDIN }
  process.env.ADVANCED_CONNECTORS = '0'; process.env.ADVANCED_LINKEDIN = '0'
  try { assert.notEqual((await extPost('A.whatever', { action: 'pair' })).status, 404, 'with the worker tier off, the extension endpoint still answers') } finally { process.env.ADVANCED_CONNECTORS = keep.c; process.env.ADVANCED_LINKEDIN = keep.l }
})
