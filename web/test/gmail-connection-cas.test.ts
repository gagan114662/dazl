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
  test(`disconnect/reconnect race: the old row is gone before the revoke, a reconnect during the revoke stays (${label})`, async () => {
    const db = mk(); await connect(db, 'me@acme.example', 'rt-old')
    let revokes = 0, rowDuringRevoke: unknown = 'unset'
    await disconnectGmail(db, 'A', { env, master, fetchImpl: (async (url: string) => {
      revokes++
      assert.match(String(url), /revoke/)
      rowDuringRevoke = row(db)                 // #928: the local delete already happened, synchronously
      await connect(db, newEmail, 'rt-new')     // the user reconnects while the old grant's revoke is in flight
      return json({})
    }) as unknown as typeof fetch })
    assert.equal(revokes, 1)
    assert.equal(rowDuringRevoke, undefined, 'a sync racing the revoke already sees the old connection gone')
    assert.deepEqual(row(db), { email: newEmail, status: 'active' }, 'the reconnect made during the revoke is intact')
  })
  test(`old connection's disconnect does not delete a replacement that landed before its delete (${label})`, async () => {
    const db = mk(); await connect(db, 'me@acme.example', 'rt-old')
    const old = db.prepare("SELECT refresh_ct FROM gmail_accounts WHERE tenant_id = 'A'").get() as { refresh_ct: string }
    // Another process replaces the connection between this call's read and its delete (multi-process PG/SQLite).
    let replaced = false
    const racy = new Proxy(db, { get(t, k) {
      if (k !== 'prepare') { const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v }
      return (sql: string) => {
        const st = t.prepare(sql)
        if (!/^SELECT refresh_ct FROM gmail_accounts/.test(sql)) return st
        return { get: (...a: unknown[]) => {
          const r = st.get(...a)
          if (!replaced) { replaced = true; t.prepare("UPDATE gmail_accounts SET refresh_ct = 'other-ct', email = ? WHERE tenant_id = 'A'").run(newEmail) }
          return r
        } }
      }
    } }) as Database.Database
    let revokes = 0
    const err = await disconnectGmail(racy, 'A', { env, master, fetchImpl: (async () => { revokes++; return json({}) }) as unknown as typeof fetch }).catch((e: unknown) => e)
    assert.ok(replaced, 'the race was exercised')
    assert.ok(err instanceof GmailError && err.message === 'connection_replaced', 'a stale disconnect is not reported as success')
    assert.equal(revokes, 0, 'the old grant is not revoked when it was replaced (same-account revoke could kill the replacement)')
    assert.deepEqual(row(db), { email: newEmail, status: 'active' })
    assert.notEqual(old.refresh_ct, 'other-ct')
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
