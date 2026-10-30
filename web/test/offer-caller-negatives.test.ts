// #349 (Instinct controls C25-C41 on #456): every exact negative from the review rounds goes through every real caller,
// not only through the comparator: the resolver (Home and the campaign page), template drafting (createDraft, nothing
// inserted), research scoring (offerBlockFor) and the AI rewrite (polishDraft, no model call). Each runs against both
// saved forms Instinct used ("CRM setup" alone and the full sentence). The targeting positives go through the same
// callers and keep the recorded offer. In-memory SQLite, a recording fake provider; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { readPlayOffer } from '../lib/scan/play-offer.ts'
import { createDraft, saveSettings } from '../lib/outreach/service.ts'
import { polishDraft } from '../lib/outreach/draft-llm.ts'
import { offerBlockFor } from '../lib/scan/runner.ts'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateMemory } from '../lib/memory.ts'
import { sqliteDb } from '../lib/db/client.ts'
import type { Provider } from '../lib/llm/provider.ts'

const BASE = 'We sell CRM setup to founders.'
const SAVED = ['CRM setup', BASE]
// Appended to BASE (or, last group, the whole request), as in each round's comment.
const NEGATIVES = [
  // HOLD-4
  'Selling payroll software to founders.', 'Outbound consulting is unavailable.',
  // HOLD-5
  'Email marketing is unavailable.', 'Contact enrichment is no longer offered.', 'Search advertising is discontinued.',
  // HOLD-6
  'Email marketing costs extra.', 'Contact enrichment requires a paid add-on.', 'Search advertising carries a separate fee.',
  // HOLD-7
  'Email marketing includes SMS reminders.', 'Contact enrichment costs credits.', 'Search advertising requires additional fees.', 'Email marketing supports agencies.',
  // HOLD-8
  'Email marketing got new customers.', 'Search advertising brought customers.', 'Contact enrichment made better teams.', 'Email marketing won customers.',
  // HOLD-9
  'Email providers in Canada cost extra.', 'Search providers in Canada are unavailable.', 'Email providers for agencies require additional fees.',
  // HOLD-10
  'Email providers in Canada Cost Extra.', 'Search providers in Canada Are Unavailable.', 'Email providers in Canada Support Agencies.',
  // LIVE-2 / LIVE-3 service exclusions
  'We do not offer outbound consulting.', 'Do not offer outbound consulting.', 'No outbound consulting.', 'We never do outbound consulting.',
].map(t => `${BASE} ${t}`).concat(['We sell CRM setup to founders, but not outbound consulting.'])
const POSITIVES = ['Email founders in London.', 'Email founders who are hiring.', 'Contact clinics in New York City.', 'Find agencies in London, Leeds and Manchester.', 'Do not email agencies.'].map(t => `${BASE} ${t}`)

const master = randomBytes(32)
function setup(saved: string, query: string) {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateKeys(db); migratePlans(db); migrateMemory(db)
  db.exec('CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, sells TEXT, website TEXT)')
  db.prepare('INSERT INTO users VALUES (?, ?, ?)').run('A', saved, 'https://seller.example')
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  saveSettings(db, 'A', { sender_name: 'G', postal_address: '1 King St W, Toronto ON, Canada', booking_url: null })
  const recent = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)
  for (const [id, q] of [['play', query], ['other', BASE]] as const) {
    db.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status,query,seller) VALUES(?, 'A','Request','test','test','running',?,?)").run(id, q, `${saved} - https://seller.example`)
    db.prepare("INSERT INTO leads(id,scan_job_id,name,company,contact,signal,source_url,evidence_excerpt,confidence,human_confirmed_at,human_confirmed_from,event_date) VALUES(?,?,'Pat','Buyer','sales@buyer.invalid','Buyer is hiring an SDR','https://buyer.invalid/careers','Buyer is hiring an SDR',70,1800000000,'test_review',?)").run(`lead-${id}`, id, recent)
  }
  return db
}
const recording = () => {
  const prompts: string[] = []
  const providers = { anthropic: { completeDetailed: async (_k: string, prompt: string) => { prompts.push(prompt); return { text: 'Hi Pat, a short synthetic rewrite about CRM setup for founders.', model: 'm' } } } } as unknown as Record<string, Provider>
  return { prompts, providers }
}
const drafts = (db: Database.Database) => (db.prepare('SELECT count(*) AS n FROM outreach_messages').get() as { n: number }).n

test(`#349 every exact negative from the review rounds (${NEGATIVES.length}) is refused by every caller, against both saved forms`, async () => {
  const failures: string[] = []
  for (const saved of SAVED) for (const q of NEGATIVES) {
    const db = setup(saved, q)
    try {
      const where = `[saved ${JSON.stringify(saved)}] ${q}`
      const o = await readPlayOffer(sqliteDb(db), 'A', 'play')
      if (o?.source !== 'conflict' || o.offer !== null) failures.push(`${where}: resolver gave ${JSON.stringify(o)}`)
      const before = drafts(db)
      try { createDraft(db, 'A', 'lead-play', 'Acme'); failures.push(`${where}: createDraft drafted`) } catch (e) { if (!/offer_conflict|offer_withdrawn|no_profile/.test(String(e))) failures.push(`${where}: createDraft threw ${e}`) }
      if (drafts(db) !== before) failures.push(`${where}: a draft was inserted`)
      if (offerBlockFor(db, 'A', 'play') !== '') failures.push(`${where}: research context stated an offer`)
      // the rewrite: a draft for the other (uncontested) play, moved onto this play's lead
      const d = createDraft(db, 'A', 'lead-other', 'Acme')
      db.prepare("UPDATE outreach_messages SET lead_id = 'lead-play' WHERE id = ?").run(d)
      const bodyBefore = (db.prepare('SELECT body FROM outreach_messages WHERE id = ?').get(d) as { body: string }).body
      const r = recording()
      const p = await polishDraft(db, 'A', d, 'Acme', { master, providers: r.providers }) as { rewritten?: boolean; reason?: string }
      if (p.rewritten || r.prompts.length) failures.push(`${where}: the rewrite ran (${r.prompts.length} model call(s))`)
      if ((db.prepare('SELECT body FROM outreach_messages WHERE id = ?').get(d) as { body: string }).body !== bodyBefore) failures.push(`${where}: the draft changed`)
    } finally { db.close() }
  }
  assert.deepEqual(failures, [])
})

test(`#349 the targeting positives (${POSITIVES.length}) keep the recorded offer through every caller`, async () => {
  for (const saved of SAVED) for (const q of POSITIVES) {
    const db = setup(saved, q)
    try {
      const where = `[saved ${JSON.stringify(saved)}] ${q}`
      const o = await readPlayOffer(sqliteDb(db), 'A', 'play')
      assert.equal(o?.conflict ?? null, null, `${where}: resolver`); assert.ok(o?.offer, `${where}: an offer is shown`)
      const d = createDraft(db, 'A', 'lead-play', 'Acme')
      assert.match((db.prepare('SELECT body FROM outreach_messages WHERE id = ?').get(d) as { body: string }).body, /CRM setup/, `${where}: the draft states the recorded offer`)
      assert.match(offerBlockFor(db, 'A', 'play'), /CRM setup/, `${where}: research context`)
      const r = recording()
      await polishDraft(db, 'A', d, 'Acme', { master, providers: r.providers })
      assert.equal(r.prompts.length, 1, `${where}: the rewrite made its one model call`)
    } finally { db.close() }
  }
})
