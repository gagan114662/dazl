// The account cooldown on the Db layer (lib/accounts/cooldown.ts accountHold, #364), on both engines, and with the
// account links on Postgres while the emails are still in SQLite (the store split while outreach is ported, #354).
// Synthetic tenants, plays, companies and addresses; nothing is sent.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { bothEngines } from './helpers/engines.ts'
import { syncAccountGraph } from '../lib/accounts/graph.ts'
import { accountHold, graphStore } from '../lib/accounts/cooldown.ts'
import { sqliteDb, type Db } from '../lib/db/client.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'

const NOW = 1_800_000_000
const DAY = 86400
let seq = 0
async function play(db: Db, tenant: string) {
  const id = `job-${tenant}-${++seq}`
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, 'Biz', 'test', 'test', 'running')", [id, tenant])
  return id
}
async function lead(db: Db, job: string, company: string, contact: string, domain: string | null) {
  const id = `lead-${++seq}`
  await db.run('INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, company_domain, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, job, 'Pat', company, contact, `signal for ${company}`, `https://news.example/${id}`, domain, NOW + seq])
  return id
}
const email = (db: Db, tenant: string, leadId: string, to: string, status: string, at: number) =>
  db.run('INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [`msg-${++seq}`, tenant, leadId, to, 'Quick question', 'A synthetic body that is long enough.', status, status === 'sent' ? at : null, at, at])

bothEngines('someone at the same account emailed from another play holds a first touch; the window, the play and the link decide', async ({ db }) => {
  const p1 = await play(db, 'T'), p2 = await play(db, 'T')
  const jane = await lead(db, p1, 'Acme Roofing', 'jane@acme-roofing.example', 'acme-roofing.example')
  const bob = await lead(db, p2, 'Acme Roofing Ltd', 'bob@acme-roofing.example', 'acme-roofing.example')
  const sameplay = await lead(db, p1, 'Acme Roofing', 'kim@acme-roofing.example', 'acme-roofing.example')
  const other = await lead(db, p2, 'Acme Roofing', 'lee@acme-roofing-west.example', 'acme-roofing-west.example')
  await email(db, 'T', jane, 'jane@acme-roofing.example', 'sent', NOW)
  // Not linked yet: the account rule cannot see the lead, and does not guess.
  assert.equal(await accountHold(db, db, 'T', bob, { now: NOW }), null)
  await syncAccountGraph(db, 'T', { now: NOW })
  assert.equal(await accountHold(db, db, 'T', bob, { now: NOW + DAY }), 'account_contacted_recently')
  assert.equal(await accountHold(db, db, 'T', bob, { now: NOW + 31 * DAY }), null, 'past the 30-day window')
  assert.equal(await accountHold(db, db, 'T', bob, { now: NOW, env: { DAZL_ACCOUNT_COOLDOWN_DAYS: '0' } }), null, 'a zero window turns it off')
  assert.equal(await accountHold(db, db, 'T', sameplay, { now: NOW }), null, 'the same play is not a cross-play duplicate')
  assert.equal(await accountHold(db, db, 'T', other, { now: NOW }), null, 'a same-name company on another website')
  // An unknown outcome counts as sent; a draft does not.
  const p3 = await play(db, 'T')
  const sam = await lead(db, p3, 'Birch Works', 'sam@birch-works.example', 'birch-works.example')
  const ann = await lead(db, p2, 'Birch Works', 'ann@birch-works.example', 'birch-works.example')
  await email(db, 'T', sam, 'sam@birch-works.example', 'draft', NOW)
  await syncAccountGraph(db, 'T', { now: NOW })
  assert.equal(await accountHold(db, db, 'T', ann, { now: NOW }), null)
  await db.run("UPDATE outreach_messages SET status = 'uncertain' WHERE lead_id = ?", [sam])
  assert.equal(await accountHold(db, db, 'T', ann, { now: NOW }), 'account_contacted_recently')
  // Another tenant with the same company and an email to it is no evidence for this one.
  const q = await play(db, 'U'), q2 = await play(db, 'U')
  const u1 = await lead(db, q, 'Cedar Co', 'a@cedar.example', 'cedar.example'), u2 = await lead(db, q2, 'Cedar Co', 'b@cedar.example', 'cedar.example')
  await syncAccountGraph(db, 'U', { now: NOW })
  await email(db, 'T', u1, 'a@cedar.example', 'sent', NOW) // a row naming U's lead under tenant T
  assert.equal(await accountHold(db, db, 'U', u2, { now: NOW }), null)
})

bothEngines('more peers than one query takes: the hold is still found', async ({ db }) => {
  const plays = [await play(db, 'T'), await play(db, 'T')]
  const peers: string[] = []
  for (let i = 0; i < 450; i++) peers.push(await lead(db, plays[0], 'Big Co', `p${i}@big-co.example`, 'big-co.example'))
  const target = await lead(db, plays[1], 'Big Co', 'new@big-co.example', 'big-co.example')
  await syncAccountGraph(db, 'T', { now: NOW, limit: 1000 })
  await email(db, 'T', peers[449], 'p449@big-co.example', 'sent', NOW)
  assert.equal(await accountHold(db, db, 'T', target, { now: NOW }), 'account_contacted_recently')
})

// Postgres holds the graph, SQLite still holds the emails: the rule joins them by lead id.
bothEngines('graph on this engine, emails in a separate SQLite store: the hold is found across stores', async ({ db, kind }) => {
  const raw = new Database(':memory:'); migrateOutreach(raw)
  const outreach = sqliteDb(raw)
  try {
    const p1 = await play(db, 'T'), p2 = await play(db, 'T')
    const jane = await lead(db, p1, 'Acme Roofing', 'jane@acme-roofing.example', 'acme-roofing.example')
    const bob = await lead(db, p2, 'Acme Roofing', 'bob@acme-roofing.example', 'acme-roofing.example')
    await syncAccountGraph(db, 'T', { now: NOW })
    assert.equal(await accountHold(db, outreach, 'T', bob, { now: NOW }), null, `${kind}: no email yet`)
    await email(outreach, 'T', jane, 'jane@acme-roofing.example', 'sent', NOW)
    assert.equal(await accountHold(db, outreach, 'T', bob, { now: NOW }), 'account_contacted_recently')
    // The engine's own outreach table has no email: only the outreach store counts.
    assert.equal(await accountHold(db, db, 'T', bob, { now: NOW }), null)
  } finally { raw.close() }
})

test('the graph store a route uses without DATABASE_URL is the route\'s own SQLite handle', async () => {
  const raw = new Database(':memory:')
  try { assert.equal((await graphStore(raw, {})).kind, 'sqlite') } finally { raw.close() }
})
