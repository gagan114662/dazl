// #436: the real /api/settings/advanced handlers on a synthetic SQLite store, two tenants. A platform with no fetcher
// (Facebook, XiaoHongShu) is reported supported: false with its reason, takes no consent, session or switch, and still
// lets a session stored earlier be removed. A supported platform keeps working. Run by test/advanced-routes.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { saveCredential } from '../../lib/connectors/store.ts'

process.env.DAZL_MASTER_KEY = Buffer.alloc(32, 7).toString('base64') // test-only key for the credential columns
Object.assign(process.env, { ADVANCED_CONNECTORS: '1', ADVANCED_WORKER_URL: 'https://worker.invalid', ADVANCED_WORKER_TOKEN: 'test-token' })
delete process.env.ADVANCED_KILL
const advanced = await import('../../app/api/settings/advanced/route.ts')
const req = (url: string, method = 'GET', body?: unknown) => new NextRequest(`https://app.dazl.test${url}`, {
  method, headers: { 'content-type': 'application/json', host: 'app.dazl.test', origin: 'https://app.dazl.test', 'x-forwarded-for': '203.0.113.7' },
  body: body === undefined ? undefined : JSON.stringify(body) })
const call = async (r: Response | Promise<Response>) => { const x = await r; return { status: x.status, body: await x.json() as Record<string, unknown> } }

test('settings: unsupported platforms say so and accept nothing; supported ones are unchanged', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db); setScanDb(db)
  const A = 'tenant-a'
  setUser({ id: A, business_name: 'Co' })
  // a Facebook session stored before this fix, switched on
  saveCredential(db, A, 'adv:facebook', 'c_user=1; xs=synthetic-not-real-1234', Buffer.from(process.env.DAZL_MASTER_KEY!, 'base64'))
  const rows = () => db.prepare("SELECT (SELECT count(*) FROM advanced_consent WHERE tenant_id = ?) AS consent, (SELECT count(*) FROM tenant_connectors WHERE tenant_id = ?) AS creds").get(A, A)
  let r = await call(advanced.GET())
  const fb = (r.body.platforms as Record<string, unknown>[]).find(p => p.platform === 'facebook')!
  const xhs = (r.body.platforms as Record<string, unknown>[]).find(p => p.platform === 'xiaohongshu')!
  const reddit = (r.body.platforms as Record<string, unknown>[]).find(p => p.platform === 'reddit')!
  assert.equal(fb.supported, false); assert.match(String(fb.unsupported_reason), /browser worker/); assert.equal(fb.connected, true)
  assert.equal(fb.enabled, false, 'a stored session for an unsupported platform is never reported as on')
  assert.equal(xhs.supported, false); assert.match(String(xhs.unsupported_reason), /signing/)
  assert.equal(reddit.supported, true); assert.equal(reddit.unsupported_reason, null)
  const before = rows()
  for (const p of ['facebook', 'xiaohongshu']) {
    for (const body of [{ action: 'consent', accept: true, version: r.body.version }, { action: 'save', session: 'c_user=1; xs=another-synthetic-5678' }, { action: 'toggle', enabled: true }]) {
      const x = await call(advanced.POST(req('/api/settings/advanced', 'POST', { platform: p, ...body })))
      assert.equal(x.status, 409, `${p} ${body.action}`); assert.equal(x.body.unsupported, true)
    }
  }
  assert.deepEqual(rows(), before, 'no consent and no session was written for an unsupported platform')
  // the earlier session can still be removed
  r = await call(advanced.DELETE(req('/api/settings/advanced?platform=facebook', 'DELETE')))
  assert.equal(r.body.ok, true); assert.equal((rows() as { creds: number }).creds, 0)
  // reddit still takes consent and a session
  r = await call(advanced.POST(req('/api/settings/advanced', 'POST', { platform: 'reddit', action: 'consent', accept: true, version: (await call(advanced.GET())).body.version })))
  assert.equal(r.status, 200)
  r = await call(advanced.POST(req('/api/settings/advanced', 'POST', { platform: 'reddit', action: 'save', session: 'reddit_session=synthetic-not-real-9' })))
  assert.equal(r.status, 200); assert.equal((rows() as { creds: number }).creds, 1)
})
