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

// Instinct's live verification on #349 (Gagan's original account): a request stating the same product as the saved
// seller sentence was a false conflict, because the parsed product was compared with the unparsed saved sentence. Both
// sides now go through the same offer parsing, then an exact comparison.
const DENTAL_PRODUCT = 'appointment booking and reminder software'
test('#349 LIVE same product: the request and the saved dental seller sentence are one offer; no conflict, saved text kept', () => {
  for (const query of [DENTAL_PRODUCT, `We sell ${DENTAL_PRODUCT}.`, `Find dental practices in NYC. We sell ${DENTAL_PRODUCT}. Exclude chains.`, `Our product: ${DENTAL_PRODUCT}`, `We offer ${DENTAL_PRODUCT} to independent dental practices in New York City`]) {
    assert.deepEqual(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query }, ''), { offer: DENTAL_SELLER, source: 'recorded', conflict: null }, query)
    assert.deepEqual(effectiveOffer({ query }, DENTAL_SELLER), { offer: DENTAL_SELLER, source: 'profile', conflict: null }, query)
  }
  assert.ok(sameOffer(DENTAL_PRODUCT, DENTAL_SELLER))
  assert.ok(sameOffer('Appointment  Booking and Reminder Software', DENTAL_SELLER), 'case and spacing only')
})

test('#349 LIVE controls: genuinely different offers, negations and buyer-only sentences still conflict (no substring or word-set match)', () => {
  // the London CRM/outbound request against the dental offer
  assert.deepEqual(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: Q }, ''), { offer: null, source: 'conflict', conflict: { stated: CRM, recorded: DENTAL_SELLER } })
  for (const [stated, saved] of [
    ['appointment booking software', DENTAL_SELLER], // a subset of the words is a different offer
    ['reminder software', DENTAL_SELLER],
    ['appointment booking and reminder software and payroll', DENTAL_SELLER], // a superset too
    ['reminder and appointment booking software', DENTAL_SELLER], // same words, other order
    ['booking software', 'We sell booking software and reminder software to clinics.'],
    [DENTAL_PRODUCT, `We do not sell ${DENTAL_PRODUCT}.`], // a negated saved sentence sells nothing
    [DENTAL_PRODUCT, 'We sell to independent dental practices in New York City.'], // buyers, not an offer
    ['SEO but not PPC', 'PPC but not SEO'],
  ] as const) {
    assert.equal(sameOffer(stated, saved), false, `${stated} | ${saved}`)
    assert.equal(effectiveOffer({ query: `We sell ${stated}.` }, saved).source, 'conflict', `${stated} | ${saved}`)
  }
})

test('#349 LIVE caller paths: the same-product play drafts, rewrites and scores with the saved dental offer; London still refuses', async () => {
  const db = setup(DENTAL_SELLER)
  try {
    db.prepare('UPDATE scan_jobs SET query = ? WHERE id = ?').run(`Independent dental practices in New York City. We sell ${DENTAL_PRODUCT}.`, 'dental')
    // resolver (Home, Campaign): the saved offer, unchanged, no conflict, nothing chosen or rewritten
    assert.deepEqual(await readPlayOffer(sqliteDb(db), 'A', 'dental'), { offer: DENTAL_SELLER, source: 'recorded', conflict: null })
    assert.equal((db.prepare("SELECT offer FROM scan_jobs WHERE id = 'dental'").get() as { offer: string | null }).offer, null, 'no offer chosen on the tenant\'s behalf')
    assert.equal((db.prepare("SELECT sells FROM users WHERE id = 'A'").get() as { sells: string }).sells, DENTAL_SELLER, 'saved offer not rewritten')
    // template drafting and scoring use the dental offer; the AI rewrite is not refused for a conflict
    const draft = createDraft(db, 'A', 'lead-dental', 'Acme')
    assert.match(body(db, draft), /appointment booking/)
    assert.match(offerBlockFor(db, 'A', 'dental'), /appointment booking and reminder software/)
    const r = recording()
    const p = await polishDraft(db, 'A', draft, 'Acme', { master, providers: r.providers })
    assert.notEqual((p as { reason?: string }).reason, 'offer_conflict')
    assert.ok(r.prompts.some(x => x.includes('appointment booking and reminder software')), 'the rewrite states the saved offer')
    // the London CRM play is still contested on every path
    assert.equal((await readPlayOffer(sqliteDb(db), 'A', 'london'))!.source, 'conflict')
    assert.throws(() => createDraft(db, 'A', 'lead-london', 'Acme'), /offer_conflict/)
    assert.equal(offerBlockFor(db, 'A', 'london'), '')
  } finally { db.close() }
})

// Instinct's HOLD on 5294651: comparing only the extracted product dropped explicit buyers, withdrawn services and
// seller negations. An offer that says only the product may agree with a fuller one; two statements that each say more
// must say the same.
test('#349 LIVE-2 explicit buyers, withdrawn services and seller negations are never collapsed into the same offer', () => {
  for (const [a, b] of [
    ['We sell appointment software to dental practices.', 'We sell appointment software to veterinary practices.'],
    ['We sell CRM setup to founders, but not outbound consulting.', 'We sell CRM setup to founders.'],
    ['We sell CRM setup to founders. We do not offer outbound consulting.', 'We sell CRM setup to founders.'],
    [`We offer ${DENTAL_PRODUCT} to clinics`, DENTAL_SELLER],
    [`We sell ${DENTAL_PRODUCT}. We do not offer payroll.`, `We sell ${DENTAL_PRODUCT} to independent dental practices in New York City. We also offer payroll.`],
  ] as const) {
    assert.equal(sameOffer(a, b), false, `${a} | ${b}`); assert.equal(sameOffer(b, a), false, `${b} | ${a}`)
  }
  assert.deepEqual(effectiveOffer({ seller: 'We sell appointment software to dental practices.', query: 'We sell appointment software to veterinary practices.' }, ''),
    { offer: null, source: 'conflict', conflict: { stated: 'appointment software', recorded: 'We sell appointment software to dental practices.' } })
  assert.equal(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: `Find clinics. We offer ${DENTAL_PRODUCT} to clinics.` }, '').source, 'conflict')
  assert.equal(effectiveOffer({ query: 'We sell CRM setup to founders. We do not offer outbound consulting.' }, 'We sell CRM setup to founders.').source, 'conflict')
  // the same full statement on both sides, and the product-only request, still agree
  assert.ok(sameOffer('We sell CRM setup to founders, but not outbound consulting.', 'we sell  CRM setup to Founders, but not outbound consulting'))
  assert.ok(sameOffer(DENTAL_PRODUCT, DENTAL_SELLER))
  assert.deepEqual(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: DENTAL_PRODUCT }, ''), { offer: DENTAL_SELLER, source: 'recorded', conflict: null })
})
