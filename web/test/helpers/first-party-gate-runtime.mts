// The #390 deployment gate, OFF side: with DAZL_FIRST_PARTY_ENABLED unset (the default) or any value other than the
// exact literal '1', first-party collection is unavailable - the public hook answers exactly like an unknown tenant
// (same 404, before any DB read, body read, signature work or rate-limit side effect), and the settings route refuses
// record/enable while disable, erase and GET status keep working (an owner can always stop/erase). Run by
// test/first-party-gate.test.ts, which spawns this with the flag removed from the environment.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setDb, sqliteDb } from '../../lib/db/client.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { recordConfig, setCollection, signBody } from '../../lib/signals/first-party.ts'

assert.equal(process.env.DAZL_FIRST_PARTY_ENABLED, undefined, 'the gate runtime must start with the flag unset (the default)')
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
const { POST: hookPOST } = await import('../../app/api/hooks/first-party/route.ts')
const { GET: cfgGET, POST: cfgPOST } = await import('../../app/api/settings/first-party/route.ts')

const now = () => Math.floor(Date.now() / 1000)
const CFG = { site_domain: 'seller.test', basis: 'consent', privacy_url: 'https://seller.test/privacy', retention_days: 90 } as const
const hook = (tenant: string, raw: string, headers: Record<string, string>) =>
  hookPOST(new NextRequest(`https://dazl.test/api/hooks/first-party?u=${tenant}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw }))
const signed = (secret: string, raw: string, ts = now()) => ({ 'x-dazl-timestamp': String(ts), 'x-dazl-signature': signBody(secret, ts, raw) })
const cfg = (body: unknown) => cfgPOST(new NextRequest('http://localhost/api/settings/first-party', {
  method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' }, body: JSON.stringify(body),
}))
const eventBody = () => JSON.stringify({ events: [{ id: 'evt-1', type: 'demo_request', occurred_at: new Date().toISOString(), page_url: 'https://seller.test/demo', consent: 'granted', person: { email: 'pat@acme.io', name: 'Pat' } }] })

const fresh = () => {
  const raw = new Database(':memory:')
  migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  setDb(db)
  return { raw, db }
}
const fpCounts = (raw: Database.Database) => ({
  leads: (raw.prepare("SELECT COUNT(*) AS n FROM leads WHERE source_kind = 'first_party'").get() as { n: number }).n,
  events: (raw.prepare("SELECT COUNT(*) AS n FROM lead_enrichments WHERE connector = 'first_party'").get() as { n: number }).n,
  jobs: (raw.prepare("SELECT COUNT(*) AS n FROM scan_jobs WHERE industry = 'first_party'").get() as { n: number }).n,
  withdrawals: (raw.prepare('SELECT COUNT(*) AS n FROM first_party_withdrawals').get() as { n: number }).n,
  configs: (raw.prepare("SELECT COUNT(*) AS n FROM tenant_connectors WHERE connector = 'first_party'").get() as { n: number }).n,
  meta: (raw.prepare('SELECT COUNT(*) AS n FROM first_party_config_meta').get() as { n: number }).n,
})

test('gate OFF (flag unset): a valid signed hook for a configured tenant answers exactly like an unknown tenant and stores nothing', async () => {
  const { raw, db } = fresh()
  const secret = await recordConfig(db, 'tenantA', CFG, 'actor')
  const body = eventBody()
  const gated = await hook('tenantA', body, signed(secret, body))
  const unknown = await hook('nobody', body, signed(secret, body))
  assert.equal(gated.status, 404)
  assert.equal(unknown.status, 404)
  // (g): identical status, body and content-type - no oracle that the feature exists or is off.
  assert.equal(await gated.text(), await unknown.text())
  assert.equal(gated.headers.get('content-type'), unknown.headers.get('content-type'))
  assert.deepEqual(JSON.parse(await (await hook('tenantA', body, signed(secret, body))).text()), { error: 'Not found' })
  assert.deepEqual(fpCounts(raw), { leads: 0, events: 0, jobs: 0, withdrawals: 0, configs: 1, meta: 1 }) // only the config the test recorded
  raw.close()
})

test("gate OFF values: '0', 'true', '' and ' 1' all stay off for the hook and for record", async () => {
  const { raw, db } = fresh()
  const secret = await recordConfig(db, 'tenantA', CFG, 'actor')
  const body = eventBody()
  try {
    for (const v of ['0', 'true', '', ' 1']) {
      process.env.DAZL_FIRST_PARTY_ENABLED = v
      assert.equal((await hook('tenantA', body, signed(secret, body))).status, 404, `flag ${JSON.stringify(v)}: hook must stay gated`)
      const r = await cfg({ action: 'record', ...CFG })
      assert.equal(r.status, 403, `flag ${JSON.stringify(v)}: record must be refused`)
    }
  } finally { delete process.env.DAZL_FIRST_PARTY_ENABLED }
  assert.deepEqual(fpCounts(raw), { leads: 0, events: 0, jobs: 0, withdrawals: 0, configs: 1, meta: 1 })
  raw.close()
})

test('gate OFF: record and enable are refused with a fixed 403, no DB write and no audit row; disable, erase and GET keep working', async () => {
  const { raw, db } = fresh()
  const auditRows = () => (raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action IN ('consent.accepted', 'connector.enabled')").get() as { n: number }).n

  // record refused: no config, no meta, no audit row claiming consent.
  const rec = await cfg({ action: 'record', ...CFG })
  assert.equal(rec.status, 403)
  assert.deepEqual(await rec.json(), { error: 'First-party collection is not available on this deployment.' })
  assert.deepEqual(fpCounts(raw), { leads: 0, events: 0, jobs: 0, withdrawals: 0, configs: 0, meta: 0 })
  assert.equal(auditRows(), 0)

  // A config that exists but is opted out cannot be re-enabled while the gate is off. The session tenant is 'A'
  // (the test resolver's requireUser), so the lib-level setup records the config for 'A'.
  await recordConfig(db, 'A', CFG, 'actor')
  await setCollection(db, 'A', false)
  const en = await cfg({ action: 'enable' })
  assert.equal(en.status, 403)
  assert.deepEqual(await en.json(), { error: 'First-party collection is not available on this deployment.' })
  assert.equal((raw.prepare("SELECT enabled FROM tenant_connectors WHERE connector = 'first_party'").get() as { enabled: number }).enabled, 0)
  assert.equal(auditRows(), 0)

  // GET status works and says the collection is unavailable, without any secret material.
  const st = await cfgGET(new NextRequest('http://localhost/api/settings/first-party', { headers: { origin: 'http://localhost', host: 'localhost' } }))
  assert.equal(st.status, 200)
  const status = await st.json() as Record<string, unknown>
  assert.equal(status.available, false)
  assert.equal(status.configured, true)
  assert.equal(status.collecting, false)
  assert.equal('secret' in status, false)

  // disable and erase still work OFF: an owner can always stop and erase.
  await setCollection(db, 'A', true)
  const dis = await cfg({ action: 'disable' })
  assert.equal(dis.status, 200)
  assert.equal((await dis.json()).changed, true)
  const erase = await cfg({ action: 'erase' })
  assert.equal(erase.status, 200)
  assert.deepEqual(fpCounts(raw), { leads: 0, events: 0, jobs: 0, withdrawals: 0, configs: 0, meta: 0 })
  const st2 = await (await cfgGET(new NextRequest('http://localhost/api/settings/first-party', { headers: { origin: 'http://localhost', host: 'localhost' } }))).json() as Record<string, unknown>
  assert.equal(st2.available, false)
  assert.equal(st2.configured, false)
  raw.close()
})
