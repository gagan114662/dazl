// #1603: the Gmail connect asks Google for gmail.send only. gmail.readonly is a restricted scope (verification plus a
// yearly security assessment), so no connect started by dazl may request it. Synthetic addresses, injected fetch, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { completeOAuth, gmailStatus, GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE, startOAuth, type OAuthDeps } from '../lib/gmail/oauth.ts'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { hasReadConsent, migrateReplies } from '../lib/outreach/replies.ts'

const env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', PUBLIC_BASE_URL: 'https://app.example' }
const master = Buffer.alloc(32, 7)
const NOW = 1_800_000_000
const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url')}.y`
const tokenFetch = (scope: string) => (async () => new Response(JSON.stringify({ refresh_token: 'rt', scope, id_token: idToken('owner@sender.example') }), { status: 200 })) as unknown as typeof fetch
const fresh = () => { const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateReplies(db); return db }

test('#1603 connect requests exactly openid, email and gmail.send', () => {
  const url = new URL(startOAuth(fresh(), 'A', { env, now: NOW }))
  assert.deepEqual(url.searchParams.get('scope')!.split(' '), ['openid', 'email', GMAIL_SEND_SCOPE])
  assert.equal(url.searchParams.get('include_granted_scopes'), null, 'earlier grants are not folded back in')
})

test('#1603 no caller option can add gmail.readonly to the request', () => {
  const url = new URL(startOAuth(fresh(), 'A', { env, now: NOW, withRead: true } as OAuthDeps))
  assert.ok(!url.searchParams.get('scope')!.includes('gmail.readonly'))
  assert.ok(!url.toString().includes('readonly'))
})

test('#1603 a new connection is send-only and records no reply-reading consent', async () => {
  const db = fresh()
  const state = new URL(startOAuth(db, 'A', { env, now: NOW })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env, master, now: NOW, fetchImpl: tokenFetch(`openid email ${GMAIL_SEND_SCOPE}`) })
  assert.deepEqual(gmailStatus(db, 'A'), { email: 'owner@sender.example', status: 'active', read_granted: false })
  assert.equal(hasReadConsent(db, 'A'), false)
})

test('#1603 reconnecting an account that had the old read scope leaves it send-only', async () => {
  const db = fresh()
  const first = new URL(startOAuth(db, 'A', { env, now: NOW })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', first, { env, master, now: NOW, fetchImpl: tokenFetch(`openid email ${GMAIL_SEND_SCOPE} ${GMAIL_READ_SCOPE}`) })
  assert.equal(gmailStatus(db, 'A')!.read_granted, true, 'fixture: an account connected before this change')
  const again = new URL(startOAuth(db, 'A', { env, now: NOW + 60 })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', again, { env, master, now: NOW + 60, fetchImpl: tokenFetch(`openid email ${GMAIL_SEND_SCOPE}`) })
  assert.equal(gmailStatus(db, 'A')!.read_granted, false)
})

test('#1603 the connect route starts a plain send-only connect and does not record reply-reading consent', () => {
  const src = readFileSync(new URL('../app/api/gmail/connect/route.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /withRead|acceptReadConsent|readonly/)
  assert.match(src, /startOAuth\(db, user\.tenantId\)/)
})

test('#1603 no Connect Gmail screen shows the reply-reading notice or says connecting accepts it', () => {
  for (const f of ['../app/app/onboarding/first-review.tsx', '../app/app/settings/gmail-panel.tsx', '../app/app/settings/replies-panel.tsx', '../app/app/gmail-gate.tsx', '../app/api/outreach/settings/route.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /read_notice|agree to the reply-reading|untick the read access|leave the read access ticked/, f)
  }
})
