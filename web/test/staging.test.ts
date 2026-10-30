// Staging mode (lib/staging.ts): Gmail is stubbed so no email can leave a staging server, and the demo seed
// (scripts/staging-seed.mts) is staging-only and idempotent. Outside staging the real Gmail path is unchanged.
// Any network call fails the test (the fetch stubs below record or throw); nothing leaves the process.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { disconnectGmail, getAccessToken, gmailSend, gmailStatus, startOAuth } from '../lib/gmail/oauth.ts'
import { syncReplies, acceptReadConsent } from '../lib/outreach/replies.ts'

const T = 'e'.repeat(32)
const master = randomBytes(32)
const noNetwork = (async (u: unknown) => { throw new Error(`network call in staging: ${String(u)}`) }) as unknown as typeof fetch
const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env); for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]
  try { await fn() } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const mk = () => { const db = new Database(':memory:'); migrateAllSqlite(db); return db }

test('staging: connecting Gmail is a stub account, tokens and sends make no network call, reply sync reads nothing', async () => {
  await withEnv({ DAZL_ENV: 'staging', GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined }, async () => {
    const db = mk()
    const to = startOAuth(db, T, { env: { PUBLIC_BASE_URL: 'https://staging.dazl.ai', DAZL_ENV: 'staging' } as never, master })
    assert.equal(to, 'https://staging.dazl.ai/app/settings?gmail=connected', 'no Google round trip')
    assert.deepEqual(gmailStatus(db, T), { email: 'sender-eeeeeeee@staging.dazl.test', status: 'active', read_granted: true })
    const token = await getAccessToken(db, T, { fetchImpl: noNetwork, master })
    const sent = await gmailSend(token, 'cmF3', noNetwork)
    assert.match(sent.id, /^stub[0-9a-f]{16}$/)
    assert.equal(sent.threadId, sent.id)
    assert.equal((await gmailSend(token, 'cmF3', noNetwork, 'thread1')).threadId, 'thread1')
    acceptReadConsent(db, T)
    assert.deepEqual(await syncReplies(db, T, { fetchImpl: noNetwork, master }), { threads: 0, replies: 0, optOuts: 0, bounces: 0, consents: 0, reviews: 0, partial: false, remaining: 0 })
    await disconnectGmail(db, T, { fetchImpl: noNetwork, master })
    assert.equal(gmailStatus(db, T), null)
  })
})

test('outside staging the real Gmail path is unchanged: Google is required and a send goes to the Gmail API', async () => {
  await withEnv({ DAZL_ENV: undefined }, async () => {
    const db = mk()
    assert.throws(() => startOAuth(db, T, { env: {}, master }), /google_not_configured/)
    const calls: string[] = []
    const f = (async (u: string) => { calls.push(u); return new Response(JSON.stringify({ id: 'g1', threadId: 't1' })) }) as unknown as typeof fetch
    assert.deepEqual(await gmailSend('real-token', 'cmF3', f), { id: 'g1', threadId: 't1' })
    assert.deepEqual(calls, ['https://gmail.googleapis.com/gmail/v1/users/me/messages/send'])
  })
})

test('the staging seed: refuses outside staging; creates the demo account once; a re-run changes nothing', async () => {
  const { seedStaging, DEMO_EMAIL } = await import('../scripts/staging-seed.mts')
  await withEnv({ DAZL_ENV: undefined }, async () => {
    await assert.rejects(seedStaging(mk(), 'long-enough-password'), /refusing to run without DAZL_ENV=staging/)
  })
  await withEnv({ DAZL_ENV: 'staging', DAZL_MASTER_KEY: master.toString('base64') }, async () => {
    const db = mk()
    await assert.rejects(seedStaging(db, 'short'), /at least 12/)
    const r = await seedStaging(db, 'long-enough-password')
    assert.equal(r.created, true)
    const counts = () => db.prepare("SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM scan_jobs WHERE status = 'done') j, (SELECT count(*) FROM leads) l, (SELECT count(*) FROM gmail_accounts) g").get()
    assert.deepEqual(counts(), { u: 1, j: 2, l: 5, g: 1 })
    assert.equal((await seedStaging(db, 'long-enough-password')).created, false)
    assert.deepEqual(counts(), { u: 1, j: 2, l: 5, g: 1 }, 'idempotent')
    const u = db.prepare('SELECT email, buyer_profile FROM users').get() as { email: string; buyer_profile: string }
    assert.equal(u.email, DEMO_EMAIL)
    assert.ok(JSON.parse(u.buyer_profile).summary)
    // every seeded URL and address is on a reserved test domain
    const urls = (db.prepare('SELECT source_url FROM leads').all() as { source_url: string }[]).map(r => new URL(r.source_url).hostname)
    assert.ok(urls.every(h => h.endsWith('.example.test')), urls.join(','))
  })
})
