// Route-runtime proof for #352 (real GET /api/leads handler, stubbed session, no network): Home's "Qualified lead" step
// counts exactly the leads its "Review leads" button opens. A workspace with several searches, each holding held or
// to-review leads, is read the way Home reads it (listCampaigns -> readyItems); the number in the detail must equal the
// leads the destination's leads page shows as waiting on you: held cards plus the Needs your review rows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { listCampaigns } from '../../lib/outreach/campaigns.ts'
import { readyItems } from '../../lib/ready-card.ts'
import type { ReadinessInput } from '../../lib/readiness.ts'
import { GET as leadsGET } from '../../app/api/leads/route.ts'

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch

const hex = (n: number) => n.toString(16).padStart(24, '0')
let leadN = 0
function job(db: Database.Database, user: string, id: string, created_at: number) {
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, created_at) VALUES (?, ?, 'x', '(from request)', '-', ?, 'running', ?)").run(id, user, `play ${id}`, created_at)
}
// kind: held = source-checked, timing not proven (currentnessHeld holds it); review = in Needs your review for the given
// reason; unverified = neither; rejected = quarantined.
function lead(db: Database.Database, jobId: string, kind: 'held' | 'review' | 'unverified' | 'rejected', reason = 'quote_unconfirmed') {
  const id = `lead${++leadN}`
  const machine = kind === 'held' || kind === 'rejected'
  db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, review_reason, quarantined_at) VALUES (?, ?, ?, 'opened an office', 'https://news.example/x', ?, ?, ?, ?)")
    .run(id, jobId, `Co ${id}`, machine ? 80 : null, machine ? 'Co opened an office' : null, kind === 'review' ? reason : null, kind === 'rejected' ? 7 : null)
  return id
}
const finish = (db: Database.Database, id: string) => db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(id)

function setup() {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  setScanDb(db)
  setUser({ id: 'A', business_name: 'Acme' })
  return db
}
const input = (db: Database.Database): ReadinessInput => {
  const campaigns = listCampaigns(db, 'A')
  return {
    profile: { website: 'https://acme.example', buyer: { summary: 'Dental practices', who: ['Owner'] } },
    usage: { has_key: true }, keys: [{ vendor: 'anthropic', last4: 'Ab12', validated_at: 1 }], rejection: null,
    outreach: null, sources: { web_index: false, news: true, websites: true }, advanced: null,
    jobs: [], totals: { searches: campaigns.length, finished: campaigns.length }, campaigns, messages: [],
  }
}
// What the destination page shows as waiting on you, from the real handler's response: rows in Needs your review
// (leads-client.tsx lists every lead with a review_reason there) and held cards (currentness_held on a live card).
async function destination(href: string) {
  const id = new URL(href, 'http://localhost').searchParams.get('job_id')!
  const res = await leadsGET(new NextRequest(`http://localhost/api/leads?job_id=${id}`))
  assert.equal(res.status, 200)
  const body = await res.json() as { job_id: string; leads: { id: string; review_reason: string | null; currentness_held?: boolean; quarantined_at: number | null }[] }
  assert.equal(body.job_id, id)
  const review = body.leads.filter(l => l.review_reason)
  const held = body.leads.filter(l => !l.review_reason && !l.quarantined_at && l.currentness_held)
  return { id, ids: [...review, ...held].map(l => l.id).sort(), reasons: new Set(review.map(l => l.review_reason)) }
}
const numberIn = (detail: string) => Number(/^(\d+) /.exec(detail)?.[1] ?? NaN)

test('#352 live shape: 6 held across two searches, the linked search holds 1 + 7 in review; Home counts the 8 it opens', async () => {
  const db = setup()
  const older = hex(1), linked = hex(2), newest = hex(3), other = hex(4)
  job(db, 'A', older, 100); for (let k = 0; k < 5; k++) lead(db, older, 'held')
  job(db, 'A', linked, 200)
  const want = [lead(db, linked, 'held'), ...Array.from({ length: 7 }, () => lead(db, linked, 'review', 'quote_unconfirmed'))]
  lead(db, linked, 'rejected'); lead(db, linked, 'rejected')
  job(db, 'A', newest, 300); lead(db, newest, 'unverified'); lead(db, newest, 'rejected')
  // Another workspace's search with leads to review is never counted or linked.
  job(db, 'B', other, 400); for (let k = 0; k < 4; k++) lead(db, other, 'review', 'event_timing_unconfirmed')
  for (const id of [older, linked, newest, other]) finish(db, id)

  const i = input(db)
  assert.equal(i.campaigns!.reduce((n, c) => n + (c.qualification.held ?? 0), 0), 6, 'the workspace-wide held total the old wording used')
  const q = readyItems(i)[3]
  assert.equal(q.state, 'todo')
  assert.equal(q.fix?.href, `/app/leads?job_id=${linked}`)
  const d = await destination(q.fix!.href)
  assert.deepEqual(d.ids, [...want].sort(), 'the destination shows exactly the seeded held + review leads of that search')
  assert.equal(numberIn(q.detail), d.ids.length, q.detail)
  assert.equal(q.detail, '8 leads in your latest search with leads to check need your review')
  // The counted leads are held or in review for a quote that could not be confirmed: no event-date claim.
  assert.deepEqual([...d.reasons], ['quote_unconfirmed'])
  assert.doesNotMatch(q.detail, /event|date|timing|quote|wait/i)
})

test('#352 several searches each with held / to-review leads, tied created_at: detail and destination are the same search', async () => {
  const db = setup()
  const a = hex(11), b = hex(12), c = hex(13)
  // a and b have the same created_at, so the read's order between them is not fixed: whichever comes first is both the
  // link and the count.
  job(db, 'A', a, 500); lead(db, a, 'held'); lead(db, a, 'held'); lead(db, a, 'review', 'event_date_stale')
  job(db, 'A', b, 500); lead(db, b, 'review', 'blocked_by_site'); lead(db, b, 'unverified')
  job(db, 'A', c, 100); for (let k = 0; k < 9; k++) lead(db, c, 'review', 'location_unconfirmed')
  for (const id of [a, b, c]) finish(db, id)
  const q = readyItems(input(db))[3]
  assert.ok([a, b].includes(new URL(q.fix!.href, 'http://localhost').searchParams.get('job_id')!), q.fix!.href)
  const d = await destination(q.fix!.href)
  assert.equal(numberIn(q.detail), d.ids.length, `${q.detail} vs ${d.ids.length} on ${d.id}`)
  assert.doesNotMatch(q.detail, /event|date|timing|quote|wait/i)
})

test('#352 only Needs-your-review leads (none held) in an older search: counted and opened, not "no lead passed"', async () => {
  const db = setup()
  const empty = hex(21), rev = hex(22)
  job(db, 'A', rev, 100); lead(db, rev, 'review', 'quote_unconfirmed'); lead(db, rev, 'review', 'blocked_by_site'); lead(db, rev, 'review', 'needs_javascript')
  job(db, 'A', empty, 200); lead(db, empty, 'unverified')
  for (const id of [empty, rev]) finish(db, id)
  const q = readyItems(input(db))[3]
  assert.equal(q.fix?.href, `/app/leads?job_id=${rev}`)
  const d = await destination(q.fix!.href)
  assert.equal(d.ids.length, 3)
  assert.equal(q.detail, '3 leads in your latest search with leads to check need your review')
})

test('#352 no search has anything to review: no count, the button opens the newest finished search', async () => {
  const db = setup()
  const old = hex(31), nw = hex(32)
  job(db, 'A', old, 100); lead(db, old, 'unverified'); lead(db, old, 'rejected')
  job(db, 'A', nw, 200); lead(db, nw, 'unverified')
  for (const id of [old, nw]) finish(db, id)
  const q = readyItems(input(db))[3]
  assert.equal(q.detail, 'no lead has passed the source check yet')
  assert.equal(q.fix?.href, `/app/leads?job_id=${nw}`)
  assert.deepEqual((await destination(q.fix!.href)).ids, [])
})
