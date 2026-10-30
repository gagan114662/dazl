// #436: the REAL /api/settings/advanced handlers. Only the session lookup is replaced (tenant-route-db.ts); no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { saveCredential } from '../../lib/connectors/store.ts'

process.env.DB_PATH ??= path.join(mkdtempSync(path.join(tmpdir(), 'dazl-adv-')), 'app.db')
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
Object.assign(process.env, { ADVANCED_CONNECTORS: '1', ADVANCED_WORKER_URL: 'http://worker.internal:9000', ADVANCED_WORKER_TOKEN: 't' })
globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch
const route = await import('../../app/api/settings/advanced/route.ts')
const db = new Database(':memory:'); migrateAllSqlite(db); setScanDb(db)
setUser({ id: 'A', business_name: 'A' })
const post = async (body: unknown) => { const r = (await route.POST(new NextRequest('http://localhost/api/settings/advanced', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' }, body: JSON.stringify(body) })))!; return { status: r.status, json: await r.json() } }
const get = async () => (await (await route.GET())!.json()) as { platforms: { platform: string; supported: boolean; consent: boolean; connected: boolean; enabled: boolean }[] }
const row = async (p: string) => (await get()).platforms.find(x => x.platform === p)!

test('unsupported adapters take no consent and no session; supported ones are unchanged; a saved session can be removed', async () => {
  assert.deepEqual((await get()).platforms.map(p => [p.platform, p.supported]), [['linkedin', true], ['x', true], ['reddit', true], ['instagram', true], ['facebook', false], ['xiaohongshu', false], ['bilibili', true]])
  const version = ((await (await route.GET())!.json()) as { version: string }).version
  for (const p of ['facebook', 'xiaohongshu']) {
    assert.equal((await post({ platform: p, action: 'consent', accept: true, version })).status, 409)
    assert.equal((await post({ platform: p, action: 'save', session: 'c_user=1; xs=abcdefgh' })).status, 409)
    assert.equal((await post({ platform: p, action: 'toggle', enabled: true })).status, 409)
    assert.equal((db.prepare('SELECT count(*) n FROM tenant_connectors WHERE tenant_id = ? AND connector = ?').get('A', `adv:${p}`) as { n: number }).n, 0, 'no session stored')
  }
  // consent is per scope: accepting for reddit does not make facebook usable
  assert.equal((await post({ platform: 'reddit', action: 'consent', accept: true, version })).status, 200)
  assert.equal((await post({ platform: 'reddit', action: 'save', session: 'reddit_session=abcdefgh' })).status, 200)
  assert.deepEqual(await row('reddit'), { ...(await row('reddit')), supported: true, connected: true, enabled: true })
  // a facebook session saved before this change: shown as connected so it can be removed, never re-enabled
  saveCredential(db, 'A', 'adv:facebook', 'c_user=1; xs=from-before', Buffer.from(process.env.DAZL_MASTER_KEY!, 'base64'))
  assert.equal((await row('facebook')).connected, true)
  assert.equal((await post({ platform: 'facebook', action: 'toggle', enabled: false })).status, 200)
  const del = (await route.DELETE(new NextRequest('http://localhost/api/settings/advanced?platform=facebook', { method: 'DELETE', headers: { host: 'localhost' } })))!
  assert.equal(del.status, 200)
  assert.equal((await row('facebook')).connected, false)
})
