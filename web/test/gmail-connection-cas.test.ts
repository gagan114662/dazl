// #740: a late callback of an OLD Gmail connection must not mutate a NEWER one (disconnect and reconnect, to another address or
// the same one with a new refresh token). Identity is the stored refresh ciphertext, compared in the write itself. Synthetic
// tenant and addresses, stub HTTP, no real OAuth or Gmail call.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { completeOAuth, disconnectGmail, getAccessToken, startOAuth, GmailError } from '../lib/gmail/oauth.ts'

const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const SEND = 'https://www.googleapis.com/auth/gmail.send'

function mk() { const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); return db }
async function connect(db: Database.Database, email: string, refresh: string) {
  const state = new URL(startOAuth(db, 'A', { env, now: NOW })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: refresh, scope: `openid email ${SEND}`, id_token: idToken(email) })) as unknown as typeof fetch })
}
const row = (db: Database.Database) => db.prepare("SELECT email, status FROM gmail_accounts WHERE tenant_id = 'A'").get() as { email: string; status: string } | undefined

for (const [label, newEmail] of [['another address', 'new@new.example'], ['the same address, new refresh token', 'me@acme.example']] as const) {
  test(`old connection's invalid_grant callback does not pause a replacement (${label})`, async () => {
    const db = mk(); await connect(db, 'me@acme.example', 'rt-old')
    const err = await getAccessToken(db, 'A', { env, master, now: NOW, fetchImpl: (async () => {
      db.prepare("DELETE FROM gmail_accounts WHERE tenant_id = 'A'").run()
      await connect(db, newEmail, 'rt-new')
      return json({ error: 'invalid_grant' }, 400)
    }) as unknown as typeof fetch }).catch((e: unknown) => e)
    assert.ok(err instanceof GmailError); assert.notEqual(err.kind, 'reconnect', 'the replacement is not told to reconnect')
    assert.deepEqual(row(db), { email: newEmail, status: 'active' }, 'the newer connection is intact and active')
  })
  test(`old connection's token success is not handed out for a replacement (${label})`, async () => {
    const db = mk(); await connect(db, 'me@acme.example', 'rt-old')
    const err = await getAccessToken(db, 'A', { env, master, now: NOW, fetchImpl: (async () => {
      db.prepare("DELETE FROM gmail_accounts WHERE tenant_id = 'A'").run()
      await connect(db, newEmail, 'rt-new')
      return json({ access_token: 'old-at' })
    }) as unknown as typeof fetch }).catch((e: unknown) => e)
    assert.ok(err instanceof GmailError && err.message === 'connection_replaced')
    assert.deepEqual(row(db), { email: newEmail, status: 'active' })
  })
  test(`old connection's disconnect does not delete a replacement (${label})`, async () => {
    const db = mk(); await connect(db, 'me@acme.example', 'rt-old')
    const err = await disconnectGmail(db, 'A', { env, master, fetchImpl: (async () => {
      db.prepare("DELETE FROM gmail_accounts WHERE tenant_id = 'A'").run()
      await connect(db, newEmail, 'rt-new')
      return json({})
    }) as unknown as typeof fetch }).catch((e: unknown) => e)
    assert.ok(err instanceof GmailError && err.message === 'connection_replaced', 'a stale disconnect is not reported as success')
    assert.deepEqual(row(db), { email: newEmail, status: 'active' })
  })
}

test('controls: an unreplaced connection still pauses on invalid_grant, hands out its token, and disconnects', async () => {
  const db = mk(); await connect(db, 'me@acme.example', 'rt-old')
  assert.equal(await getAccessToken(db, 'A', { env, master, now: NOW, fetchImpl: (async () => json({ access_token: 'at' })) as unknown as typeof fetch }), 'at')
  const err = await getAccessToken(db, 'A', { env, master, now: NOW, fetchImpl: (async () => json({ error: 'invalid_grant' }, 400)) as unknown as typeof fetch }).catch((e: unknown) => e)
  assert.ok(err instanceof GmailError && err.kind === 'reconnect')
  assert.deepEqual(row(db), { email: 'me@acme.example', status: 'needs_reconnect' })
  await disconnectGmail(db, 'A', { env, master, fetchImpl: (async () => json({})) as unknown as typeof fetch })
  assert.equal(row(db), undefined)
})
