// Postgres port, batch 2 (docs/PLATFORM.md "Postgres port"): the real handlers of the settings, Cal.com and warm-path
// routes this batch moved to the Db layer, run on SQLite and on Postgres from the same seed, two tenants. Every
// response and every row the writes leave behind must be identical on both engines, up to the random ids, secrets and
// clock times the writes generate. On Postgres the raw SQLite handle is a trap, as in pg-port-routes-runtime.mts.
// Synthetic data only; any outbound fetch fails the run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { setDb, sqliteDb, pgDb, type Db } from '../../lib/db/client.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { runPgMigrations } from '../../lib/db/migrate-pg.ts'
import { PG_URL, freshSchema } from './pg-test.ts'

process.env.DB_PATH = '/nonexistent-dazl-dir/app.db' // getAuthDb() cannot open: any raw access fails
process.env.DAZL_MASTER_KEY = Buffer.alloc(32, 7).toString('base64') // test-only key for the credential columns
Object.assign(process.env, { ADVANCED_CONNECTORS: '1', ADVANCED_WORKER_URL: 'https://worker.invalid', ADVANCED_WORKER_TOKEN: 'test-token' })
delete process.env.ADVANCED_KILL
delete process.env.ADVANCED_LINKEDIN
delete process.env.PUBLIC_BASE_URL

const memory = await import('../../app/api/settings/memory/route.ts')
const competitors = await import('../../app/api/settings/competitors/route.ts')
const calcom = await import('../../app/api/settings/calcom/route.ts')
const hook = await import('../../app/api/hooks/calcom/route.ts')
const connectors = await import('../../app/api/settings/connectors/route.ts')
const enrichment = await import('../../app/api/settings/enrichment/route.ts')
const advanced = await import('../../app/api/settings/advanced/route.ts')
const llmKey = await import('../../app/api/settings/llm-key/route.ts')
const warmConnections = await import('../../app/api/warm/connections/route.ts')
const warmPath = await import('../../app/api/leads/[lead]/warm-path/route.ts')

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call: ${String(u)}`) }) as typeof fetch

const A = 'tenantA_fixture', B = 'tenantB_fixture'
const T = 1_790_000_000
const STARTED = Math.floor(Date.now() / 1000) - 5
const J = { a: 'a1'.repeat(12), b: 'b1'.repeat(12) }
const L = { a: 'a2'.repeat(12), b: 'b2'.repeat(12) }
const SEEDED = new Set([A, B, ...Object.values(J), ...Object.values(L)])

const req = (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => new NextRequest(`https://app.dazl.test${url}`, {
  method, headers: { 'content-type': 'application/json', host: 'app.dazl.test', origin: 'https://app.dazl.test', 'x-forwarded-for': '203.0.113.7', ...headers },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = <T extends object>(p: T) => ({ params: Promise.resolve(p) })

async function seed(db: Db): Promise<void> {
  const run = (sql: string, p: (string | number | null)[] = []) => db.run(sql, p)
  for (const [id, email] of [[A, 'a@example.test'], [B, 'b@example.test']]) {
    await run("INSERT INTO users (id, email, password_hash, salt, business_name, created_at) VALUES (?, ?, 'h', 's', 'Co', ?)", [id, email, T])
  }
  for (const [job, user] of [[J.a, A], [J.b, B]]) {
    await run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, created_at) VALUES (?, ?, 'Co', 'dental', 'Toronto', 'q', ?)", [job, user, T])
  }
  for (const job of [J.a, J.b]) await run("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?", [job])
  for (const [lead, job, contact] of [[L.a, J.a, 'pat@firstdental.example'], [L.b, J.b, 'sam@beta.example']]) {
    await run("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, contact, created_at) VALUES (?, ?, 'Pat', 'First Dental', 's', 'https://firstdental.example/jobs', 70, ?, ?)", [lead, job, contact, T])
  }
  // Two people at lead A with LinkedIn profiles, same second: one in A's imported connections, one not.
  for (const [id, who, url] of [['e1', 'Ada Lovelace - CEO', 'https://www.linkedin.com/in/adalovelace/'], ['e2', 'Alan Turing - Engineer', 'https://www.linkedin.com/in/alanturing']]) {
    await run("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES (?, ?, ?, 'apollo', 'contact', ?, ?, '2026-10-01', ?)", [id, L.a, A, who, url, T])
  }
  await run("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at, created_at) VALUES (?, 'anthropic', 'x', '1234', ?, ?)", [A, T, T])
  await run("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at, created_at) VALUES (?, 'openai', 'x', '5678', ?, ?)", [A, T, T])
  await run("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?", [T + 10, J.b])
  await run("UPDATE scan_jobs SET status = 'failed', error = 'key_rejected', finished_at = ? WHERE id = ?", [T + 10, J.a])
}

type Out = { name: string; status: number; body: unknown }
async function call(name: string, res: Response | Promise<Response>): Promise<Out> {
  const r = await res
  const text = await r.text()
  let body: unknown = text
  try { body = JSON.parse(text) } catch { /* not JSON */ }
  return { name, status: r.status, body }
}

// Random ids and secrets become stable tokens in order of first appearance (so "the same id twice" still compares),
// and times the writes take from the clock become 'now'.
function normalizer() {
  const seen = new Map<string, string>()
  const random = (k: string, v: string) => !SEEDED.has(v) && (k === 'secret' || /^[0-9a-f]{8}-[0-9a-f]{4}-|^[0-9a-f]{24,}$/.test(v))
  const walk = (v: unknown, k = ''): unknown => {
    if (Array.isArray(v)) return v.map(x => walk(x, k))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([kk, x]) => [kk, walk(x, kk)]))
    if (typeof v === 'string' && random(k, v)) { if (!seen.has(v)) seen.set(v, `rand#${seen.size}`); return seen.get(v) }
    if (typeof v === 'number' && /_at$/.test(k) && v >= STARTED) return 'now'
    return v
  }
  return walk
}

async function scenario(db: Db): Promise<{ out: Out[]; rows: unknown }> {
  const out: Out[] = []
  setUser({ id: A, business_name: 'Co' })
  out.push(await call('memory empty', memory.GET()))
  out.push(await call('memory save', memory.PUT(req('/api/settings/memory', 'PUT', { icp: ' Dental clinics ', positioning: 'Fast', tone: 'plain', exclusions: ['Acme', 'acme', 'Beta Co'], objections: [{ q: 'Price?', a: 'Flat fee' }] }))))
  out.push(await call('memory bad', memory.PUT(req('/api/settings/memory', 'PUT', { icp: 'x'.repeat(601) }))))
  out.push(await call('memory read', memory.GET()))
  out.push(await call('competitors save', competitors.PUT(req('/api/settings/competitors', 'PUT', { competitors: ['Zed', ' Acme ', 'zed', 'Bee'] }))))
  out.push(await call('competitors read', competitors.GET()))
  out.push(await call('competitors replace', competitors.PUT(req('/api/settings/competitors', 'PUT', { competitors: ['Bee'] }))))
  out.push(await call('competitors after', competitors.GET()))
  out.push(await call('calcom before', calcom.GET(req('/api/settings/calcom'))))
  const rotated = await call('calcom rotate', calcom.POST(req('/api/settings/calcom', 'POST', { action: 'rotate' })))
  out.push(rotated)
  const secret = (rotated.body as { secret: string }).secret
  const booking = (uid: string, email: string) => JSON.stringify({ triggerEvent: 'BOOKING_CREATED', payload: { uid, attendees: [{ email, name: 'Pat' }] } })
  const signed = (raw: string, s = secret) => req(`/api/hooks/calcom?u=${A}`, 'POST', raw, { 'x-cal-signature-256': crypto.createHmac('sha256', s).update(raw).digest('hex') })
  out.push(await call('hook matched', hook.POST(signed(booking('bk-2', ' PAT@firstdental.example')))))
  out.push(await call('hook duplicate', hook.POST(signed(booking('bk-2', 'pat@firstdental.example')))))
  out.push(await call('hook unmatched', hook.POST(signed(booking('bk-1', 'nobody@x.example')))))
  out.push(await call('hook other event', hook.POST(signed(JSON.stringify({ triggerEvent: 'BOOKING_CANCELLED' })))))
  out.push(await call('hook bad signature', hook.POST(signed(booking('bk-3', 'pat@firstdental.example'), 'wrong-secret'))))
  out.push(await call('hook unknown tenant', hook.POST(req(`/api/hooks/calcom?u=${B}`, 'POST', booking('bk-4', 'sam@beta.example')))))
  out.push(await call('calcom after', calcom.GET(req('/api/settings/calcom'))))
  out.push(await call('enrichment save', enrichment.POST(req('/api/settings/enrichment', 'POST', { connector: 'enrich:apollo', key: 'apollo-test-key-0000001234' }))))
  out.push(await call('enrichment save pdl', enrichment.POST(req('/api/settings/enrichment', 'POST', { connector: 'enrich:pdl', key: 'pdl-test-key-00000000005678' }))))
  out.push(await call('enrichment read', enrichment.GET()))
  out.push(await call('enrichment disconnect', enrichment.POST(req('/api/settings/enrichment', 'POST', { connector: 'enrich:pdl', disconnect: true }))))
  out.push(await call('advanced read', advanced.GET()))
  out.push(await call('advanced save before consent', advanced.POST(req('/api/settings/advanced', 'POST', { platform: 'reddit', action: 'save', session: 'reddit-session-abcd' }))))
  const version = (out.at(-2)!.body as { version: string }).version
  out.push(await call('advanced consent', advanced.POST(req('/api/settings/advanced', 'POST', { platform: 'reddit', action: 'consent', accept: true, version }))))
  out.push(await call('advanced save', advanced.POST(req('/api/settings/advanced', 'POST', { platform: 'reddit', action: 'save', session: 'reddit-session-abcd' }))))
  out.push(await call('advanced toggle off', advanced.POST(req('/api/settings/advanced', 'POST', { platform: 'reddit', action: 'toggle', enabled: false }))))
  out.push(await call('advanced after', advanced.GET()))
  out.push(await call('connectors', connectors.GET()))
  out.push(await call('llm key', llmKey.GET()))
  out.push(await call('llm key remove', llmKey.DELETE(req('/api/settings/llm-key', 'DELETE', { vendor: 'openai' }))))
  out.push(await call('llm key after', llmKey.GET()))
  out.push(await call('warm none', warmConnections.GET()))
  const csv = 'First Name,Last Name,URL,Connected On\nAda,Lovelace,https://linkedin.com/in/adalovelace,15 Mar 2024\nAda,L,https://www.linkedin.com/in/AdaLovelace/,16 Mar 2024\nGrace,Hopper,https://linkedin.com/in/gracehopper,01 Jan 2023\nNo,Url,,02 Feb 2024\n'
  out.push(await call('warm import', warmConnections.POST(req('/api/warm/connections', 'POST', { csv }))))
  out.push(await call('warm import again', warmConnections.POST(req('/api/warm/connections', 'POST', { csv }))))
  out.push(await call('warm status', warmConnections.GET()))
  out.push(await call('warm path', warmPath.GET(req(`/api/leads/${L.a}/warm-path`), ctx({ lead: L.a }))))
  out.push(await call('warm report', warmPath.POST(req(`/api/leads/${L.a}/warm-path`, 'POST', { contact_url: 'https://www.linkedin.com/in/alanturing', mutual_name: 'Margaret Hamilton' }), ctx({ lead: L.a }))))
  out.push(await call('warm report dup', warmPath.POST(req(`/api/leads/${L.a}/warm-path`, 'POST', { contact_url: 'https://linkedin.com/in/alanturing/', mutual_name: 'Margaret Hamilton' }), ctx({ lead: L.a }))))
  out.push(await call('warm report 2', warmPath.POST(req(`/api/leads/${L.a}/warm-path`, 'POST', { contact_url: 'https://www.linkedin.com/in/alanturing', mutual_name: 'Katherine Johnson' }), ctx({ lead: L.a }))))
  // created_at is the database clock in whole seconds, so on a slow engine the two reports above can straddle a
  // second. Pin them to one second (the order then comes from insertion), read, then make the second report one
  // second newer (the order then comes from created_at, newest first) and read again, on both engines.
  await db.run('UPDATE warm_user_paths SET created_at = (SELECT MIN(created_at) FROM warm_user_paths WHERE tenant_id = ?) WHERE tenant_id = ?', [A, A])
  out.push(await call('warm path after', warmPath.GET(req(`/api/leads/${L.a}/warm-path`), ctx({ lead: L.a }))))
  await db.run("UPDATE warm_user_paths SET created_at = created_at + 1 WHERE tenant_id = ? AND mutual_name = 'Katherine Johnson'", [A])
  out.push(await call('warm path newer first', warmPath.GET(req(`/api/leads/${L.a}/warm-path`), ctx({ lead: L.a }))))
  // Tenant B: none of A's settings, connections, bookings or paths, and A's lead and path ids get nothing.
  setUser({ id: B, business_name: 'Co' })
  const reported = (out.find(o => o.name === 'warm report')!.body as { path: { id: string } }).path.id
  out.push(await call('B memory', memory.GET()))
  out.push(await call('B competitors', competitors.GET()))
  out.push(await call('B calcom', calcom.GET(req('/api/settings/calcom'))))
  out.push(await call('B enrichment', enrichment.GET()))
  out.push(await call('B advanced', advanced.GET()))
  out.push(await call('B connectors', connectors.GET()))
  out.push(await call('B llm key', llmKey.GET()))
  out.push(await call('B warm status', warmConnections.GET()))
  out.push(await call('B warm path of A', warmPath.GET(req(`/api/leads/${L.a}/warm-path`), ctx({ lead: L.a }))))
  out.push(await call('B report on A', warmPath.POST(req(`/api/leads/${L.a}/warm-path`, 'POST', { contact_url: 'https://www.linkedin.com/in/x', mutual_name: 'Bob' }), ctx({ lead: L.a }))))
  out.push(await call('B remove A path', warmPath.DELETE(req(`/api/leads/${L.a}/warm-path`, 'DELETE', { id: reported }), ctx({ lead: L.a }))))
  out.push(await call('B warm delete', warmConnections.DELETE(req('/api/warm/connections', 'DELETE'))))
  setUser({ id: A, business_name: 'Co' })
  out.push(await call('warm remove path', warmPath.DELETE(req(`/api/leads/${L.a}/warm-path`, 'DELETE', { id: reported }), ctx({ lead: L.a }))))
  out.push(await call('warm delete', warmConnections.DELETE(req('/api/warm/connections', 'DELETE'))))
  out.push(await call('warm path final', warmPath.GET(req(`/api/leads/${L.a}/warm-path`), ctx({ lead: L.a }))))
  const rows = {
    memory: await db.all('SELECT tenant_id, icp, positioning, tone, exclusions, objections FROM tenant_memory ORDER BY tenant_id'),
    competitors: await db.all('SELECT tenant_id, name, position FROM tenant_competitors ORDER BY tenant_id, position'),
    bookings: await db.all('SELECT tenant_id, booking_uid, attendee_email, attendee_name, lead_id FROM calcom_bookings ORDER BY booking_uid'),
    leads: await db.all('SELECT id, stage FROM leads ORDER BY id'),
    credentials: await db.all('SELECT tenant_id, connector, last4, enabled FROM tenant_connectors ORDER BY tenant_id, connector'),
    consent: await db.all('SELECT tenant_id, scope, version FROM advanced_consent ORDER BY tenant_id, scope'),
    audit: await db.all('SELECT tenant_id, connector, lookup, status, results FROM connector_audit ORDER BY insert_seq'),
    keys: await db.all('SELECT tenant_id, vendor, last4 FROM tenant_llm_keys ORDER BY tenant_id, vendor'),
    connections: await db.all('SELECT tenant_id, name, linkedin_url, connected_on FROM tenant_connections ORDER BY tenant_id, linkedin_url'),
    paths: await db.all('SELECT tenant_id, lead_id, contact_url, mutual_name FROM warm_user_paths ORDER BY insert_seq'),
  }
  return { out: normalizer()(out) as Out[], rows }
}

async function onSqlite() {
  const lite = new Database(':memory:')
  migrateAllSqlite(lite)
  setScanDb(lite)
  await seed(sqliteDb(lite))
  return scenario(sqliteDb(lite))
}

async function onPg() {
  const s = await freshSchema()
  const pg = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 3 })
  try {
    await runPgMigrations(pg.pool)
    setScanDb(null as unknown as Database.Database) // getScanDb() now throws 'test database unset'
    setDb(pg)
    await seed(pg)
    return await scenario(pg)
  } finally { await pg.close(); await s.drop() }
}

const by = (out: Out[], n: string) => out.find(o => o.name === n)!

test('batch 2 routes on SQLite: settings, Cal.com and warm paths behave, and tenant B sees none of A', async () => {
  const { out, rows } = await onSqlite()
  const o = (n: string) => by(out, n)
  assert.equal(o('memory empty').body && (o('memory empty').body as { memory: unknown }).memory, null)
  assert.deepEqual([o('memory save').status, o('memory bad').status], [200, 400])
  assert.deepEqual((o('competitors after').body as { competitors: string[] }).competitors, ['Bee'])
  assert.deepEqual([o('hook matched'), o('hook duplicate'), o('hook unmatched')].map(x => (x.body as { outcome: string }).outcome), ['matched', 'duplicate', 'unmatched'])
  assert.deepEqual([o('hook bad signature').status, o('hook unknown tenant').status], [401, 404])
  assert.deepEqual((o('calcom after').body as { bookings: { booking_uid: string }[] }).bookings.map(b => b.booking_uid).sort(), ['bk-1', 'bk-2'])
  assert.deepEqual((rows as { leads: unknown[] }).leads, [{ id: L.a, stage: 'booked_call' }, { id: L.b, stage: null }].sort((x, y) => x.id.localeCompare(y.id)))
  assert.deepEqual([o('advanced save before consent').status, o('advanced consent').status, o('advanced save').status], [403, 200, 200])
  assert.deepEqual([o('warm import').status, o('warm import again').status], [200, 409])
  const wp = o('warm path').body as { first_degree: { connection_name: string }[]; manual_check: unknown[] }
  assert.deepEqual(wp.first_degree.map(f => f.connection_name), ['Ada L'], 'the duplicated profile keeps its last row')
  assert.equal(wp.manual_check.length, 1)
  assert.equal((o('warm report dup').body as { path: { id: string } }).path.id, (o('warm report').body as { path: { id: string } }).path.id)
  assert.deepEqual((o('warm path after').body as { user_reported: { mutual_name: string }[] }).user_reported.map(p => p.mutual_name), ['Margaret Hamilton', 'Katherine Johnson'], 'same second: insertion order')
  assert.deepEqual((o('warm path newer first').body as { user_reported: { mutual_name: string }[] }).user_reported.map(p => p.mutual_name), ['Katherine Johnson', 'Margaret Hamilton'], 'a newer second comes first')
  for (const n of ['B memory', 'B competitors', 'B calcom', 'B enrichment', 'B connectors', 'B llm key', 'B warm status']) assert.equal(o(n).status, 200, n)
  assert.equal((o('B memory').body as { memory: unknown }).memory, null)
  assert.deepEqual((o('B competitors').body as { competitors: unknown[] }).competitors, [])
  assert.deepEqual((o('B calcom').body as { bookings: unknown[] }).bookings, [])
  assert.deepEqual((o('B enrichment').body as { connectors: unknown[]; audit: unknown[] }), { connectors: [], audit: [] })
  assert.equal((o('B warm status').body as { count: number }).count, 0)
  assert.deepEqual((o('B warm path of A').body as { first_degree: unknown[]; user_reported: unknown[] }).first_degree, [])
  assert.deepEqual((o('B warm path of A').body as { user_reported: unknown[] }).user_reported, [])
  assert.equal(o('B report on A').status, 422, 'not their lead: refused as an invalid path, nothing written')
  assert.equal((o('B remove A path').body as { deleted: boolean }).deleted, false)
  assert.deepEqual([(o('warm remove path').body as { deleted: boolean }).deleted, (o('warm delete').body as { deleted: number }).deleted], [true, 2])
})

test('batch 2 routes: identical responses and writes on SQLite and Postgres; Postgres never touches the SQLite handle', { skip: PG_URL ? false : 'DAZL_TEST_PG_URL not set' }, async () => {
  const sqlite = await onSqlite()
  const pg = await onPg()
  for (const [i, o] of sqlite.out.entries()) assert.deepEqual(pg.out[i], o, `${o.name}: Postgres answered differently`)
  assert.deepEqual(pg.rows, sqlite.rows, 'rows after the writes differ')
  console.log('BATCH2 ROUTES IDENTICAL')
})
