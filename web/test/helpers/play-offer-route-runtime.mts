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
import { saveMemory } from '../../lib/memory.ts'
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

// #349 acceptance: Instinct's exact synthetic case, a bare "We sell X." sentence, through the real handlers.
test('a bare "We sell X." sentence is a stated offer: a new scan asks first, and an existing play is contested on its campaign page', async () => {
  const Q = 'Find London SaaS startups hiring. We sell CRM setup and outbound sales consulting. Exclude agencies.'
  const SELLER = 'We sell appointment booking and reminder software to independent dental practices in New York City.'
  const jobs0 = (db.prepare('SELECT count(*) AS n FROM scan_jobs').get() as { n: number }).n
  assert.deepEqual(await scan(A, { query: Q }), { status: 409, error: 'offer_conflict', stated: 'CRM setup and outbound sales consulting', saved: DENTAL })
  assert.equal((db.prepare('SELECT count(*) AS n FROM scan_jobs').get() as { n: number }).n, jobs0, 'nothing queued')
  const existing = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, seller) VALUES (?, ?, 'x', '(from request)', '-', ?, ?)").run(existing, A, Q, `${SELLER} - https://seller.example`)
  assert.deepEqual((await campaign(A, existing)).offer, { offer: null, source: 'conflict', conflict: { stated: 'CRM setup and outbound sales consulting', recorded: SELLER } })
  assert.equal(row(existing).seller, `${SELLER} - https://seller.example`, 'the historical offer is never rewritten')
})

// #349 the commercial-term class through the real handlers (Instinct's exact readbacks at ebee1ae): a withdrawal whose
// term is qualified by the saved product, or whose term is the saved product in another number, is refused at creation
// with nothing invented (stated null), queues nothing, and runs once this play's offer is written.
test('a qualified or same-word commercial-term withdrawal is refused at creation (stated null) and runs once the offer is written', async () => {
  const cases: [tenant: string, saved: string, q: string, withdrawn: string][] = [
    ['c'.repeat(32), 'We sell payroll software.', 'Find London SaaS startups. We no longer sell support for payroll software.', 'support for payroll software'],
    ['e'.repeat(32), 'We sell warranty management software.', 'Find London retailers. We no longer sell warranties.', 'warranties'],
  ]
  for (const [t, saved, q, withdrawn] of cases) {
    db.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt, sells) VALUES (?, ?, 'n', 'Acme', 'x', 'y', ?)").run(t, `${t.slice(0, 4)}@example.test`, saved)
    saveKey(db, t, 'anthropic', 'sk-ant-api03-FIXTUREFIXTUREFIXTUREFIXTURE', Buffer.from(process.env.DAZL_MASTER_KEY!, 'base64'))
    setSellerLine(t, `${saved} - https://seller.example`)
    const jobs0 = (db.prepare('SELECT count(*) AS n FROM scan_jobs').get() as { n: number }).n
    assert.deepEqual(await scan(t, { query: q }), { status: 409, error: 'offer_conflict', stated: null, saved, withdrawn })
    assert.equal((db.prepare('SELECT count(*) AS n FROM scan_jobs').get() as { n: number }).n, jobs0, 'nothing queued')
    const ok = await scan(t, { query: q, offer: 'Bookkeeping for agencies' })
    assert.equal(ok.status, 202, JSON.stringify(ok))
    assert.equal(row(ok.job_id as string).offer, 'Bookkeeping for agencies')
    assert.equal((db.prepare('SELECT sells FROM users WHERE id = ?').get(t) as { sells: string }).sells, saved, 'the profile is unchanged')
  }
  // a named replacement is offered as the stated choice
  assert.deepEqual(await scan(A, { query: `We no longer sell ${DENTAL}, we now sell ${CRM}.` }), { status: 409, error: 'offer_conflict', stated: CRM, saved: DENTAL, withdrawn: DENTAL })
})

// #349 a Memory-only tenant (positioning saved, no profile offer): admission reads the same offer drafting reads, so a
// conflict surfaces at creation, not first at draft time; the same product still runs with nothing to choose.
test('a Memory-only tenant gets the offer conflict at play creation; its same-product play runs', async () => {
  const M = 'd'.repeat(32), POS = 'Payroll software for restaurants'
  db.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt, sells) VALUES (?, ?, 'n', 'Acme', 'x', 'y', NULL)").run(M, 'dddd@example.test')
  saveKey(db, M, 'anthropic', 'sk-ant-api03-FIXTUREFIXTUREFIXTUREFIXTURE', Buffer.from(process.env.DAZL_MASTER_KEY!, 'base64'))
  saveMemory(db, M, { positioning: POS })
  setSellerLine(M, '')
  const jobs0 = (db.prepare('SELECT count(*) AS n FROM scan_jobs').get() as { n: number }).n
  assert.deepEqual(await scan(M, { query: 'Find restaurants in London. We no longer sell payroll software.' }), { status: 409, error: 'offer_conflict', stated: null, saved: POS, withdrawn: 'payroll software' })
  assert.deepEqual(await scan(M, { query: `Find London SaaS startups. We sell ${CRM}.` }), { status: 409, error: 'offer_conflict', stated: CRM, saved: POS })
  assert.equal((db.prepare('SELECT count(*) AS n FROM scan_jobs').get() as { n: number }).n, jobs0, 'nothing queued')
  const same = await scan(M, { query: 'Find restaurants in London hiring a manager.' })
  assert.equal(same.status, 202, JSON.stringify(same))
})
