// #349 / #204 business understanding through the real scan entry route (test/request-offer-349.test.ts). The fixed
// acceptance briefs: Test A (NYC dental appointment software) and Test B (London CRM setup and outbound consulting), on
// the live record shape: the saved profile is the dental sentence, no website, no Memory row. POST /api/scan admits the
// play; what the scan then grades with is read with the runner's own functions (offerBlockFor: the buyer-fit offer
// block; playOfferUnresolved: the hold) and what Home / campaign / drafting read (readPlayOffer). Then the next run of
// the same play: again through POST /api/scan, and as a weekly watch and a monitor run. Synthetic tenants only;
// in-memory SQLite, every migration; no network, no model or paid call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { setSellerLine } from './scan-route-auth-stub.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { getDb, sqliteDb } from '../../lib/db/client.ts'
import { saveKey } from '../../lib/llm/key-store.ts'
import { normalizeIcp } from '../../lib/scan/icp.ts'
import { offerBlockFor, playOfferUnresolved } from '../../lib/scan/runner.ts'
import { confirmedPlayOffer, readPlayOffer } from '../../lib/scan/play-offer.ts'
import { createWatch, runDueWatches } from '../../lib/watch.ts'
import { runDueMonitors } from '../../lib/monitors.ts'
import { POST as SCAN } from '../../app/api/scan/route.ts'

process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
const master = Buffer.from(process.env.DAZL_MASTER_KEY, 'base64')
globalThis.fetch = (async (u: unknown) => { throw new Error(`network fenced: ${String(u)}`) }) as typeof fetch

// The live records (#349, Instinct 2026-10-30): profile sells = this sentence, website empty, no Memory positioning.
const SAVED = 'We sell appointment booking and reminder software to independent dental practices in New York City.'
const CRM = 'CRM setup and outbound sales consulting'
// Test A and Test B, verbatim as the original requests
const TEST_A = 'Find independent dental practices in New York City with 1–5 locations that opened a new location or are hiring a receptionist in the last 90 days. We sell appointment booking and reminder software. Exclude large chains, vendors, directories, and practices outside NYC. Show the dated evidence and an owner or practice manager contact.'
const TEST_B = 'Find B2B SaaS startups in London, UK that raised seed funding or are hiring their first sales representative in the last 90 days. We sell CRM setup and outbound sales consulting. Exclude agencies, directories and companies outside the UK. Show dated source evidence and founder or head of sales contacts.'
// Test B as the review step sends it when the offer is typed in its offer field, not in the sentence
const TEST_B_TARGETING = 'Find B2B SaaS startups in London, UK that raised seed funding or are hiring their first sales representative in the last 90 days. Exclude agencies, directories and companies outside the UK.'
// The Test B profile the user reviewed (exclusions included)
const REVIEWED_B = { summary: 'London B2B SaaS startups that raised seed funding or are hiring their first sales rep', who: ['Founder', 'Head of Sales'], industries: ['B2B SaaS'], sizes: [], where: ['London, UK'], signals: ['raised seed funding in the last 90 days', 'hiring their first sales representative in the last 90 days'], exclude: ['agencies', 'directories', 'companies outside the UK'], country: 'GB', language: 'en', window_days: 90 }

const db = new Database(':memory:'); migrateAllSqlite(db); setScanDb(db)
const D = sqliteDb(db)
const tenants = { L: 'l'.repeat(32), O: 'o'.repeat(32) }
for (const t of Object.values(tenants)) {
  db.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt, sells, website, buyer_profile) VALUES (?, ?, 'n', 'Dental Seller', 'x', 'y', ?, '', NULL)").run(t, `${t.slice(0, 4)}@example.test`, SAVED)
  saveKey(db, t, 'anthropic', 'sk-ant-fixture', master)
  setSellerLine(t, SAVED) // what lib/auth-db sellerProfile returns for that row: sells, no website
}
let ip = 0
const scan = async (t: string, body: unknown) => {
  setUser({ id: t, business_name: 'Dental Seller', email: `${t.slice(0, 4)}@example.test` } as never)
  await (await getDb()).run('DELETE FROM rate_limits') // many scans of one tenant here; the hourly scan limit is not under test
  const r = await SCAN(new NextRequest('http://localhost/api/scan', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', 'x-forwarded-for': `10.9.0.${++ip}` }, body: JSON.stringify(body) }))
  return { status: r.status, ...(await r.json()) as Record<string, unknown> } as Record<string, unknown> & { status: number }
}
const jobs = () => (db.prepare('SELECT count(*) AS n FROM scan_jobs').get() as { n: number }).n
const row = (id: string) => db.prepare('SELECT offer, seller, icp, icp_inferred FROM scan_jobs WHERE id = ?').get(id) as { offer: string | null; seller: string | null; icp: string | null; icp_inferred: number | null }
const finish = (id: string) => { db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ? AND status = 'pending'").run(id); db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ? AND status = 'running'").run(id) }

// What the scan grades buyer fit against for this play (the runner's own offer block), and whether it holds the play.
const grades = (t: string, id: string) => offerBlockFor(db, t, id)
const held = (t: string, id: string) => playOfferUnresolved(db, t, id)

const ids: Record<string, string> = {}

test('Test B: a London CRM request beside the saved dental profile stops and asks, then the scan uses CRM only, never the dental offer', async () => {
  const L = tenants.L, n0 = jobs()
  assert.deepEqual(await scan(L, { query: TEST_B }), { status: 409, error: 'offer_conflict', stated: CRM, saved: SAVED })
  assert.equal(jobs(), n0, 'nothing queued until the offer is chosen')
  const b = await scan(L, { query: TEST_B, offer: CRM })
  assert.equal(b.status, 202, JSON.stringify(b))
  ids.b1 = b.job_id as string
  assert.equal(row(ids.b1).offer, CRM)
  assert.match(grades(L, ids.b1), new RegExp(`What the seller sells \\(their own words\\): ${CRM}\\n`), 'the scan grades buyers for CRM setup and outbound consulting')
  assert.doesNotMatch(grades(L, ids.b1), /dental|appointment booking/i, 'the saved dental offer never enters the London scan')
  assert.equal(held(L, ids.b1), false)
  assert.deepEqual(await readPlayOffer(D, L, ids.b1), { offer: CRM, source: 'play', conflict: null })
  finish(ids.b1)
})

test('Test A: the NYC dental request runs on the saved dental offer with nothing to choose', async () => {
  const a = await scan(tenants.L, { query: TEST_A })
  assert.equal(a.status, 202, JSON.stringify(a))
  ids.a1 = a.job_id as string
  assert.deepEqual({ offer: row(ids.a1).offer, seller: row(ids.a1).seller }, { offer: null, seller: SAVED })
  assert.match(grades(tenants.L, ids.a1), /What the seller sells \(their own words\): We sell appointment booking and reminder software/, 'the dental scan grades for the dental offer')
  assert.doesNotMatch(grades(tenants.L, ids.a1), /CRM|outbound/i, 'the London offer never enters the dental scan')
  finish(ids.a1)
  assert.deepEqual(await readPlayOffer(D, tenants.L, ids.a1), { offer: SAVED, source: 'recorded', conflict: null })
})

test('the next run of the same play reuses the confirmed offer and the reviewed exclusions, through POST /api/scan', async () => {
  const L = tenants.L
  // Test B through the review step: the reviewed profile and the offer field are confirmed together
  const r1 = await scan(L, { query: TEST_B_TARGETING, icp: REVIEWED_B, offer: CRM })
  assert.equal(r1.status, 202, JSON.stringify(r1)); finish(r1.job_id as string)
  // second run, as Find leads posts the same sentence (its stored reviewed profile, no offer). Before #349's fix this
  // ran on the saved dental offer with no warning: London targeting, dental offer.
  const r2 = await scan(L, { query: TEST_B_TARGETING, icp: REVIEWED_B })
  assert.equal(r2.status, 202, JSON.stringify(r2))
  const j2 = r2.job_id as string
  assert.equal(row(j2).offer, CRM, 'the confirmed offer is this run\'s offer')
  assert.match(grades(L, j2), /CRM setup and outbound sales consulting/)
  assert.doesNotMatch(grades(L, j2), /dental|appointment booking/i, 'never the saved dental offer beside London targeting')
  assert.deepEqual(await readPlayOffer(D, L, j2), { offer: CRM, source: 'play', conflict: null })
  assert.deepEqual(JSON.parse(row(j2).icp!).exclude, JSON.parse(row(r1.job_id as string).icp!).exclude, 'same exclusions')
  assert.deepEqual(JSON.parse(row(j2).icp!).exclude, normalizeIcp(REVIEWED_B)!.exclude)
  finish(j2)
  // the sentence-only second run of the same play: CRM again
  const r3 = await scan(L, { query: TEST_B_TARGETING })
  assert.equal(r3.status, 202); assert.equal(row(r3.job_id as string).offer, CRM); finish(r3.job_id as string)
  // Test B with the offer in the sentence: the second run no longer asks again, it runs on the confirmed CRM offer
  const r4 = await scan(L, { query: TEST_B })
  assert.equal(r4.status, 202, JSON.stringify(r4))
  assert.equal(row(r4.job_id as string).offer, CRM); assert.equal(held(L, r4.job_id as string), false); finish(r4.job_id as string)
  // the dental play is untouched by the London choice, and its own next run stays dental
  const a2 = await scan(L, { query: TEST_A })
  assert.equal(a2.status, 202); finish(a2.job_id as string)
  assert.deepEqual({ offer: row(a2.job_id as string).offer, seller: row(a2.job_id as string).seller }, { offer: null, seller: SAVED })
  assert.deepEqual(await readPlayOffer(D, L, ids.a1), { offer: SAVED, source: 'recorded', conflict: null })
  assert.deepEqual(await readPlayOffer(D, L, a2.job_id as string), { offer: SAVED, source: 'recorded', conflict: null })
})

test('reuse fails closed: another tenant, another request, a changed profile, a junk stored offer, an explicit offer', async () => {
  const L = tenants.L, O = tenants.O
  // another tenant with the same profile and request: its own question, nothing of L's
  assert.deepEqual(await scan(O, { query: TEST_B }), { status: 409, error: 'offer_conflict', stated: CRM, saved: SAVED })
  assert.equal(await confirmedPlayOffer(D, O, TEST_B_TARGETING, SAVED), null, 'L\'s confirmation is never O\'s')
  // one word changed is another request
  assert.equal((await scan(L, { query: TEST_B.replace('London, UK', 'London UK') })).status, 409)
  // an explicit offer always wins over the confirmed one
  const ex = await scan(L, { query: TEST_B, offer: 'Bookkeeping for agencies' })
  assert.equal(ex.status, 202); assert.equal(row(ex.job_id as string).offer, 'Bookkeeping for agencies'); finish(ex.job_id as string)
  // the latest confirmation is the one reused (it was this run's offer)
  assert.deepEqual(await confirmedPlayOffer(D, L, TEST_B, SAVED), { offer: 'Bookkeeping for agencies', seller: SAVED })
  const back = await scan(L, { query: TEST_B, offer: CRM }); finish(back.job_id as string)
  // a stored offer too short to be one is never reused
  const junkTenant = 'j'.repeat(32)
  db.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt, sells, website) VALUES (?, 'jjjj@example.test', 'n', 'J', 'x', 'y', ?, '')").run(junkTenant, SAVED)
  saveKey(db, junkTenant, 'anthropic', 'sk-ant-fixture', master); setSellerLine(junkTenant, SAVED)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, seller, offer, offer_set_at, status) VALUES (?, ?, 'x', '(from request)', '-', ?, ?, ' x ', 1, 'done')").run(randomBytes(12).toString('hex'), junkTenant, TEST_B, SAVED)
  assert.equal((await scan(junkTenant, { query: TEST_B })).status, 409)
  // reading never writes a play
  const before = JSON.stringify(db.prepare('SELECT id, offer, offer_set_at, seller FROM scan_jobs ORDER BY id').all())
  for (const q of [TEST_B, TEST_A, '', 'ab', '   '] as unknown[]) await confirmedPlayOffer(D, L, q as string, SAVED)
  await confirmedPlayOffer(D, L, 42 as unknown as string, SAVED); await confirmedPlayOffer(D, L, null as unknown as string, SAVED)
  assert.equal(JSON.stringify(db.prepare('SELECT id, offer, offer_set_at, seller FROM scan_jobs ORDER BY id').all()), before)
  // the profile changes: the earlier choice was made beside another profile, so the user is asked again
  db.prepare('UPDATE users SET sells = ? WHERE id = ?').run('We sell payroll software to restaurants.', L); setSellerLine(L, 'We sell payroll software to restaurants.')
  const asked = await scan(L, { query: TEST_B })
  assert.equal(asked.status, 409, JSON.stringify(asked)); assert.equal(asked.saved, 'We sell payroll software to restaurants.')
  db.prepare('UPDATE users SET sells = ? WHERE id = ?').run(SAVED, L); setSellerLine(L, SAVED)
})

test('a scheduled run of the same play (weekly watch, monitor) keeps the confirmed offer; an unconfirmed one stays contested', async () => {
  const L = tenants.L, O = tenants.O
  for (const t of [L, O]) db.prepare("UPDATE scan_jobs SET status = 'done' WHERE user_id = ? AND status IN ('pending', 'running')").run(t)
  const w = await createWatch(D, L, TEST_B, JSON.stringify(normalizeIcp(REVIEWED_B)), null, 100)
  const wt = await createWatch(D, L, TEST_B_TARGETING, JSON.stringify(normalizeIcp(REVIEWED_B)), null, 101)
  const wo = await createWatch(D, O, TEST_B, JSON.stringify(normalizeIcp(REVIEWED_B)), null, 100)
  assert.ok(w.watch && wt.watch && wo.watch, JSON.stringify({ w, wt, wo }))
  const due = 101 + 7 * 86400 + 1
  // one scan at a time per tenant: L's first due watch, then O's; L's second on the next tick
  assert.equal((await runDueWatches(D, { now: due })).ran, 2)
  const wl = db.prepare('SELECT id FROM scan_jobs WHERE watch_id = ?').get(w.watch!.id) as { id: string }
  const wol = db.prepare('SELECT id FROM scan_jobs WHERE watch_id = ?').get(wo.watch!.id) as { id: string }
  assert.deepEqual({ offer: row(wl.id).offer, seller: row(wl.id).seller }, { offer: CRM, seller: SAVED }, 'the watch run keeps the CRM offer')
  assert.deepEqual(await readPlayOffer(D, L, wl.id), { offer: CRM, source: 'play', conflict: null })
  // tenant O never chose: its run is contested (held, never scored on dental), not silently dental
  assert.equal(row(wol.id).offer, null)
  assert.deepEqual(await readPlayOffer(D, O, wol.id), { offer: null, source: 'conflict', conflict: { stated: CRM, recorded: SAVED } })
  for (const id of [wl.id, wol.id]) finish(id)
  assert.equal((await runDueWatches(D, { now: due })).ran, 1)
  const wtl = db.prepare('SELECT id FROM scan_jobs WHERE watch_id = ?').get(wt.watch!.id) as { id: string }
  assert.equal(row(wtl.id).offer, CRM, 'the targeting-only weekly run keeps CRM, never the saved dental offer')
  assert.doesNotMatch(grades(L, wtl.id), /dental|appointment booking/i)
  finish(wtl.id)
  const mon = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO monitors (id, user_id, query, icp, sources, interval_hours, next_run_at, created_at) VALUES (?, ?, ?, ?, NULL, 24, ?, ?)').run(mon, L, TEST_B, JSON.stringify(normalizeIcp(REVIEWED_B)), due, due)
  const ran = await runDueMonitors(D, { now: due })
  assert.equal(ran.length, 1)
  assert.deepEqual({ offer: row(ran[0]).offer, seller: row(ran[0]).seller }, { offer: CRM, seller: SAVED }, 'the monitor run keeps the CRM offer')
})
