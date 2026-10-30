// The real POST /api/outreach handler (run under test/helpers/sequence-route-loader.mjs): it links the tenant's leads to
// canonical accounts itself and holds a first touch to a company or a person another play already emailed (#364).
// Synthetic tenant, plays, companies and addresses; no network, no provider call, nothing sent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb } from './sequence-route-db.ts'
import { migrateScan, createJob } from '../../lib/scan/store.ts'
import { migrateOutreach } from '../../lib/outreach/store.ts'
import { migrateSequences } from '../../lib/outreach/sequences.ts'
import { migrateMemory, saveMemory } from '../../lib/memory.ts'
import { migrateKeys } from '../../lib/llm/key-store.ts'
import { providers } from '../../lib/llm/provider.ts'
import { POST as draftPOST } from '../../app/api/outreach/route.ts'

process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
delete process.env.DATABASE_URL
const providerCalls: string[] = [], fetchCalls: string[] = []
for (const [name, p] of Object.entries(providers)) if (p.complete) p.complete = async () => { providerCalls.push(name); throw new Error('Unexpected provider call') }
globalThis.fetch = (async (url: unknown) => { fetchCalls.push(String(url)); throw new Error('Unexpected network call') }) as typeof fetch
const draft = (leadId: string) => draftPOST(new NextRequest('http://localhost/api/outreach', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lead_id: leadId }),
}))
const NOW = Math.floor(Date.now() / 1000)

test('draft route: links the leads itself, holds a company and a person another play emailed, drafts the rest', async () => {
  const db = new Database(':memory:')
  try {
    migrateScan(db); migrateOutreach(db); migrateSequences(db); migrateMemory(db); migrateKeys(db)
    setScanDb(db)
    saveMemory(db, 'A', { positioning: 'Software to find leads with linked public evidence.' })
    const play = () => { const j = createJob(db, 'A', { business_name: 'Synthetic', industry: 'test', location: 'test' }); db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(j); return j }
    const lead = (job: string, company: string, contact: string, domain: string | null) => {
      const id = randomBytes(12).toString('hex')
      db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, company_domain, human_confirmed_at, human_confirmed_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, job, company, contact, 'Hiring five roofers (synthetic)', 'https://news.example/a', `${company} is hiring five roofers`, 85, domain, NOW, 'test_review')
      return id
    }
    const p1 = play(), p2 = play()
    const jane = lead(p1, 'Acme Roofing', 'jane@acme-roofing.example', 'acme-roofing.example')
    db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES ('m-jane', 'A', ?, 'jane@acme-roofing.example', 'Quick question', 'A synthetic body that is long enough.', 'sent', ?, ?)").run(jane, NOW, NOW)
    const bob = lead(p2, 'Acme Roofing Ltd', 'bob@acme-roofing.example', 'acme-roofing.example')
    // Jane again, found as the contact of another company (its own website): that account has no contact for her and no
    // email, so only the same-address rule can catch her, and it does.
    const janeAgain = lead(p2, 'Jane Consulting', 'Jane@acme-roofing.example', 'jane-consulting.example')
    // A same-named business with no website and only a free mailbox: its identity waits for a person, so it is not drafted.
    const bare = lead(p2, 'Acme Roofing', 'acme.roofing.owner@gmail.com', null)
    const other = lead(p2, 'Acme Roofing', 'kim@acme-roofing-west.example', 'acme-roofing-west.example')
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tenant_lead_links').get() as { n: number }).n, 0, 'nothing linked before the request')

    const r1 = await draft(bob)
    assert.equal(r1.status, 409)
    assert.equal((await r1.json()).code, 'account_contacted_recently')
    const links = db.prepare("SELECT lead_id, account_id, status FROM tenant_lead_links WHERE tenant_id = 'A'").all() as { lead_id: string; account_id: string | null; status: string }[]
    const acct = (id: string) => links.find(l => l.lead_id === id)
    assert.equal(acct(bob)?.account_id, acct(jane)?.account_id, 'the route linked both plays\' leads to one account')

    const r2 = await draft(janeAgain)
    assert.equal(r2.status, 409)
    assert.equal((await r2.json()).code, 'recipient_contacted_recently')
    const r4 = await draft(bare)
    assert.equal(r4.status, 409)
    assert.equal((await r4.json()).code, 'identity_review_required')

    const r3 = await draft(other)
    assert.equal(r3.status, 201, 'a same-name company on another website is drafted')
    assert.deepEqual((db.prepare('SELECT lead_id FROM outreach_messages ORDER BY lead_id').all() as { lead_id: string }[]).map(r => r.lead_id).sort(), [jane, other].sort(), 'no draft for the held leads')
    void links
    assert.deepEqual(providerCalls, []); assert.deepEqual(fetchCalls, [])
  } finally { db.close() }
})

function fixture() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateSequences(db); migrateMemory(db); migrateKeys(db)
  setScanDb(db)
  saveMemory(db, 'A', { positioning: 'Software to find leads with linked public evidence.' })
  const play = () => { const j = createJob(db, 'A', { business_name: 'Synthetic', industry: 'test', location: 'test' }); db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(j); return j }
  const lead = (job: string, company: string, contact: string, domain: string | null, createdAt: number) => {
    const id = randomBytes(12).toString('hex')
    db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, company_domain, human_confirmed_at, human_confirmed_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, job, company, contact, 'Hiring five roofers (synthetic)', 'https://news.example/a', `${company} is hiring five roofers`, 85, domain, NOW, 'test_review', createdAt)
    return id
  }
  const emailed = (leadId: string, to: string) => db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES (?, 'A', ?, ?, 'Quick question', 'A synthetic body that is long enough.', 'sent', ?, ?)").run(randomBytes(6).toString('hex'), leadId, to, NOW, NOW)
  return { db, play, lead, emailed }
}

// Instinct's #364 review of d77d409e: a backlog larger than one linking batch must not let a first touch through.
test('draft route: 501 unlinked leads ahead of the target and of the emailed lead do not hide the account', async () => {
  const { db, play, lead, emailed } = fixture()
  try {
    const p1 = play(), p2 = play()
    for (let i = 0; i < 501; i++) lead(p1, `Filler ${i}`, `buyer@filler-${i}.example`, `filler-${i}.example`, NOW - 10_000 + i)
    const jane = lead(p1, 'Acme Roofing', 'jane@acme-roofing.example', 'acme-roofing.example', NOW)
    emailed(jane, 'jane@acme-roofing.example')
    const bob = lead(p2, 'Acme Roofing', 'bob@acme-roofing.example', 'acme-roofing.example', NOW + 1)
    const r = await draft(bob)
    assert.equal(r.status, 409)
    assert.equal((await r.json()).code, 'account_contacted_recently')
    assert.equal(db.prepare('SELECT 1 FROM outreach_messages WHERE lead_id = ?').get(bob), undefined, 'no draft')
  } finally { db.close() }
})

test('draft route: when identity linking fails the draft is held (503), never created; once linking works, it proceeds', async () => {
  const { db, play, lead } = fixture()
  try {
    const target = lead(play(), 'Cedar Works', 'sam@cedar-works.example', 'cedar-works.example', NOW)
    db.exec('ALTER TABLE tenant_lead_links RENAME TO tenant_lead_links_unavailable')
    const r = await draft(target)
    assert.equal(r.status, 503)
    assert.equal((await r.json()).code, 'identity_unresolved')
    assert.equal(db.prepare('SELECT 1 FROM outreach_messages WHERE lead_id = ?').get(target), undefined, 'no draft')
    db.exec('ALTER TABLE tenant_lead_links_unavailable RENAME TO tenant_lead_links')
    assert.equal((await draft(target)).status, 201, 'control: the same lead drafts once its identity resolves')
  } finally { db.close() }
})
