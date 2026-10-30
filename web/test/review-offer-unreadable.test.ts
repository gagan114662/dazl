// Reviewer's finding on PR #374 (synthetic data, no live database or provider): an operational failure reading a play's
// offer (busy, locked, I/O) must never look like "no play" and fall back to the tenant-wide offer. Drafting refuses
// with nothing inserted, the rewrite refuses before any paid call, follow-up context and scoring throw. Only an older
// schema (the table or column does not exist yet) is read as "no offer of its own".
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { playOfferRow, createDraft, saveSettings } from '../lib/outreach/service.ts'
import { polishDraft } from '../lib/outreach/draft-llm.ts'
import { memoryForLead } from '../lib/outreach/play-memory.ts'
import { offerBlockFor } from '../lib/scan/runner.ts'
import { isMissingSchema } from '../lib/scan/play-offer-text.ts'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateMemory, saveMemory } from '../lib/memory.ts'
import type { Provider } from '../lib/llm/provider.ts'

test('operational play-offer read failure must not silently look like no play', () => {
  const db = { prepare: () => { throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }) } }
  assert.throws(() => playOfferRow(db as never, 'A', 'lead-A'), /locked/)
})

const CRM = 'CRM setup and outbound consulting', DENTAL = 'Dental appointment software'
const master = randomBytes(32)
function setup() {
  const raw = new Database(':memory:')
  migrateScan(raw); migrateOutreach(raw); migrateConnectors(raw); migrateKeys(raw); migratePlans(raw); migrateMemory(raw)
  raw.exec('CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, sells TEXT, website TEXT)')
  raw.prepare('INSERT INTO users VALUES (?, ?, ?)').run('A', DENTAL, 'https://seller.example')
  saveMemory(raw, 'A', { positioning: DENTAL })
  saveKey(raw, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  saveSettings(raw, 'A', { sender_name: 'G', postal_address: '1 King St W, Toronto ON, Canada', booking_url: null })
  raw.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status,query,seller,offer) VALUES('play','A','Request','test','London','running','London startups',?,?)").run(DENTAL, CRM)
  raw.prepare("INSERT INTO leads(id,scan_job_id,name,company,contact,signal,source_url,evidence_excerpt,confidence,human_confirmed_at,human_confirmed_from,event_date) VALUES('lead-play','play','Pat','Buyer','sales@buyer.invalid','Buyer is hiring an SDR','https://buyer.invalid/careers','Buyer is hiring an SDR',70,1800000000,'test_review',?)").run(new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10))
  return raw
}
// the same database, except that reading a play's offer fails as a locked database would
const busy = (raw: Database.Database) => new Proxy(raw, {
  get(t, k) {
    if (k === 'prepare') return (sql: string) => { if (/offer,\s*(j\.)?seller/.test(sql)) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); return t.prepare(sql) }
    const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v
  },
}) as Database.Database
const messages = (raw: Database.Database) => (raw.prepare("SELECT count(*) n FROM outreach_messages WHERE lead_id = 'lead-play'").get() as { n: number }).n

test('drafting: an unreadable play refuses with offer_unreadable and inserts nothing; once readable it says the play\'s offer', () => {
  const raw = setup()
  try {
    assert.throws(() => createDraft(busy(raw), 'A', 'lead-play', 'Acme'), (e: Error & { code?: string }) => e.code === 'offer_unreadable')
    assert.equal(messages(raw), 0, 'nothing drafted, no global offer used')
    const id = createDraft(raw, 'A', 'lead-play', 'Acme')
    assert.match((raw.prepare('SELECT body FROM outreach_messages WHERE id = ?').get(id) as { body: string }).body, new RegExp(CRM))
  } finally { raw.close() }
})

test('rewrite: an unreadable play refuses before any paid call and records the refusal', async () => {
  const raw = setup()
  try {
    const id = createDraft(raw, 'A', 'lead-play', 'Acme')
    let calls = 0
    const providers = { anthropic: { completeDetailed: async () => { calls++; return { text: 'x', model: 'm' } } } } as unknown as Record<string, Provider>
    assert.deepEqual(await polishDraft(busy(raw), 'A', id, 'Acme', { master, providers }), { rewritten: false, reason: 'offer_unreadable' })
    assert.equal(calls, 0, 'no provider call')
    assert.equal((raw.prepare('SELECT outcome FROM outreach_llm_usage ORDER BY id DESC LIMIT 1').get() as { outcome: string }).outcome, 'offer_unreadable')
  } finally { raw.close() }
})

test('follow-up context and scoring: an unreadable play throws, never the global Memory offer', () => {
  const raw = setup()
  try {
    assert.throws(() => memoryForLead(busy(raw), 'A', 'lead-play'), /locked/)
    assert.throws(() => offerBlockFor(busy(raw), 'A', 'play'), /locked/)
    assert.match(memoryForLead(raw, 'A', 'lead-play')!.positioning, new RegExp(CRM))
    assert.match(offerBlockFor(raw, 'A', 'play'), new RegExp(CRM))
  } finally { raw.close() }
})

test('only an older schema (no offer column, no Memory table) reads as "no offer of its own"', () => {
  const old = new Database(':memory:')
  try {
    old.exec(`CREATE TABLE users(id TEXT PRIMARY KEY, sells TEXT); INSERT INTO users VALUES('A', '${DENTAL}');
      CREATE TABLE scan_jobs(id TEXT PRIMARY KEY, user_id TEXT, query TEXT); INSERT INTO scan_jobs VALUES('old', 'A', 'NYC dental practices');
      CREATE TABLE leads(id TEXT PRIMARY KEY, scan_job_id TEXT); INSERT INTO leads VALUES('lead-old', 'old')`)
    assert.equal(playOfferRow(old, 'A', 'lead-old'), null)
    assert.equal(memoryForLead(old, 'A', 'lead-old')?.positioning, DENTAL, 'follow-ups state the onboarding offer, as the template does (#349)')
    assert.match(offerBlockFor(old, 'A', 'old'), new RegExp(DENTAL), 'the profile offer, as before per-play offers')
  } finally { old.close() }
  for (const m of ['no such column: j.offer', 'no such table: tenant_memory', 'column "offer" does not exist', 'relation "tenant_memory" does not exist', 'column j.offer does not exist']) assert.ok(isMissingSchema(new Error(m)), m)
  for (const m of ['database is locked', 'disk I/O error', 'SQLITE_BUSY', 'Connection terminated unexpectedly', 'database disk image is malformed']) assert.ok(!isMissingSchema(new Error(m)), m)
})
