// The real POST /api/scan and GET/POST /api/campaigns/[id] for the per-play offer (#349; test/play-offer-route.test.ts).
// Synthetic tenants and offers. A request that states a different offer than the saved profile is refused (409)
// before anything is queued, and runs once the offer for this play is supplied; the play keeps that offer, the
// campaign page reads it back, and only the play's owner can change it (another tenant's attempt is a 404 and changes
// nothing). In-memory SQLite, every migration; the runner never starts; no network.
// Two-tenant coverage cited by tenant-isolation-manifest.ts: 'POST /api/campaigns/[id]' (and 'GET /api/campaigns/[id]').
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { setSellerLine } from './scan-route-auth-stub.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { saveKey } from '../../lib/llm/key-store.ts'
import { POST as SCAN } from '../../app/api/scan/route.ts'
import { GET as CAMPAIGN, POST as SET_OFFER } from '../../app/api/campaigns/[id]/route.ts'

process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
globalThis.fetch = (async (u: unknown) => { throw new Error(`network fenced: ${String(u)}`) }) as typeof fetch
const DENTAL = 'Appointment booking and reminder software for dental practices'
const CRM = 'CRM setup and outbound consulting'
const DENTAL_Q = 'Independent dental practices in New York hiring a front-desk coordinator in the past 60 days'
const LONDON_Q = `Selling ${CRM} to London B2B SaaS startups that opened a new office in the past 90 days`
const A = 'a'.repeat(32), B = 'b'.repeat(32)
const db = new Database(':memory:'); migrateAllSqlite(db); setScanDb(db)
for (const t of [A, B]) {
  db.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt, sells) VALUES (?, ?, 'n', 'Acme', 'x', 'y', ?)").run(t, `${t.slice(0, 4)}@example.test`, t === A ? DENTAL : 'Bookkeeping for agencies')
  saveKey(db, t, 'anthropic', 'sk-ant-api03-FIXTUREFIXTUREFIXTUREFIXTURE', Buffer.from(process.env.DAZL_MASTER_KEY!, 'base64'))
}
setSellerLine(A, `${DENTAL} - https://seller.example`); setSellerLine(B, 'Bookkeeping for agencies')
let ip = 0
const as = (t: string) => setUser({ id: t, business_name: 'Acme', email: `${t.slice(0, 4)}@example.test` } as never)
const scan = async (t: string, body: unknown) => { as(t); const r = await SCAN(new NextRequest('http://localhost/api/scan', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', 'x-forwarded-for': `10.1.0.${++ip}` }, body: JSON.stringify(body) })); return { status: r.status, ...(await r.json()) as Record<string, unknown> } as Record<string, unknown> & { status: number } }
const finish = (id: string) => { db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(id); db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(id) }
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const campaign = async (t: string, id: string) => { as(t); const r = await CAMPAIGN(new Request(`http://localhost/api/campaigns/${id}`), ctx(id)); return { status: r.status, ...(await r.json()) as { offer?: unknown } } }
const setOffer = async (t: string, id: string, offer: unknown) => { as(t); const r = await SET_OFFER(new NextRequest(`http://localhost/api/campaigns/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' }, body: JSON.stringify({ offer }) }), ctx(id)); return { status: r.status, ...(await r.json()) as Record<string, unknown> } as Record<string, unknown> & { status: number } }
const row = (id: string) => db.prepare('SELECT offer, offer_set_at IS NOT NULL AS set_at, seller FROM scan_jobs WHERE id = ?').get(id) as { offer: string | null; set_at: number; seller: string | null }

test('a request stating another offer than the saved profile is refused until this play\'s offer is chosen; then it is stored with the play', async () => {
  const jobs0 = (db.prepare('SELECT count(*) AS n FROM scan_jobs').get() as { n: number }).n
  assert.deepEqual(await scan(A, { query: LONDON_Q }), { status: 409, error: 'offer_conflict', stated: CRM, saved: DENTAL })
  assert.equal((db.prepare('SELECT count(*) AS n FROM scan_jobs').get() as { n: number }).n, jobs0, 'nothing queued')
  assert.equal((await scan(A, { query: LONDON_Q, offer: 'x' })).status, 400)
  const london = await scan(A, { query: LONDON_Q, offer: CRM })
  assert.equal(london.status, 202, JSON.stringify(london))
  assert.deepEqual(row(london.job_id as string), { offer: CRM, set_at: 1, seller: `${DENTAL} - https://seller.example` })
  finish(london.job_id as string)
  // the dental play: no stated offer, nothing to choose, it records the profile's offer
  const dental = await scan(A, { query: DENTAL_Q })
  assert.equal(dental.status, 202)
  assert.deepEqual(row(dental.job_id as string), { offer: null, set_at: 0, seller: `${DENTAL} - https://seller.example` })
  finish(dental.job_id as string)
  // the campaign page reads each play's own offer back
  assert.deepEqual((await campaign(A, london.job_id as string)).offer, { offer: CRM, source: 'play', conflict: null })
  assert.deepEqual((await campaign(A, dental.job_id as string)).offer, { offer: DENTAL, source: 'recorded', conflict: null })
  console.log('JOBS', JSON.stringify({ london: london.job_id, dental: dental.job_id }))
})

test('a contested play is resolved on its campaign page, by its owner only; the other play is untouched', async () => {
  // a London play created before plays had a reviewed offer: dental snapshot, CRM stated
  const legacy = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, seller) VALUES (?, ?, 'x', '(from request)', '-', ?, ?)").run(legacy, A, LONDON_Q, `${DENTAL} - https://seller.example`)
  const dental = (db.prepare("SELECT id FROM scan_jobs WHERE user_id = ? AND query = ?").get(A, DENTAL_Q) as { id: string }).id
  assert.deepEqual((await campaign(A, legacy)).offer, { offer: null, source: 'conflict', conflict: { stated: CRM, recorded: DENTAL } })
  const before = JSON.stringify(row(dental))
  // tenant B: the same 404 as a missing play, and nothing changes
  assert.equal((await campaign(B, legacy)).status, 404)
  assert.equal((await setOffer(B, legacy, 'Bookkeeping for agencies')).status, 404)
  assert.deepEqual((await campaign(A, legacy)).offer, { offer: null, source: 'conflict', conflict: { stated: CRM, recorded: DENTAL } })
  assert.equal((await setOffer(A, legacy, '')).status, 400)
  // the owner chooses
  assert.deepEqual(await setOffer(A, legacy, CRM), { status: 200, offer: { offer: CRM, source: 'play', conflict: null } })
  assert.deepEqual((await campaign(A, legacy)).offer, { offer: CRM, source: 'play', conflict: null })
  assert.equal(JSON.stringify(row(dental)), before, 'the dental play keeps its context')
})
