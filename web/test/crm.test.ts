import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { pushLead, saveCrmConfig, getCrmConfig, disconnectCrm } from '../lib/crm/index.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import type { Lookup } from '../lib/net/public-fetch.ts'

const pubLookup: Lookup = async () => [{ address: '93.184.216.34', family: 4 }]

const master = randomBytes(32)
const LEAD = { company: 'Acme Co', name: 'Ada Lovelace', contact: 'ada@acme.example', signal: 'hired VP Sales', source_url: 'https://x.com/1', fit: 5, intent: 4, why: 'why now' }
const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200 })

test('crm config: save/get roundtrip encrypted, webhook requires https, bad blobs rejected', () => {
  const db = new Database(':memory:'); migrateConnectors(db)
  saveCrmConfig(db, 'A', { provider: 'hubspot', key: 'pat-na1-abcdef' }, master)
  assert.deepEqual(getCrmConfig(db, 'A', master), { provider: 'hubspot', key: 'pat-na1-abcdef' })
  // ciphertext, not plaintext, at rest
  const raw = db.prepare("SELECT ciphertext FROM tenant_connectors WHERE tenant_id = 'A' AND connector = 'crm'").get() as { ciphertext: string } | undefined
  assert.ok(raw && !raw.ciphertext.includes('pat-na1'))
  saveCrmConfig(db, 'A', { provider: 'webhook', url: 'http://insecure.example/x' }, master)
  assert.equal(getCrmConfig(db, 'A', master), null) // http webhook refused
  assert.equal(getCrmConfig(db, 'B', master), null)
  assert.equal(disconnectCrm(db, 'A'), true)
  assert.equal(getCrmConfig(db, 'A', master), null)
})

test('pushLead hubspot: standard properties only; 409 means already exists; errors throw', async () => {
  let seen: { url: string; body: { properties: Record<string, unknown> } } | null = null
  const f = async (url: RequestInfo | URL, init?: RequestInit) => { seen = { url: String(url), body: JSON.parse(String(init?.body)) }; return ok({ id: '1' }) }
  const msg = await pushLead({ provider: 'hubspot', key: 'k' }, LEAD, f as never)
  assert.equal(msg, 'Contact created in HubSpot')
  assert.equal(seen!.url, 'https://api.hubapi.com/crm/v3/objects/contacts')
  assert.deepEqual(seen!.body.properties, { email: 'ada@acme.example', firstname: 'Ada', lastname: 'Lovelace', company: 'Acme Co', hs_lead_status: 'NEW' })
  const conflict = await pushLead({ provider: 'hubspot', key: 'k' }, LEAD, (async () => new Response('{}', { status: 409 })) as never)
  assert.equal(conflict, 'Already in HubSpot (matching contact exists)')
  await assert.rejects(() => pushLead({ provider: 'hubspot', key: 'k' }, LEAD, (async () => new Response('{}', { status: 401 })) as never))
})

test('pushLead pipedrive + webhook payloads', async () => {
  let url = ''; let body: Record<string, unknown> = {}
  const f = async (u: RequestInfo | URL, init?: RequestInit) => { url = String(u); body = JSON.parse(String(init?.body)); return ok({ success: true }) }
  const msg = await pushLead({ provider: 'pipedrive', key: 'tok123' }, LEAD, f as never)
  assert.equal(msg, 'Person created in Pipedrive')
  assert.ok(url.startsWith('https://api.pipedrive.com/v1/persons?api_token=tok123'))
  assert.deepEqual(body, { name: 'Ada Lovelace', email: 'ada@acme.example', org_name: 'Acme Co' })
  const wmsg = await pushLead({ provider: 'webhook', url: 'https://hooks.example/dazl' }, LEAD, f as never, { lookup: pubLookup })
  assert.equal(wmsg, 'Lead sent to your webhook')
  assert.equal(url, 'https://hooks.example/dazl')
  assert.equal((body as unknown as { event: string }).event, 'lead.pushed')
  assert.equal((body as unknown as { lead: { company: string } }).lead.company, 'Acme Co')
  await assert.rejects(() => pushLead({ provider: 'webhook', url: 'https://hooks.example/dazl' }, LEAD, (async () => new Response('x', { status: 500 })) as never, { lookup: pubLookup }))
})
