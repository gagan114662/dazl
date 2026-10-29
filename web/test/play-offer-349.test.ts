// #349 acceptance negatives (synthetic, no network, no model, no send). Instinct's exact case: a London play whose
// request states its offer as a bare sentence ("We sell CRM setup and outbound sales consulting.") was created while the
// profile sold dental software. The stated offer must be read, the play must be contested, and no drafting path
// (template, AI rewrite, follow-ups) nor scoring may use the dental offer for it until the tenant chooses. A tenant that
// only completed onboarding (offer in users.sells, no Memory) gets that offer in every path, template and rewrite alike.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { statedOffer, effectiveOffer, sameOffer } from '../lib/scan/play-offer-text.ts'
import { readPlayOffer, setPlayOffer } from '../lib/scan/play-offer.ts'
import { createDraft, saveSettings } from '../lib/outreach/service.ts'
import { polishDraft } from '../lib/outreach/draft-llm.ts'
import { memoryForLead } from '../lib/outreach/play-memory.ts'
import { offerBlockFor } from '../lib/scan/runner.ts'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateMemory } from '../lib/memory.ts'
import { sqliteDb } from '../lib/db/client.ts'
import type { Provider } from '../lib/llm/provider.ts'

const Q = 'Find London SaaS startups hiring. We sell CRM setup and outbound sales consulting. Exclude agencies.'
const DENTAL_SELLER = 'We sell appointment booking and reminder software to independent dental practices in New York City.'
const CRM = 'CRM setup and outbound sales consulting'
const master = randomBytes(32)

test('#349 the bare-sentence offer is read; exclusions, negations and plain targeting state none', () => {
  assert.equal(statedOffer(Q), CRM)
  for (const t of ['I offer bookkeeping.', 'We provide fractional CFO services!', 'Find dental clinics. We sell appointment reminders; exclude chains'])
    assert.ok(statedOffer(t), t)
  for (const t of ['Exclude agencies.', "We don't sell to agencies.", 'We do not sell hardware.', 'Independent dental practices in New York hiring a front-desk coordinator in the past 60 days', 'Find London SaaS startups hiring.'])
    assert.equal(statedOffer(t), null, t)
  // a "to/for" pattern no longer reaches into the next sentence
  assert.equal(statedOffer('We sell CRM setup. Looking for London SaaS founders'), 'CRM setup')
  assert.deepEqual(effectiveOffer({ seller: DENTAL_SELLER, query: Q }, ''), { offer: null, source: 'conflict', conflict: { stated: CRM, recorded: DENTAL_SELLER } })
  assert.ok(!sameOffer(CRM, DENTAL_SELLER))
})

function setup(sells: string) {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateKeys(db); migratePlans(db); migrateMemory(db)
  db.exec('CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, sells TEXT, website TEXT)')
  db.prepare('INSERT INTO users VALUES (?, ?, ?)').run('A', sells, 'https://seller.example')
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  saveSettings(db, 'A', { sender_name: 'G', postal_address: '1 King St W, Toronto ON, Canada', booking_url: null })
  const recent = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)
  for (const [id, query] of [['dental', 'Independent dental practices in New York City hiring a front-desk coordinator'], ['london', Q]] as const) {
    db.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status,query,seller) VALUES(?, 'A','Request','test','test','running',?,?)").run(id, query, `${DENTAL_SELLER} - https://seller.example`)
    db.prepare("INSERT INTO leads(id,scan_job_id,name,company,contact,signal,source_url,evidence_excerpt,confidence,human_confirmed_at,human_confirmed_from,event_date) VALUES(?,?,'Pat','Buyer','sales@buyer.invalid','Buyer is hiring an SDR','https://buyer.invalid/careers','Buyer is hiring an SDR',70,1800000000,'test_review',?)").run(`lead-${id}`, id, recent)
  }
  return db
}
const body = (db: Database.Database, id: string) => (db.prepare('SELECT body FROM outreach_messages WHERE id = ?').get(id) as { body: string }).body
const recording = () => {
  const prompts: string[] = []
  const providers = { anthropic: { completeDetailed: async (_k: string, prompt: string) => { prompts.push(prompt); return { text: 'x', model: 'm' } } } } as unknown as Record<string, Provider>
  return { prompts, providers }
}

test('#349 exact two-play case: the London play is contested everywhere until chosen; the dental play keeps dental', async () => {
  const db = setup(DENTAL_SELLER)
  try {
    // resolver (what Home and the campaign page show)
    assert.deepEqual(await readPlayOffer(sqliteDb(db), 'A', 'london'), { offer: null, source: 'conflict', conflict: { stated: CRM, recorded: DENTAL_SELLER } })
    assert.equal((await readPlayOffer(sqliteDb(db), 'A', 'dental'))!.offer, DENTAL_SELLER)
    // template: refused, nothing inserted; the dental play drafts dental
    assert.throws(() => createDraft(db, 'A', 'lead-london', 'Acme'), /offer_conflict/)
    assert.equal((db.prepare("SELECT count(*) n FROM outreach_messages WHERE lead_id = 'lead-london'").get() as { n: number }).n, 0)
    assert.match(body(db, createDraft(db, 'A', 'lead-dental', 'Acme')), /appointment booking/)
    // AI rewrite of a London draft written before this fix: refused before any provider call
    db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES ('m-london', 'A', 'lead-london', 'sales@buyer.invalid', 's', 'old dental body written before the fix', 'draft')").run()
    const r = recording()
    assert.deepEqual(await polishDraft(db, 'A', 'm-london', 'Acme', { master, providers: r.providers }), { rewritten: false, reason: 'offer_conflict' })
    assert.equal(r.prompts.length, 0)
    assert.equal(body(db, 'm-london'), 'old dental body written before the fix', 'the historical draft is not rewritten')
    // follow-ups and sequence steps state no offer; scoring gets none
    assert.equal(memoryForLead(db, 'A', 'lead-london')?.positioning ?? '', '', 'no offer stated (no Memory either: null)')
    assert.equal(offerBlockFor(db, 'A', 'london'), '')
    assert.match(memoryForLead(db, 'A', 'lead-dental')!.positioning, /appointment booking/)
    // the tenant chooses CRM for the London play: every path now says CRM, the dental play is untouched
    assert.equal(await setPlayOffer(sqliteDb(db), 'A', 'london', CRM), true)
    await polishDraft(db, 'A', 'm-london', 'Acme', { master, providers: r.providers })
    assert.equal(r.prompts.length, 1)
    assert.match(r.prompts[0], new RegExp(CRM)); assert.doesNotMatch(r.prompts[0], /appointment booking/)
    db.prepare("DELETE FROM outreach_messages WHERE id = 'm-london'").run()
    assert.match(body(db, createDraft(db, 'A', 'lead-london', 'Acme')), new RegExp(CRM))
    assert.equal(memoryForLead(db, 'A', 'lead-london')!.positioning, CRM)
    assert.match(offerBlockFor(db, 'A', 'london'), new RegExp(CRM))
    assert.equal((await readPlayOffer(sqliteDb(db), 'A', 'dental'))!.offer, DENTAL_SELLER)
  } finally { db.close() }
})

test('#349 onboarding only (users.sells, no Memory): template and AI rewrite state the same offer; no offer anywhere still refuses', async () => {
  const ONBOARDED = 'Bookkeeping for independent design agencies'
  const db = setup(ONBOARDED)
  try {
    // a play from before seller snapshots: the tenant context is its offer
    db.prepare("UPDATE scan_jobs SET seller = NULL WHERE id = 'dental'").run()
    const id = createDraft(db, 'A', 'lead-dental', 'Acme')
    assert.match(body(db, id), new RegExp(ONBOARDED))
    const r = recording()
    const res = await polishDraft(db, 'A', id, 'Acme', { master, providers: r.providers })
    assert.ok(res.rewritten || res.reason !== 'no_profile', JSON.stringify(res))
    assert.equal(r.prompts.length, 1); assert.match(r.prompts[0], new RegExp(ONBOARDED))
    assert.match(memoryForLead(db, 'A', 'lead-dental')!.positioning, new RegExp(ONBOARDED))
    // nothing saved anywhere: the rewrite refuses with no provider call
    db.prepare("UPDATE users SET sells = '' WHERE id = 'A'").run()
    db.prepare('DELETE FROM outreach_messages WHERE id = ?').run(id)
    const id2 = (db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES ('m2', 'A', 'lead-dental', 'sales@buyer.invalid', 's', 'a draft body long enough', 'draft') RETURNING id").get() as { id: string }).id
    assert.deepEqual(await polishDraft(db, 'A', id2, 'Acme', { master, providers: r.providers }), { rewritten: false, reason: 'no_profile' })
    assert.equal(r.prompts.length, 1)
  } finally { db.close() }
})

// Instinct's HOLD on #433 at 0e6d6c7: the bare-statement family covers every speaker/verb form of the to/for family, and
// only a positive seller assertion counts - never selling words inside targeting or an exclusion.
test('#349 HOLD every speaker/verb form is read; exclusions, targets and negations never fabricate an offer', () => {
  for (const [t, o] of [['We are selling CRM setup.', 'CRM setup'], ['We are offering CRM setup.', 'CRM setup'], ['We are providing CRM setup.', 'CRM setup'], ['I am offering CRM setup.', 'CRM setup'],
    ["We're selling CRM setup to London founders", 'CRM setup'], ['London SaaS founders - we sell CRM setup', 'CRM setup'], ['Our product: CRM setup', 'CRM setup']] as const)
    assert.equal(statedOffer(t), o, t)
  for (const t of ['Exclude agencies selling CRM to founders.', 'Do not target people selling services to dental practices.', 'We are not selling hardware.', 'We sell to dental practices.',
    'Find agencies offering SEO services to restaurants', 'Companies providing payroll for startups in Austin'])
    assert.equal(statedOffer(t), null, t)
  assert.deepEqual(effectiveOffer({ seller: 'Dental reminders', query: 'We are selling CRM setup.' }, ''), { offer: null, source: 'conflict', conflict: { stated: 'CRM setup', recorded: 'Dental reminders' } })
})

test('#349 HOLD caller paths: a progressive-form offer cannot draft, rewrite, follow up or score the recorded dental offer; exclusion-only text fabricates none', async () => {
  const db = setup(DENTAL_SELLER)
  try {
    db.prepare("UPDATE scan_jobs SET query = 'Find London SaaS startups hiring. We are offering CRM setup. Exclude agencies.' WHERE id = 'london'").run()
    db.prepare("UPDATE scan_jobs SET query = 'Find dental clinics hiring. Exclude agencies selling CRM to founders. Do not target people selling services to dental practices.' WHERE id = 'dental'").run()
    // progressive form: contested everywhere
    assert.equal((await readPlayOffer(sqliteDb(db), 'A', 'london'))!.source, 'conflict')
    assert.throws(() => createDraft(db, 'A', 'lead-london', 'Acme'), /offer_conflict/)
    db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES ('m-l', 'A', 'lead-london', 'sales@buyer.invalid', 's', 'old dental body written before the fix', 'draft')").run()
    const r = recording()
    assert.deepEqual(await polishDraft(db, 'A', 'm-l', 'Acme', { master, providers: r.providers }), { rewritten: false, reason: 'offer_conflict' })
    assert.equal(r.prompts.length, 0)
    assert.equal(memoryForLead(db, 'A', 'lead-london')?.positioning ?? '', '')
    assert.equal(offerBlockFor(db, 'A', 'london'), '')
    // exclusion-only text: no stated offer, no conflict; the play keeps its recorded dental offer and nothing says CRM
    assert.deepEqual(await readPlayOffer(sqliteDb(db), 'A', 'dental'), { offer: DENTAL_SELLER, source: 'recorded', conflict: null })
    const text = body(db, createDraft(db, 'A', 'lead-dental', 'Acme'))
    assert.match(text, /appointment booking/); assert.doesNotMatch(text, /CRM|services to dental/)
    assert.doesNotMatch(offerBlockFor(db, 'A', 'dental'), /CRM/)
  } finally { db.close() }
})

// Instinct's HOLD on #433 at 611d2aa: the target/exclusion check matched by prefix, so ordinary offers that start with a
// preposition's letters ("insurance", "inbound", "inventory", "forecasting", "attribution") were silently dropped and
// the recorded dental offer stayed active. Whole words only.
const PREFIX_OFFERS = [['We sell insurance.', 'insurance'], ['We offer inbound marketing.', 'inbound marketing'], ['We provide inventory management.', 'inventory management'],
  ['We sell forecasting software.', 'forecasting software'], ['We offer attribution software.', 'attribution software'], ['We sell no-code automation.', 'no-code automation'],
  ['We offer in-house training.', 'in-house training'], ['We sell totes.', 'totes'], ['We sell notary services.', 'notary services'], ['We sell exclusive concierge travel.', 'exclusive concierge travel']] as const
test('#349 HOLD-3 offers that begin with a preposition\'s letters are offers; whole-word targets and exclusions are not', () => {
  for (const [t, o] of PREFIX_OFFERS) {
    assert.equal(statedOffer(t), o, t)
    assert.deepEqual(effectiveOffer({ seller: 'Dental reminders', query: t }, ''), { offer: null, source: 'conflict', conflict: { stated: o, recorded: 'Dental reminders' } }, t)
  }
  for (const t of ['We sell to dental practices.', 'We sell for agencies.', 'We sell into hospitals.', 'We sell in Toronto.', 'We sell at trade shows.', 'We sell within Ontario.',
    'We sell only to clinics.', 'We sell no hardware.', 'We sell not just software.', 'Our offer: excluding agencies', 'Our offer: except chains'])
    assert.equal(statedOffer(t), null, t)
})

test('#349 HOLD-3 caller paths: each prefix offer under an incompatible recorded dental seller is contested; template, rewrite and scoring refuse', async () => {
  for (const [t, o] of PREFIX_OFFERS.slice(0, 5)) {
    const db = setup(DENTAL_SELLER)
    try {
      db.prepare('UPDATE scan_jobs SET query = ? WHERE id = ?').run(`Find London SaaS startups hiring. ${t}`, 'london')
      assert.deepEqual(await readPlayOffer(sqliteDb(db), 'A', 'london'), { offer: null, source: 'conflict', conflict: { stated: o, recorded: DENTAL_SELLER } }, t)
      assert.throws(() => createDraft(db, 'A', 'lead-london', 'Acme'), /offer_conflict/, t)
      db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES ('m-p', 'A', 'lead-london', 'sales@buyer.invalid', 's', 'old dental body written before the fix', 'draft')").run()
      const r = recording()
      assert.deepEqual(await polishDraft(db, 'A', 'm-p', 'Acme', { master, providers: r.providers }), { rewritten: false, reason: 'offer_conflict' }, t)
      assert.equal(r.prompts.length, 0, t)
      assert.equal(offerBlockFor(db, 'A', 'london'), '', t)
      // the dental play keeps its own offer
      assert.equal((await readPlayOffer(sqliteDb(db), 'A', 'dental'))!.offer, DENTAL_SELLER)
    } finally { db.close() }
  }
})
