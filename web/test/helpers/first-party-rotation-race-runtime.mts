// #921: the real /api/hooks/first-party handler, with a config change deterministically interleaved AFTER the route
// verified the signature and BEFORE ingest takes the config lock (the db's first transaction after the route's config
// read runs the change first). The request must never be stored under the replacement config. SQLite and Postgres.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { setDb, type Db } from '../../lib/db/client.ts'
import { bothEngines } from './engines.ts'
import { eraseFirstParty, recordConfig, setCollection, signBody, type FpConfigInput } from '../../lib/signals/first-party.ts'

process.env.DAZL_MASTER_KEY ??= randomBytes(32).toString('base64')
const { POST } = await import('../../app/api/hooks/first-party/route.ts')

const CFG: FpConfigInput = { site_domain: 'seller.test', basis: 'consent', privacy_url: 'https://seller.test/privacy', retention_days: 90 }
const now = () => Math.floor(Date.now() / 1000)
let n = 0
const tenant = () => `race${++n}`
const body = (id: string, domain = 'seller.test') => JSON.stringify({ events: [{ id, type: 'demo_request', occurred_at: new Date().toISOString(), page_url: `https://${domain}/demo`, consent: 'granted', person: { email: `pat${id}@acme.io`, name: 'Pat' } }] })
const post = (t: string, raw: string, secret: string) => { const ts = now(); return POST(new NextRequest(`https://dazl.test/api/hooks/first-party?u=${t}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dazl-timestamp': String(ts), 'x-dazl-signature': signBody(secret, ts, raw) }, body: raw })) }
const events = async (db: Db, t: string) => (await db.all("SELECT 1 FROM lead_enrichments WHERE tenant_id = ? AND connector = 'first_party'", [t])).length
const leads = async (db: Db, t: string) => (await db.all("SELECT 1 FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ? AND l.source_kind = 'first_party'", [t])).length

// The route reads the config with a plain read (tenant_connectors), verifies, then ingest opens its transaction. Arm on
// that read; the next tx runs `between` on the real store first, so the change commits in exactly that gap.
function interleaved(inner: Db, between: () => Promise<void>): { db: Db; fired: () => boolean } {
  let armed = false, fired = false
  const db = new Proxy(inner, { get(o, k) {
    if (k === 'get') return (sql: string, p?: unknown[]) => { if (!fired && /tenant_connectors/.test(sql)) armed = true; return o.get(sql, p as never) }
    if (k === 'tx') return async (fn: never) => { if (armed && !fired) { fired = true; await between() } return o.tx(fn) }
    const v = Reflect.get(o, k, o); return typeof v === 'function' ? v.bind(o) : v
  } }) as Db
  return { db, fired: () => fired }
}

const CASES: [string, (db: Db, t: string) => Promise<void>, number][] = [
  ['re-record rotates the secret (same domain/retention)', (db, t) => recordConfig(db, t, CFG, 'actor').then(() => undefined), 404],
  ['re-record with a changed domain and retention', (db, t) => recordConfig(db, t, { ...CFG, site_domain: 'other.test', retention_days: 30 }, 'actor').then(() => undefined), 404],
  ['erase', (db, t) => eraseFirstParty(db, t).then(() => undefined), 404],
  ['erase then re-record', async (db, t) => { await eraseFirstParty(db, t); await recordConfig(db, t, CFG, 'actor') }, 404],
  ['disable (same secret)', (db, t) => setCollection(db, t, false).then(() => undefined), 403],
]
for (const [name, change, status] of CASES) {
  bothEngines(`#921 hook: ${name} between route verification and ingest lock -> ${status}, nothing stored`, async ({ db }) => {
    const t = tenant()
    const secret = await recordConfig(db, t, CFG, 'actor')
    const w = interleaved(db, () => change(db, t)); setDb(w.db)
    const r = await post(t, body('e1'), secret)
    assert.equal(w.fired(), true, 'the change ran in the gap')
    assert.equal(r.status, status)
    assert.equal(await events(db, t), 0); assert.equal(await leads(db, t), 0)
  })
}

bothEngines('#921 hook control: no interleaved change -> 200 created, and a request signed with the NEW secret after rotation is accepted', async ({ db }) => {
  const t = tenant()
  const secret = await recordConfig(db, t, CFG, 'actor'); setDb(db)
  const r = await post(t, body('ok1'), secret)
  assert.equal(r.status, 200); assert.deepEqual((await r.json()).counts, { created: 1 })
  const fresh = await recordConfig(db, t, CFG, 'actor')
  assert.equal((await post(t, body('ok2'), secret)).status, 404, 'the retired secret is refused outright')
  const r2 = await post(t, body('ok2'), fresh)
  assert.equal(r2.status, 200); assert.equal(await events(db, t), 2)
})
