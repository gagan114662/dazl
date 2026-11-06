// #414 acceptance through the real tick route (app/api/internal/tick/route.ts), run by test/cold-sequence-tick.test.ts
// through the tenant-route loader. PRODUCTION mode against a stubbed Google (global fetch replaced below; nothing
// leaves the process, the net fence stays behind it), with Date.now as the clock. Synthetic tenants and recipients.
// No sequence is created or approved per lead anywhere below: only the tenant-level policy acceptance.
//   C  autopilot on, auto-sequence policy accepted, a business name on the account: the tick sends the first touch,
//      enrolls it, and later ticks send the no-reply steps on day 3 and day 7 - once each - then the set is done.
//   R  same; the lead replies before day 3: the tick reads the reply and no further step goes to that recipient.
//   M  manual mode (policy not accepted): the first touch goes, no sequence is enrolled, nothing follows.
//   L  same as C, but its first touch is a held draft on the message row (the drainFirstTouch path, e.g. a
//      reply_sync_stale hold): sent by the tick's drain, it enrolls too and gets its day-3 step.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb } from './tenant-route-db.ts'
import { seedOffers } from './seed-offer.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { startOAuth } from '../../lib/gmail/oauth.ts'
import { acceptReadConsent } from '../../lib/outreach/replies.ts'
import { ATTESTATIONS, CONSENT_VERSION, enable, offerHashFor } from '../../lib/outreach/autopilot.ts'
import { acceptAutoSequencePolicy, AUTO_SEQUENCE_POLICY } from '../../lib/outreach/sequences.ts'
import { saveSettings } from '../../lib/outreach/service.ts'
import { createJob } from '../../lib/scan/store.ts'
import { POST as tick } from '../../app/api/internal/tick/route.ts'

delete process.env.DAZL_ENV // production mode: sends and reads go to the stubbed Google below
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
process.env.GOOGLE_CLIENT_ID = 'cid.apps.googleusercontent.com'; process.env.GOOGLE_CLIENT_SECRET = 'synthetic'
process.env.AUTOPILOT_TICK_SECRET = 'test-tick-secret'
process.env.AUTOPILOT_ENABLED = '1'; process.env.AUTOPILOT_WARMUP = '2'; process.env.SEQUENCES_ENABLED = '1'
delete process.env.AUTOPILOT_KILL

const T0 = 1_800_000_000, DAY = 86400
let clock = T0
Date.now = () => clock * 1000

// ---------- stubbed Google: token refresh, sends, thread reads, the bounded daemon-notice search ----------
const b64 = (s: string) => Buffer.from(s).toString('base64url')
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const sends: { to: string; threadId?: string }[] = []
const threads: Record<string, unknown[]> = {}
const fenced = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const u = String(input instanceof Request ? input.url : input)
  if (u.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'synthetic-at' })
  if (u === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
    const body = JSON.parse(String(init?.body)) as { raw: string; threadId?: string }
    const to = /^To: *(?:.*<)?([^>\r\n]+)>?\r?$/mi.exec(Buffer.from(body.raw, 'base64url').toString('utf8'))?.[1]?.trim() ?? '?'
    const id = randomBytes(8).toString('hex')
    sends.push({ to, threadId: body.threadId })
    return json({ id, threadId: body.threadId ?? `th${id}` })
  }
  if (u.startsWith('https://gmail.googleapis.com/')) {
    const m = u.match(/threads\/([^?]+)/)
    if (m) return json({ messages: threads[m[1]] ?? [] })
    if (u.includes('messages?q=')) return json({ messages: [] })
    throw new Error(`unexpected Gmail call in #414 harness: ${u}`)
  }
  return fenced(input as never, init) // loopback only (the net fence throws on everything else)
}) as typeof fetch

const db = new Database(':memory:')
migrateAllSqlite(db)
setScanDb(db)
const C = 'tenant-c-cold', R = 'tenant-r-replied', M = 'tenant-m-manual', L = 'tenant-l-legacy-hold'
seedOffers(db, [C, R, M, L])
for (const t of [C, R, M, L]) {
  db.prepare("INSERT INTO users (id, email, password_hash, salt, business_name) VALUES (?, ?, 'x', 'y', 'Northwind Roofing Supply')").run(t, `${t}@example.test`)
  saveSettings(db, t, { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  // connected mailbox with the read scope (the stub connect writes the same row a real OAuth grant with read does)
  startOAuth(db, t, { env: { DAZL_ENV: 'staging', PUBLIC_BASE_URL: 'https://staging.example.test' } as never })
  acceptReadConsent(db, t)
  enable(db, t, { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 10 })
  for (const n of [1, 2]) db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES (?, ?, ?, ?, 's', 'bodybodybodybodybodybody', 'sent', ?, ?)")
    .run(randomBytes(12).toString('hex'), t, `warm-${n}`, `o${n}@warm.example`, T0 - 9e5, T0 - 9e5) // warm-up done, outside every window
}
for (const t of [C, R, L]) acceptAutoSequencePolicy(db, t, AUTO_SEQUENCE_POLICY, T0 - DAY)
function lead(t: string, contact: string) {
  const job = createJob(db, t, { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const id = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, score, human_confirmed_at, human_confirmed_from) VALUES (?, ?, ?, ?, 'Hiring roofers', 'https://n.example/a', 'Co is hiring', 90, 80, ?, 'test_review')")
    .run(id, job, 'Co ' + id.slice(0, 4), contact, T0 - DAY)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  return id
}
const to = { C: 'ana@cold.example', R: 'raj@reply.example', M: 'mo@manual.example', L: 'lu@legacy.example' }
lead(C, to.C); lead(R, to.R); lead(M, to.M)
// L: its first touch already drafted and held on the message row, due now (what drainFirstTouch sends).
const lLead = lead(L, to.L)
db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, hold_reason, hold_until, hold_policy, offer_hash) VALUES (?, ?, ?, ?, 'Quick question', 'A first touch body long enough for the checks.', 'draft', 'daily_cap', ?, ?, ?)")
  .run(randomBytes(12).toString('hex'), L, lLead, to.L, T0 - 60, CONSENT_VERSION, offerHashFor(db, L, lLead))

const call = async () => (await tick(new NextRequest('http://localhost/api/internal/tick', { method: 'POST', headers: { authorization: 'Bearer test-tick-secret' } }))).json()
const to_ = (addr: string) => sends.filter(s => s.to === addr).length
const seq = (t: string) => db.prepare('SELECT status, stop_reason, policy FROM sequences WHERE tenant_id = ?').get(t) as { status: string; stop_reason: string | null; policy: string | null } | undefined
const firstTouch = (t: string, addr: string) => db.prepare('SELECT thread_id, sent_at FROM outreach_messages WHERE tenant_id = ? AND to_email = ? AND status = ?').get(t, addr, 'sent') as { thread_id: string; sent_at: number } | undefined

test('#414 the scheduled tick: first touch, auto-enrolled day-3/day-7 no-reply steps, reply stop, manual mode, drained first touch', async () => {
  // Day 0: one tick sends every first touch (L's by the drain); policy tenants enroll, the manual tenant does not.
  const r0 = await call()
  assert.equal(r0.ok, true)
  for (const [t, a] of [[C, to.C], [R, to.R], [M, to.M], [L, to.L]] as const) assert.equal(to_(a), 1, `${t}: first touch sent once`)
  for (const t of [C, R, L]) assert.deepEqual({ ...seq(t) }, { status: 'active', stop_reason: null, policy: AUTO_SEQUENCE_POLICY }, `${t}: enrolled under the policy, no per-lead approval`)
  assert.equal(seq(M), undefined, 'M: manual mode - nothing enrolled')

  // Day 1: R's lead replies in the first-touch thread.
  clock = T0 + DAY
  const rt = firstTouch(R, to.R)!
  threads[rt.thread_id] = [{ id: 'r-reply', threadId: rt.thread_id, internalDate: String(clock * 1000), payload: { mimeType: 'text/plain', body: { data: b64('Thanks, what does this cost for a crew of 12?') }, headers: [{ name: 'From', value: `Raj <${to.R}>` }] } }]
  await call()
  assert.notEqual(seq(R)?.status, 'active', 'R: the reply moved the set out of active')
  for (const a of [to.C, to.R, to.M, to.L]) assert.equal(to_(a), 1, 'nothing due on day 1')

  // Day 3: the no-reply step 2 goes for C and L, once, in the first-touch thread; nothing to R or M.
  clock = T0 + 3 * DAY + 60
  await call(); await call()
  assert.equal(to_(to.C), 2, 'C: day-3 step sent once (repeat tick does not duplicate)')
  assert.equal(sends.filter(s => s.to === to.C)[1].threadId, firstTouch(C, to.C)!.thread_id, 'C: step 2 is in the first-touch thread')
  assert.equal(to_(to.L), 2, 'L: the drained first touch enrolled and got its day-3 step')
  assert.equal(to_(to.R), 1, 'R: replied - no step 2'); assert.equal(to_(to.M), 1, 'M: manual - no follow-up')
  assert.equal(seq(C)?.status, 'active')

  // Day 7: step 3, once; the set completes.
  clock = T0 + 7 * DAY + 60
  await call(); await call()
  assert.equal(to_(to.C), 3, 'C: day-7 step sent once')
  assert.equal(seq(C)?.status, 'done')
  assert.equal(to_(to.R), 1); assert.equal(to_(to.M), 1)
  clock = T0 + 14 * DAY
  await call()
  assert.equal(to_(to.C), 3, 'C: nothing after the bounded set')
})
