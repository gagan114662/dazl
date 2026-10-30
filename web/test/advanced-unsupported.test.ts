// #436: a session source with no fetcher (Facebook, XiaoHongShu) must read as unsupported, and a failed fetch as its
// own failure, never as a search that found nothing. Synthetic only: the "platforms" are stubs of the global fetch,
// the worker is the real session-worker handler on a loopback server, and the app side is the real httpWorker and
// collectAdvanced writing the real audit. No platform is contacted and no real session exists.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateConnectors, saveCredential, recentAudit } from '../lib/connectors/store.ts'
import { migrateAdvanced, acceptConsent, collectAdvanced, httpWorker } from '../lib/advanced/index.ts'
import { ADV_PLATFORMS, UNSUPPORTED as APP_UNSUPPORTED, connectorId } from '../lib/advanced/config.ts'
import { CHANNELS } from '../lib/channels.ts'
import { socialSources } from '../lib/scan/source-availability.ts'
import { FETCHERS, PLATFORMS, UNSUPPORTED as WORKER_UNSUPPORTED } from '../../session-worker/src/fetchers.ts'
import { handleFetch } from '../../session-worker/src/handle.ts'

const master = randomBytes(32)
const SESSIONS: Record<string, string> = { reddit: 'reddit_session=synthetic-not-real-0001', x: 'auth_token=' + 'a'.repeat(40) + '; ct0=' + 'b'.repeat(32), facebook: 'c_user=1; xs=synthetic-not-real', xiaohongshu: 'a1=synthetic-not-real' }

test('one capability list: the worker and the app agree which platforms have no fetcher, and the UI calls them not built', () => {
  assert.deepEqual(Object.keys(APP_UNSUPPORTED).sort(), Object.keys(WORKER_UNSUPPORTED).sort())
  assert.deepEqual([...PLATFORMS].sort(), [...ADV_PLATFORMS].sort())
  for (const p of PLATFORMS) {
    assert.equal(!!FETCHERS[p], !WORKER_UNSUPPORTED[p], `${p}: a fetcher exists exactly when it is supported`)
    const ch = CHANNELS.find(c => c.platform === p)!
    assert.equal(ch.status === 'soon', !!APP_UNSUPPORTED[p], `${p}: the Settings badge says "Coming soon" exactly when it is unsupported`)
  }
  assert.ok(APP_UNSUPPORTED.facebook && APP_UNSUPPORTED.xiaohongshu)
})

// The platforms, as the worker's fetchers see them through the global fetch. Loopback (the worker itself) passes through.
type Platform = (url: string) => Response | Promise<Response>
function stubPlatforms(platform: Platform) {
  const real = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (/^http:\/\/127\.0\.0\.1:/.test(url)) return real(input as RequestInfo, init)
    calls.push(url)
    return platform(url)
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = real } }
}
const redditPost = { data: { children: [{ data: { permalink: '/r/sales/comments/abc/acme_is_hiring/', title: 'Acme Robotics is hiring its first sales lead', selftext: 'Acme Robotics is hiring its first sales lead in Ohio this month', created_utc: 1761700000 } }] } }
const json = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('worker: unsupported is 501 and fetches nothing; each failure has its own status; only a real answer is 200', async () => {
  let current: Platform = () => json(200, redditPost)
  const s = stubPlatforms(u => current(u))
  try {
    const call = (platform: string, session = SESSIONS[platform] ?? 'cookie=synthetic', query = 'sales hiring') => handleFetch(JSON.stringify({ platform, query, session }), {})
    for (const p of ['facebook', 'xiaohongshu']) {
      const r = await call(p)
      assert.equal(r.status, 501, p); assert.equal(r.body.error, 'unsupported'); assert.match(String(r.body.reason), /not implemented|not built/)
    }
    assert.deepEqual(s.calls, [], 'an unsupported platform is never contacted')
    let r = await call('reddit'); assert.equal(r.status, 200); assert.equal((r.body.items as unknown[]).length, 1)
    current = () => json(200, { data: { children: [] } }); r = await call('reddit')
    assert.deepEqual(r, { status: 200, body: { items: [] } }, 'the platform answered and found nothing: the only empty 200')
    for (const [resp, kind, status] of [
      [() => json(401, {}), 'auth', 502], [() => json(403, {}), 'auth', 502], [() => json(429, {}), 'throttled', 502],
      [() => json(500, {}), 'upstream', 502], [() => json(200, '<html>login</html>'), 'schema', 502],
      [() => { throw new TypeError('fetch failed') }, 'upstream', 502],
    ] as [Platform, string, number][]) {
      current = resp; r = await call('reddit')
      assert.deepEqual(r, { status, body: { error: kind } }, kind)
    }
    current = () => json(200, redditPost)
    assert.deepEqual(await call('x', 'cookie=not-an-x-session'), { status: 400, body: { error: 'no_session' } }, 'a session without the cookies X needs')
    assert.deepEqual(await call('reddit', ''), { status: 400, body: { error: 'no_session' } })
    assert.deepEqual(await call('myspace'), { status: 400, body: { error: 'unknown_platform' } })
    // a fetcher bug is a failure too, not "no results"
    assert.deepEqual(await handleFetch(JSON.stringify({ platform: 'reddit', query: 'q', session: 's' }), {}, { reddit: async () => { throw new Error('bug') } }), { status: 502, body: { error: 'worker_error' } })
  } finally { s.restore() }
})

// worker -> app: the real handler behind a loopback server, the app's real httpWorker and collectAdvanced, the audit.
test('end to end: the scan audit records unsupported / auth_failed / throttled / schema_error / no_session apart from empty and ok', async () => {
  const workerHits: string[] = []
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c }); req.on('end', async () => {
      workerHits.push(JSON.parse(body).platform)
      const r = await handleFetch(body, {})
      res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.body))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const env = { ADVANCED_CONNECTORS: '1', ADVANCED_WORKER_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, ADVANCED_WORKER_TOKEN: 't', X_VIA_SEARCH: '0' }
  let current: Platform = () => json(200, redditPost)
  const s = stubPlatforms(u => current(u))
  const db = new Database(':memory:'); migrateConnectors(db); migrateAdvanced(db)
  acceptConsent(db, 'A', 'advanced')
  // sessions stored earlier, also for the unsupported platforms (a tenant who connected before this fix)
  for (const p of ['reddit', 'facebook', 'xiaohongshu']) saveCredential(db, 'A', connectorId(p as 'reddit'), SESSIONS[p], master)
  const run = async (platforms: string[], job: string) => {
    const out = await collectAdvanced(db, 'A', job, platforms as ('reddit')[], 'sales hiring', { worker: httpWorker(env), master, env })
    return { out, audit: (recentAudit(db, 'A', 50) as { connector: string; scan_job_id: string; status: string; results: number }[]).filter(a => a.scan_job_id === job).map(a => `${a.connector}=${a.status}/${a.results}`).sort() }
  }
  try {
    let r = await run(['facebook', 'xiaohongshu'], 'j-unsupported')
    assert.deepEqual(r.audit, ['adv:facebook=unsupported/0', 'adv:xiaohongshu=unsupported/0'])
    assert.deepEqual(r.out, []); assert.deepEqual(workerHits, [], 'their stored sessions are never sent anywhere'); assert.deepEqual(s.calls, [])
    r = await run(['reddit'], 'j-ok'); assert.deepEqual(r.audit, ['adv:reddit=ok/1']); assert.equal(r.out.length, 1)
    current = () => json(200, { data: { children: [] } })
    r = await run(['reddit'], 'j-empty'); assert.deepEqual(r.audit, ['adv:reddit=empty/0'])
    for (const [resp, status] of [[() => json(401, {}), 'auth_failed'], [() => json(429, {}), 'throttled'], [() => json(200, 'not json'), 'schema_error'], [() => json(503, {}), 'worker_error']] as [Platform, string][]) {
      current = resp; r = await run(['reddit'], `j-${status}`)
      assert.deepEqual(r.audit, [`adv:reddit=${status}/0`], status); assert.deepEqual(r.out, [])
    }
    // X with no stored session: the worker gets '' and says no_session
    r = await run(['x'], 'j-x'); assert.deepEqual(r.audit, ['adv:x=no_session/0'])
    // the worker itself unreachable, or answering a 200 without items: failures, not empty
    const down = await collectAdvanced(db, 'A', 'j-down', ['reddit'], 'q', { worker: httpWorker({ ...env, ADVANCED_WORKER_URL: 'http://127.0.0.1:1' }), master, env })
    assert.deepEqual(down, []); assert.deepEqual((recentAudit(db, 'A', 50) as { scan_job_id: string; status: string }[]).filter(a => a.scan_job_id === 'j-down').map(a => a.status), ['worker_error'])
    const odd = await httpWorker(env, (async () => json(200, { nothing: true })) as typeof fetch)({ platform: 'reddit', query: 'q', session: 's' })
    assert.deepEqual(odd, { failure: 'schema' })
  } finally { s.restore(); server.close() }
})

test('scan source picker: an unsupported platform reads "not built yet" with nothing to set up', () => {
  const rows = socialSources({ available: true, platforms: [
    { platform: 'facebook', allowed: true, supported: false, consent: true, connected: true, enabled: true },
    { platform: 'reddit', allowed: true, supported: true, consent: true, connected: true, enabled: true },
  ] })
  assert.deepEqual(rows.find(r => r.id === 'social:facebook'), { id: 'social:facebook', label: rows.find(r => r.id === 'social:facebook')!.label, usable: false, reason: 'not built yet' })
  assert.equal(rows.find(r => r.id === 'social:reddit')!.usable, true)
})
