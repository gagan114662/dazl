// Real staging Gmail transport (#413): guarded, default OFF, never reached from production. Synthetic addresses and an injected
// fetch only: no network, no real mailbox, no real send.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { GmailError, getAccessToken, gmailSend, recipientsAllowed, startOAuth, type OAuthEnv } from '../lib/gmail/oauth.ts'
import { gmailIsStubbed, parseGmailAllowlist, stagingGmail } from '../lib/staging.ts'
import { toBase64Url } from '../lib/gmail/mime.ts'

const OK_ADDR = 'inbox@owner.example'
const REAL: OAuthEnv = { DAZL_ENV: 'staging', DAZL_STAGING_REAL_GMAIL: '1', GMAIL_STAGING_CLIENT_ID: 'stg.apps.googleusercontent.com', GMAIL_STAGING_CLIENT_SECRET: 'stg-secret', DAZL_STAGING_GMAIL_ALLOWLIST: OK_ADDR, PUBLIC_BASE_URL: 'https://staging.dazl.test' }
const mimeTo = (to: string, extra = '') => toBase64Url(`From: a@b.example\r\nTo: ${to}\r\n${extra}Subject: s\r\n\r\nbody`)
const recorder = () => { const calls: { url: string; init: RequestInit }[] = []; const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{"id":"18c0ffee","threadId":"18c0ffee"}') }) as unknown as typeof fetch; return { calls, f } }

test('mode: flag off or unset stays the stub; production ignores the flag and any staging config', () => {
  assert.equal(stagingGmail({ DAZL_ENV: 'staging' }).mode, 'stub')
  assert.equal(stagingGmail({ ...REAL, DAZL_STAGING_REAL_GMAIL: '0' }).mode, 'stub')
  assert.equal(stagingGmail({ ...REAL, DAZL_STAGING_REAL_GMAIL: 'true' }).mode, 'stub')
  assert.equal(stagingGmail({ ...REAL, DAZL_ENV: 'production' }).mode, 'off')
  assert.equal(stagingGmail({ ...REAL, DAZL_ENV: undefined }).mode, 'off')
  assert.equal(gmailIsStubbed({ DAZL_ENV: 'staging' }), true)
  assert.equal(gmailIsStubbed(REAL as Record<string, string | undefined>), false)
  assert.equal(gmailIsStubbed({ DAZL_ENV: 'production' }), false)
})

test('mode: flag on with incomplete or loose config is misconfigured (fails closed), never real', () => {
  for (const [why, patch] of [
    ['no client id', { GMAIL_STAGING_CLIENT_ID: '' }], ['no secret', { GMAIL_STAGING_CLIENT_SECRET: undefined }],
    ['no allowlist', { DAZL_STAGING_GMAIL_ALLOWLIST: '' }], ['wildcard', { DAZL_STAGING_GMAIL_ALLOWLIST: '*@owner.example' }],
    ['domain only', { DAZL_STAGING_GMAIL_ALLOWLIST: 'owner.example' }], ['one bad entry', { DAZL_STAGING_GMAIL_ALLOWLIST: `${OK_ADDR},oops` }],
  ] as const) assert.equal(stagingGmail({ ...REAL, ...patch }).mode, 'misconfigured', why)
  assert.deepEqual([...parseGmailAllowlist(' A@B.example , c@d.example ').allowlist], ['a@b.example', 'c@d.example'])
})

test('(a) flag off + real-looking credentials: still stubbed, zero provider calls', async () => {
  const { calls, f } = recorder()
  const r = await gmailSend('whatever', mimeTo('anyone@elsewhere.example'), f, undefined, { DAZL_ENV: 'staging', GMAIL_STAGING_CLIENT_ID: 'x', GMAIL_STAGING_CLIENT_SECRET: 'y', DAZL_STAGING_GMAIL_ALLOWLIST: OK_ADDR })
  assert.match(r.id, /^stub[0-9a-f]{16}$/)
  assert.equal(calls.length, 0)
})

test('(b) flag on + allowlisted recipient: a real Gmail request is built', async () => {
  const { calls, f } = recorder()
  const raw = mimeTo(`Owner <${OK_ADDR.toUpperCase()}>`)
  assert.deepEqual(await gmailSend('real-access-token', raw, f, 'th1', REAL), { id: '18c0ffee', threadId: '18c0ffee' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer real-access-token')
  assert.deepEqual(JSON.parse(calls[0].init.body as string), { raw, threadId: 'th1' })
})

test('(c) flag on + any non-allowlisted recipient (To, Cc, Bcc, folded, extra, none): refused with zero provider calls', async () => {
  for (const [why, raw] of [
    ['other To', mimeTo('x@elsewhere.example')], ['two To, one outside', mimeTo(`${OK_ADDR}, x@elsewhere.example`)],
    ['Cc outside', mimeTo(OK_ADDR, 'Cc: x@elsewhere.example\r\n')], ['Bcc outside', mimeTo(OK_ADDR, 'Bcc: x@elsewhere.example\r\n')],
    ['folded Cc outside', mimeTo(OK_ADDR, `Cc: ${OK_ADDR},\r\n x@elsewhere.example\r\n`)], ['lookalike domain', mimeTo('inbox@owner.example.evil.example')],
    ['display-name trick', mimeTo(`"${OK_ADDR}" <x@elsewhere.example>`)], ['no recipient header', toBase64Url('From: a@b.example\r\n\r\nbody')],
    ['not a mime', 'synthetic-mime'],
  ] as const) {
    const { calls, f } = recorder()
    await assert.rejects(gmailSend('real-access-token', raw, f, undefined, REAL), (e: unknown) => e instanceof GmailError && e.kind === 'config', why)
    assert.equal(calls.length, 0, why)
  }
  assert.equal(recipientsAllowed(mimeTo(OK_ADDR), new Set([OK_ADDR])), true)
})

test('flag on: the stub token never reaches the real endpoint; misconfigured refuses every call', async () => {
  const { calls, f } = recorder()
  await assert.rejects(gmailSend('staging-stub-token', mimeTo(OK_ADDR), f, undefined, REAL), GmailError)
  await assert.rejects(gmailSend('t', mimeTo(OK_ADDR), f, undefined, { ...REAL, DAZL_STAGING_GMAIL_ALLOWLIST: '' }), GmailError)
  assert.equal(calls.length, 0)
})

test('(d) flag set under production: ignored, production path unchanged', async () => {
  const { calls, f } = recorder()
  // production sends to any recipient exactly as before: no allowlist applies
  await gmailSend('prod-token', mimeTo('anyone@elsewhere.example'), f, undefined, { ...REAL, DAZL_ENV: 'production' })
  assert.equal(calls.length, 1)
})

test('OAuth: staging real uses the staging client and callback; stub and misconfigured stay safe; production keeps the production client', async () => {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE oauth_states (state_hash TEXT, tenant_id TEXT, verifier TEXT, expires_at INTEGER, read_scope INTEGER); CREATE TABLE gmail_accounts (tenant_id TEXT PRIMARY KEY, email TEXT, refresh_ct TEXT, status TEXT, read_granted INTEGER, connected_at INTEGER)')
  const u = new URL(startOAuth(db, 't1', { env: REAL }))
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(u.searchParams.get('client_id'), 'stg.apps.googleusercontent.com')
  assert.equal(u.searchParams.get('redirect_uri'), 'https://staging.dazl.test/api/gmail/callback')
  assert.equal(u.searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/gmail.send')
  assert.throws(() => startOAuth(db, 't1', { env: { ...REAL, GMAIL_STAGING_CLIENT_ID: '' } }), GmailError)
  assert.match(startOAuth(db, 't2', { env: { DAZL_ENV: 'staging', PUBLIC_BASE_URL: 'https://staging.dazl.test' }, master: Buffer.alloc(32, 1) }), /gmail=connected/)
  const p = new URL(startOAuth(db, 't3', { env: { DAZL_ENV: 'production', GOOGLE_CLIENT_ID: 'prod', GOOGLE_CLIENT_SECRET: 's', GMAIL_STAGING_CLIENT_ID: 'stg', PUBLIC_BASE_URL: 'https://dazl.ai' } }))
  assert.equal(p.searchParams.get('client_id'), 'prod')
  // token refresh in real mode asks Google with the staging client
  db.prepare("INSERT INTO gmail_accounts (tenant_id, email, refresh_ct, status, read_granted) VALUES ('t9','x@y.example','junk','active',0)").run()
  await assert.rejects(getAccessToken(db, 't9', { env: { ...REAL, GMAIL_STAGING_CLIENT_SECRET: '' } }), GmailError)
})
