// #436 route gates: unsupported platforms expose supported:false + reason and refuse consent,
// session save and enable, while cleanup paths (revoke, toggle off) and supported platforms work.
// Synthetic fixture: throwaway SQLite, mocked session (tenant-route loader), no network.
// Synthetic worker env AFTER the net-fence import scrubbed inherited *TOKEN* vars (same pattern as
// pg-port-routes-2-runtime.mts): without URL+TOKEN advFlags().enabled is false and every POST 404s at the
// platform gate. The fence still blocks all network; the route under test never calls the worker.
Object.assign(process.env, { ADVANCED_CONNECTORS: '1', ADVANCED_WORKER_URL: 'https://worker.invalid', ADVANCED_WORKER_TOKEN: 'test-token' })
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateConnectors } from '../../lib/connectors/store.ts'
import { migrateAdvanced } from '../../lib/advanced/index.ts'
import { CONSENT_VERSION } from '../../lib/advanced/config.ts'
import { GET, POST } from '../../app/api/settings/advanced/route.ts'

const db = new Database(':memory:')
migrateConnectors(db); migrateAdvanced(db)
setScanDb(db)
setUser({ id: 'A', business_name: 'Co A' })

const post = (body: unknown) => POST(new NextRequest('http://localhost/api/settings/advanced', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' },
  body: JSON.stringify(body),
}))

test('settings advanced route: capability gates', async () => {
  const get = await GET()
  assert.equal(get.status, 200)
  const st = await get.json() as { platforms: { platform: string; supported?: boolean; unsupported_reason?: string | null }[] }
  const fb = st.platforms.find(p => p.platform === 'facebook')
  const xhs = st.platforms.find(p => p.platform === 'xiaohongshu')
  const rd = st.platforms.find(p => p.platform === 'reddit')
  assert.equal(fb?.supported, false); assert.match(fb?.unsupported_reason ?? '', /browser worker/)
  assert.equal(xhs?.supported, false); assert.match(xhs?.unsupported_reason ?? '', /signing/)
  assert.equal(rd?.supported, true); assert.equal(rd?.unsupported_reason, null)

  // No consent, session save or enable for an unsupported platform.
  for (const body of [
    { action: 'consent', platform: 'facebook', accept: true, version: CONSENT_VERSION },
    { action: 'save', platform: 'facebook', session: 's'.repeat(30) },
    { action: 'toggle', platform: 'facebook', enabled: true },
    { action: 'consent', platform: 'xiaohongshu', accept: true, version: CONSENT_VERSION },
  ]) {
    const r = await post(body)
    assert.equal(r.status, 404, JSON.stringify(body))
  }

  // Cleanup paths stay open, and a supported platform still consents.
  assert.equal((await post({ action: 'toggle', platform: 'facebook', enabled: false })).status, 200)
  assert.equal((await post({ action: 'revoke', platform: 'facebook' })).status, 200)
  const ok = await post({ action: 'consent', platform: 'reddit', accept: true, version: CONSENT_VERSION })
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { ok: true })
})
