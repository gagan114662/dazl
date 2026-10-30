// #349 acceptance negatives (synthetic, no network, no model, no send). Instinct's exact case: a London play whose
// request states its offer as a bare sentence ("We sell CRM setup and outbound sales consulting.") was created while the
// profile sold dental software. The stated offer must be read, the play must be contested, and no drafting path
// (template, AI rewrite, follow-ups) nor scoring may use the dental offer for it until the tenant chooses. A tenant that
// only completed onboarding (offer in users.sells, no Memory) gets that offer in every path, template and rewrite alike.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { statedOffer, effectiveOffer, sameOffer, withdrawnOffer, draftOffer } from '../lib/scan/play-offer-text.ts'
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

// Instinct's HOLD on 1d479f6: service exclusions without an explicit "we sell/offer" subject were dropped, and a
// product-only side matched a side that withdraws services. Only a missing audience may be filled in by the other side;
// terms (withdrawn services, exclusions, other offers) must match on both.
test('#349 LIVE-3 service exclusions of every form are material; a product-only side may omit only the audience', () => {
  const P = 'We sell CRM setup to founders.'
  for (const restricted of ['We sell CRM setup to founders. Do not offer outbound consulting.', 'We sell CRM setup to founders. No outbound consulting.',
    'We sell CRM setup to founders. We never do outbound consulting.', 'We sell CRM setup to founders. Never outbound consulting.', 'We sell CRM setup to founders, without outbound consulting.']) {
    assert.equal(sameOffer(restricted, P), false, restricted); assert.equal(sameOffer(P, restricted), false, restricted)
    assert.equal(effectiveOffer({ seller: P, query: restricted }, '').source, 'conflict', restricted)
    assert.equal(effectiveOffer({ seller: restricted, query: P }, '').source, 'conflict', `saved: ${restricted}`)
  }
  // a product-only side never matches a side with terms
  for (const [bare, restricted] of [['CRM setup', 'We sell CRM setup. We do not offer outbound consulting.'], ['CRM setup', 'We sell CRM setup to founders. No outbound consulting.'],
    [DENTAL_PRODUCT, `${DENTAL_SELLER} We do not offer payroll.`]] as const) {
    assert.equal(sameOffer(bare, restricted), false, restricted); assert.equal(sameOffer(restricted, bare), false, restricted)
  }
  // the same terms on both sides agree; targeting instructions of a request are not terms
  assert.ok(sameOffer('We sell CRM setup to founders. No outbound consulting.', 'we sell CRM setup to founders. no outbound consulting'))
  for (const q of [`Find dental practices in NYC. We sell ${DENTAL_PRODUCT}. Exclude chains.`, `Find dental clinics. Do not target agencies. We sell ${DENTAL_PRODUCT}.`, `Target independent dental practices hiring. Skip chains. We sell ${DENTAL_PRODUCT}.`])
    assert.deepEqual(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: q }, ''), { offer: DENTAL_SELLER, source: 'recorded', conflict: null }, q)
  // the original live case and the London control
  assert.deepEqual(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: DENTAL_PRODUCT }, ''), { offer: DENTAL_SELLER, source: 'recorded', conflict: null })
  assert.equal(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: Q }, '').source, 'conflict')
})

test('#349 HOLD-4 every further service assertion is material, in any wording; unparsed remainder is a conflict, targeting is not', async () => {
  const P = 'CRM setup'
  // Instinct's two cases: an extra offer without a "we", and a withdrawn service without a negation word
  for (const restricted of ['We sell CRM setup to founders. Selling payroll software to founders.', 'We sell CRM setup to founders. Outbound consulting is unavailable.',
    'We sell CRM setup. Payroll is included too.', 'We sell CRM setup. Outbound consulting discontinued.']) {
    assert.equal(sameOffer(restricted, P), false, restricted); assert.equal(sameOffer(P, restricted), false, restricted)
    // through the caller path: the request states the extra service, the saved offer is CRM setup alone, and the reverse
    assert.equal(effectiveOffer({ seller: `${P} - https://seller.example`, query: restricted }, '').source, 'conflict', restricted)
    assert.equal(effectiveOffer({ seller: `${restricted} - https://seller.example`, query: 'We sell CRM setup to founders.' }, '').source, 'conflict', `saved: ${restricted}`)
    assert.equal(effectiveOffer({ seller: null, query: restricted }, P).source, 'conflict', `profile: ${restricted}`)
  }
  // the database caller paths (resolver, template, scoring) refuse the play whose request adds a service
  const db = setup('CRM setup')
  try {
    db.prepare('UPDATE scan_jobs SET query = ?, seller = ? WHERE id = ?').run('We sell CRM setup to founders. Outbound consulting is unavailable.', 'CRM setup - https://seller.example', 'london')
    assert.equal((await readPlayOffer(sqliteDb(db), 'A', 'london'))!.source, 'conflict')
    assert.throws(() => createDraft(db, 'A', 'lead-london', 'Acme'), /offer_conflict/)
    assert.equal(offerBlockFor(db, 'A', 'london'), '')
    // the AI rewrite refuses it too
    const d = createDraft(db, 'A', 'lead-dental', 'Acme')
    db.prepare("UPDATE outreach_messages SET lead_id = 'lead-london' WHERE id = ?").run(d)
    const r = recording()
    assert.equal((await polishDraft(db, 'A', d, 'Acme', { master, providers: r.providers }) as { reason?: string }).reason, 'offer_conflict')
    assert.equal(r.prompts.length, 0, 'no model call')
  } finally { db.close() }
  // Instinct's exact calls against the full saved sentence, both directions
  for (const r of ['We sell CRM setup to founders. Selling payroll software to founders.', 'We sell CRM setup to founders. Outbound consulting is unavailable.']) {
    assert.equal(sameOffer(r, 'We sell CRM setup to founders.'), false, r); assert.equal(sameOffer('We sell CRM setup to founders.', r), false, r)
  }
  // genuine targeting instructions and an audience sentence equal to the saved audience are not terms
  for (const q of [`Find dental practices in NYC. We sell ${DENTAL_PRODUCT}. Exclude chains.`, `Independent dental practices in New York City. We sell ${DENTAL_PRODUCT}.`])
    assert.deepEqual(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: q }, ''), { offer: DENTAL_SELLER, source: 'recorded', conflict: null }, q)
  // a buyer description the grammar fully parses is targeting (HOLD-11); one it cannot place stays a conflict
  assert.deepEqual(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: `Independent dental practices hiring. We sell ${DENTAL_PRODUCT}.` }, ''), { offer: DENTAL_SELLER, source: 'recorded', conflict: null })
  assert.equal(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: `Independent dental practices hiring cost extra. We sell ${DENTAL_PRODUCT}.` }, '').source, 'conflict')
  // the original live case and the London control are unchanged
  assert.deepEqual(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: DENTAL_PRODUCT }, ''), { offer: DENTAL_SELLER, source: 'recorded', conflict: null })
  assert.equal(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: Q }, '').source, 'conflict')
  assert.equal(sameOffer('We sell CRM setup to founders. Outbound consulting is unavailable.', 'we sell crm setup to founders. outbound consulting is unavailable'), true)
})

test('#349 HOLD-5 a service named like an instruction ("Email marketing", "Contact enrichment", "Search advertising") is a term, not targeting', async () => {
  const P = 'We sell CRM setup to founders.'
  for (const extra of ['Email marketing is unavailable.', 'Contact enrichment is no longer offered.', 'Search advertising is discontinued.',
    'Email outreach discontinued.', 'Contact data is not offered.', 'Search ads are paused.']) {
    const restricted = `${P} ${extra}`
    assert.equal(sameOffer(restricted, P), false, restricted); assert.equal(sameOffer(P, restricted), false, restricted)
    assert.equal(effectiveOffer({ seller: `${P} - https://seller.example`, query: restricted }, '').source, 'conflict', restricted)
    assert.equal(effectiveOffer({ seller: `${restricted} - https://seller.example`, query: P }, '').source, 'conflict', `saved: ${restricted}`)
    assert.equal(effectiveOffer({ seller: null, query: restricted }, 'CRM setup').source, 'conflict', `profile: ${restricted}`)
  }
  // through the database caller paths
  const db = setup('CRM setup')
  try {
    db.prepare('UPDATE scan_jobs SET query = ?, seller = ? WHERE id = ?').run(`${P} Email marketing is unavailable.`, 'We sell CRM setup to founders. - https://seller.example', 'london')
    assert.equal((await readPlayOffer(sqliteDb(db), 'A', 'london'))!.source, 'conflict')
    assert.throws(() => createDraft(db, 'A', 'lead-london', 'Acme'), /offer_conflict/)
    assert.equal(offerBlockFor(db, 'A', 'london'), '')
  } finally { db.close() }
  // imperatives with the same first words stay targeting instructions
  for (const q of [`Email founders who are hiring. ${P}`, `Contact clinics in Leeds. ${P}`, `Search for agencies that are growing. ${P}`, `${P} Do not email agencies.`]) {
    assert.equal(sameOffer(q, P), true, q)
    assert.deepEqual(effectiveOffer({ seller: `${P} - https://seller.example`, query: q }, ''), { offer: P, source: 'recorded', conflict: null }, q)
  }
  // the original live case and the London control
  assert.deepEqual(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: DENTAL_PRODUCT }, ''), { offer: DENTAL_SELLER, source: 'recorded', conflict: null })
  assert.equal(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: Q }, '').source, 'conflict')
})

test('#349 HOLD-6 only a recognised imperative with a buyer object is targeting; any other statement about a service is material', async () => {
  const P = 'We sell CRM setup to founders.'
  for (const extra of ['Email marketing costs extra.', 'Contact enrichment requires a paid add-on.', 'Search advertising carries a separate fee.',
    'Email marketing is unavailable.', 'Contact enrichment is no longer offered.', 'Search advertising is discontinued.',
    'Message templates are billed separately.', 'Target accounts cost more.']) {
    const restricted = `${P} ${extra}`
    assert.equal(sameOffer(restricted, P), false, restricted); assert.equal(sameOffer(P, restricted), false, restricted)
    for (const seller of [P, 'CRM setup']) assert.equal(effectiveOffer({ seller: `${seller} - https://seller.example`, query: restricted }, '').source, 'conflict', `${restricted} | ${seller}`)
    assert.equal(effectiveOffer({ seller: `${restricted} - https://seller.example`, query: P }, '').source, 'conflict', `saved: ${restricted}`)
    assert.equal(effectiveOffer({ seller: null, query: restricted }, 'CRM setup').source, 'conflict', `profile: ${restricted}`)
  }
  const db = setup('CRM setup')
  try {
    db.prepare('UPDATE scan_jobs SET query = ?, seller = ? WHERE id = ?').run(`${P} Email marketing costs extra.`, 'CRM setup - https://seller.example', 'london')
    assert.equal((await readPlayOffer(sqliteDb(db), 'A', 'london'))!.source, 'conflict')
    assert.throws(() => createDraft(db, 'A', 'lead-london', 'Acme'), /offer_conflict/)
    assert.equal(offerBlockFor(db, 'A', 'london'), '')
  } finally { db.close() }
  // imperatives naming buyers stay targeting instructions
  for (const t of ['Email founders in London.', 'Email founders who are hiring.', 'Contact clinics in Leeds.', 'Search for agencies that are growing.',
    'Find SaaS startups hiring in London.', 'Reach out to dental practices.', 'Do not email agencies.', 'Exclude agencies, resellers and consultancies.', 'Skip chains.']) {
    const q = `${t} ${P}`
    assert.equal(sameOffer(q, P), true, q)
    assert.deepEqual(effectiveOffer({ seller: `${P} - https://seller.example`, query: q }, ''), { offer: P, source: 'recorded', conflict: null }, q)
  }
  assert.deepEqual(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: DENTAL_PRODUCT }, ''), { offer: DENTAL_SELLER, source: 'recorded', conflict: null })
  assert.equal(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: Q }, '').source, 'conflict')
})

test('#349 HOLD-7 only a demonstrable buyer-targeting imperative is ignored; an unknown statement about a service is a conflict', async () => {
  const P = 'We sell CRM setup to founders.'
  for (const extra of ['Email marketing includes SMS reminders.', 'Contact enrichment costs credits.', 'Search advertising requires additional fees.',
    'Email marketing supports agencies.', 'Email marketing helps clinics.', 'Email marketing can reach clinics.', 'Email marketing reached clinics.',
    'Email marketing for agencies.', 'Contact enrichment teams pay extra.', 'Search advertising is for startups.',
    'Email marketing costs extra.', 'Contact enrichment requires a paid add-on.', 'Search advertising carries a separate fee.',
    'Email marketing is unavailable.', 'Contact enrichment is no longer offered.', 'Search advertising is discontinued.']) {
    const restricted = `${P} ${extra}`
    assert.equal(sameOffer(restricted, P), false, restricted); assert.equal(sameOffer(P, restricted), false, restricted)
    for (const seller of [P, 'CRM setup']) assert.equal(effectiveOffer({ seller: `${seller} - https://seller.example`, query: restricted }, '').source, 'conflict', `${restricted} | ${seller}`)
    assert.equal(effectiveOffer({ seller: `${restricted} - https://seller.example`, query: P }, '').source, 'conflict', `saved: ${restricted}`)
    assert.equal(effectiveOffer({ seller: null, query: restricted }, 'CRM setup').source, 'conflict', `profile: ${restricted}`)
  }
  const db = setup('CRM setup')
  try {
    db.prepare('UPDATE scan_jobs SET query = ?, seller = ? WHERE id = ?').run(`${P} Email marketing supports agencies.`, 'CRM setup - https://seller.example', 'london')
    assert.equal((await readPlayOffer(sqliteDb(db), 'A', 'london'))!.source, 'conflict')
    assert.throws(() => createDraft(db, 'A', 'lead-london', 'Acme'), /offer_conflict/)
    assert.equal(offerBlockFor(db, 'A', 'london'), '')
  } finally { db.close() }
  for (const t of ['Email founders who are hiring.', 'Email founders in London.', 'Contact clinics in Leeds.', 'Search for agencies that are growing.',
    'Find SaaS startups hiring in London.', 'Reach out to dental practices.', 'Do not email agencies.', 'Exclude agencies, resellers and consultancies.',
    'Skip chains.', 'Find VC-backed startups.', 'Target independent dental practices hiring.']) {
    const q = `${t} ${P}`
    assert.equal(sameOffer(q, P), true, q)
    assert.deepEqual(effectiveOffer({ seller: `${P} - https://seller.example`, query: q }, ''), { offer: P, source: 'recorded', conflict: null }, q)
  }
  assert.deepEqual(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: DENTAL_PRODUCT }, ''), { offer: DENTAL_SELLER, source: 'recorded', conflict: null })
  assert.equal(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: Q }, '').source, 'conflict')
})

test('#349 HOLD-8 a modifier before the buyer must be provably descriptive; result statements in any tense are material', async () => {
  const P = 'We sell CRM setup to founders.'
  for (const extra of ['Email marketing got new customers.', 'Search advertising brought customers.', 'Contact enrichment made better teams.', 'Email marketing won customers.',
    'Email marketing grew founders.', 'Search advertising found startups.', 'Contact enrichment keeps customers.', 'Email marketing agencies.',
    'Email Marketing Won Customers.', 'Email marketing includes SMS reminders.', 'Email marketing supports agencies.', 'Email marketing costs extra.', 'Search advertising is discontinued.']) {
    const restricted = `${P} ${extra}`
    assert.equal(sameOffer(restricted, P), false, restricted); assert.equal(sameOffer(P, restricted), false, restricted)
    for (const seller of [P, 'CRM setup']) assert.equal(effectiveOffer({ seller: `${seller} - https://seller.example`, query: restricted }, '').source, 'conflict', `${restricted} | ${seller}`)
    assert.equal(effectiveOffer({ seller: `${restricted} - https://seller.example`, query: P }, '').source, 'conflict', `saved: ${restricted}`)
    assert.equal(effectiveOffer({ seller: null, query: restricted }, 'CRM setup').source, 'conflict', `profile: ${restricted}`)
  }
  const db = setup('CRM setup')
  try {
    db.prepare('UPDATE scan_jobs SET query = ?, seller = ? WHERE id = ?').run(`${P} Email marketing won customers.`, 'We sell CRM setup to founders. - https://seller.example', 'london')
    assert.equal((await readPlayOffer(sqliteDb(db), 'A', 'london'))!.source, 'conflict')
    assert.throws(() => createDraft(db, 'A', 'lead-london', 'Acme'), /offer_conflict/)
    assert.equal(offerBlockFor(db, 'A', 'london'), '')
  } finally { db.close() }
  for (const t of ['Email founders who are hiring.', 'Email founders in London.', 'Contact clinics in Leeds.', 'Search for agencies that are growing.',
    'Find SaaS startups hiring in London.', 'Reach out to dental practices.', 'Do not email agencies.', 'Exclude agencies, resellers and consultancies.',
    'Skip chains.', 'Find VC-backed startups.', 'Target independent dental practices hiring.', 'Email restaurant owners.', 'Contact clinic managers in Leeds.']) {
    const q = `${t} ${P}`
    assert.equal(sameOffer(q, P), true, q)
    assert.deepEqual(effectiveOffer({ seller: `${P} - https://seller.example`, query: q }, ''), { offer: P, source: 'recorded', conflict: null }, q)
  }
  assert.deepEqual(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: DENTAL_PRODUCT }, ''), { offer: DENTAL_SELLER, source: 'recorded', conflict: null })
  assert.equal(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: Q }, '').source, 'conflict')
})

test('#349 HOLD-9 the whole sentence is checked: a predicate after a place or buyer phrase is material, never cut off', async () => {
  const P = 'We sell CRM setup to founders.'
  for (const extra of ['Email providers in Canada cost extra.', 'Search providers in Canada are unavailable.', 'Email providers for agencies require additional fees.',
    'Email founders in London cost extra.', 'Contact clinics in Leeds are no longer served.', 'Email owners of clinics pay more.', 'Email founders who are hiring cost extra.',
    'Exclude agencies, resellers and consultancies cost extra.', 'Email marketing won customers.', 'Email marketing supports agencies.', 'Email marketing costs extra.',
    'Search advertising is discontinued.', 'Selling payroll software to founders.']) {
    const restricted = `${P} ${extra}`
    assert.equal(sameOffer(restricted, P), false, restricted); assert.equal(sameOffer(P, restricted), false, restricted)
    for (const seller of [P, 'CRM setup']) assert.equal(effectiveOffer({ seller: `${seller} - https://seller.example`, query: restricted }, '').source, 'conflict', `${restricted} | ${seller}`)
    assert.equal(effectiveOffer({ seller: `${restricted} - https://seller.example`, query: P }, '').source, 'conflict', `saved: ${restricted}`)
    assert.equal(effectiveOffer({ seller: null, query: restricted }, 'CRM setup').source, 'conflict', `profile: ${restricted}`)
  }
  const db = setup('CRM setup')
  try {
    db.prepare('UPDATE scan_jobs SET query = ?, seller = ? WHERE id = ?').run(`${P} Email providers in Canada cost extra.`, 'We sell CRM setup to founders. - https://seller.example', 'london')
    assert.equal((await readPlayOffer(sqliteDb(db), 'A', 'london'))!.source, 'conflict')
    assert.throws(() => createDraft(db, 'A', 'lead-london', 'Acme'), /offer_conflict/)
    assert.equal(offerBlockFor(db, 'A', 'london'), '')
  } finally { db.close() }
  // genuine targeting, geographic and otherwise, stays ignored
  for (const t of ['Email providers in Canada.', 'Email founders in London.', 'Contact clinics in New York City.', 'Find agencies based in Leeds.', 'Find dental practices in NYC.',
    'Email founders who are hiring.', 'Search for agencies that are growing.', 'Find SaaS startups hiring in London.', 'Email owners of clinics in Leeds.',
    'Exclude agencies, resellers and consultancies.', 'Do not email agencies.', 'Skip chains.', 'Contact clinic managers in Leeds.', 'Target independent dental practices hiring.']) {
    const q = `${t} ${P}`
    assert.equal(sameOffer(q, P), true, q)
    assert.deepEqual(effectiveOffer({ seller: `${P} - https://seller.example`, query: q }, ''), { offer: P, source: 'recorded', conflict: null }, q)
  }
  assert.deepEqual(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: DENTAL_PRODUCT }, ''), { offer: DENTAL_SELLER, source: 'recorded', conflict: null })
  assert.equal(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: Q }, '').source, 'conflict')
})

test('#349 HOLD-10 places are verified, never inferred from capitalisation; an unverified place tail is material', async () => {
  const P = 'We sell CRM setup to founders.'
  const negatives = ['Email providers in Canada Cost Extra.', 'Search providers in Canada Are Unavailable.', 'Email providers in Canada Support Agencies.',
    'Email providers in Canada cost extra.', 'email providers in canada cost extra.', 'EMAIL PROVIDERS IN CANADA COST EXTRA.',
    'Email founders in New York City Pay More.', 'Contact clinics in Leeds And Manchester Cost Extra.', 'Email providers in Premium Tiers.',
    'Email marketing won customers.', 'Email marketing costs extra.', 'Search advertising is discontinued.']
  for (const extra of negatives) {
    const restricted = `${P} ${extra}`
    assert.equal(sameOffer(restricted, P), false, restricted); assert.equal(sameOffer(P, restricted), false, restricted)
    for (const seller of [P, 'CRM setup']) assert.equal(effectiveOffer({ seller: `${seller} - https://seller.example`, query: restricted }, '').source, 'conflict', `${restricted} | ${seller}`)
    assert.equal(effectiveOffer({ seller: `${restricted} - https://seller.example`, query: P }, '').source, 'conflict', `saved: ${restricted}`)
    assert.equal(effectiveOffer({ seller: null, query: restricted }, 'CRM setup').source, 'conflict', `profile: ${restricted}`)
  }
  const db = setup('CRM setup')
  try {
    db.prepare('UPDATE scan_jobs SET query = ?, seller = ? WHERE id = ?').run(`${P} Email providers in Canada Cost Extra.`, 'We sell CRM setup to founders. - https://seller.example', 'london')
    assert.equal((await readPlayOffer(sqliteDb(db), 'A', 'london'))!.source, 'conflict')
    assert.throws(() => createDraft(db, 'A', 'lead-london', 'Acme'), /offer_conflict/)
    assert.equal(offerBlockFor(db, 'A', 'london'), '')
  } finally { db.close() }
  // verified places, in any case, stay targeting
  for (const t of ['Email providers in Canada.', 'email providers in canada.', 'Contact clinics in New York City.', 'Contact clinics in new york city.',
    'Find agencies based in Leeds.', 'Find dental practices in NYC.', 'Email founders in the United States.', 'Find agencies in London, Leeds and Manchester.',
    'Email founders in Texas.', 'Email founders who are hiring.', 'Find SaaS startups hiring in London.']) {
    const q = `${t} ${P}`
    assert.equal(sameOffer(q, P), true, q)
    assert.deepEqual(effectiveOffer({ seller: `${P} - https://seller.example`, query: q }, ''), { offer: P, source: 'recorded', conflict: null }, q)
  }
  assert.deepEqual(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: DENTAL_PRODUCT }, ''), { offer: DENTAL_SELLER, source: 'recorded', conflict: null })
  assert.equal(effectiveOffer({ seller: `${DENTAL_SELLER} - https://seller.example`, query: Q }, '').source, 'conflict')
})

test('#349 HOLD-11 the shipped smoke case: a grounded description of the buyers is targeting, through every caller path', async () => {
  const LIVE_Q = `Independent dental practices in New York City hiring a front-desk coordinator. We sell ${DENTAL_PRODUCT}.`
  const saved = `${DENTAL_SELLER} - https://seller.example`
  assert.deepEqual(effectiveOffer({ seller: saved, query: LIVE_Q }, ''), { offer: DENTAL_SELLER, source: 'recorded', conflict: null })
  assert.deepEqual(effectiveOffer({ seller: null, query: LIVE_Q }, DENTAL_SELLER), { offer: DENTAL_SELLER, source: 'profile', conflict: null })
  for (const t of ['Independent dental practices in New York City.', 'Dental practices in NYC hiring a receptionist.', 'Clinics in Leeds who are hiring office managers.',
    'SaaS startups hiring SDRs.', 'Independent dental practices hiring a part-time hygienist.'])
    assert.deepEqual(effectiveOffer({ seller: saved, query: `${t} We sell ${DENTAL_PRODUCT}.` }, ''), { offer: DENTAL_SELLER, source: 'recorded', conflict: null }, t)
  // caller paths: resolver, template drafting and scoring use the saved dental offer for that exact request
  const db = setup(DENTAL_SELLER)
  try {
    db.prepare('UPDATE scan_jobs SET query = ? WHERE id = ?').run(LIVE_Q, 'dental')
    assert.deepEqual(await readPlayOffer(sqliteDb(db), 'A', 'dental'), { offer: DENTAL_SELLER, source: 'recorded', conflict: null })
    assert.match(body(db, createDraft(db, 'A', 'lead-dental', 'Acme')), /appointment booking/)
    assert.match(offerBlockFor(db, 'A', 'dental'), /appointment booking and reminder software/)
    assert.equal((db.prepare("SELECT offer FROM scan_jobs WHERE id = 'dental'").get() as { offer: string | null }).offer, null, 'nothing chosen or written')
  } finally { db.close() }
  // still material: predicates after the description, unknown places, a role that is not a role, changed buyers, negations
  for (const q of [
    `Independent dental practices in New York City hiring a front-desk coordinator cost extra. We sell ${DENTAL_PRODUCT}.`,
    `Independent dental practices in Premium Tiers. We sell ${DENTAL_PRODUCT}.`,
    `Independent dental practices hiring a coordinator won customers. We sell ${DENTAL_PRODUCT}.`,
    `Dental practices hiring premium support. We sell ${DENTAL_PRODUCT}.`,
    `Email marketing agencies. We sell ${DENTAL_PRODUCT}.`,
    `We sell ${DENTAL_PRODUCT} to veterinary practices.`,
    `Independent dental practices in New York City. We sell ${DENTAL_PRODUCT}. Payroll is included.`,
  ]) assert.equal(effectiveOffer({ seller: saved, query: q }, '').source, 'conflict', q)
  assert.equal(effectiveOffer({ seller: saved, query: Q }, '').source, 'conflict', 'London')
})

test('#349 HOLD-12 a request that withdraws the saved offer stays unresolved: no offer invented, drafting and rewrite refuse, scoring states no offer, until chosen', async () => {
  const saved = `${DENTAL_SELLER} - https://seller.example`
  for (const q of [`We do not sell ${DENTAL_PRODUCT}.`, `We no longer sell ${DENTAL_PRODUCT}.`, `We don't sell ${DENTAL_PRODUCT} anymore.`, `Find London SaaS startups. We have stopped selling ${DENTAL_PRODUCT}.`]) {
    const r = effectiveOffer({ seller: saved, query: q }, '')
    assert.equal(r.source, 'conflict', q); assert.equal(r.offer, null, q)
    assert.equal(r.conflict!.stated, null, `nothing invented: ${q}`)
    assert.equal(r.conflict!.recorded, DENTAL_SELLER, q)
    assert.match(r.conflict!.withdrawn!, /appointment booking and reminder software/, q)
    assert.equal(effectiveOffer({ seller: null, query: q }, DENTAL_SELLER).source, 'conflict', `profile: ${q}`)
    assert.equal(draftOffer({ seller: saved, query: q }, '').offer, null, `draftOffer refuses: ${q}`)
  }
  // a withdrawal plus a different replacement offers that replacement, never the saved one
  const both = effectiveOffer({ seller: saved, query: `We no longer sell ${DENTAL_PRODUCT}. We sell CRM setup and outbound consulting.` }, '')
  assert.equal(both.source, 'conflict'); assert.match(both.conflict!.stated!, /CRM setup and outbound consulting/); assert.match(both.conflict!.withdrawn!, /appointment booking/)
  // not withdrawals: exclusions of other services, targeting negations and the genuine same-product positive
  for (const q of [`We sell ${DENTAL_PRODUCT}.`, `Independent dental practices in New York City hiring a front-desk coordinator. We sell ${DENTAL_PRODUCT}.`])
    assert.deepEqual(effectiveOffer({ seller: saved, query: q }, ''), { offer: DENTAL_SELLER, source: 'recorded', conflict: null }, q)
  for (const q of ['Find dental practices in NYC.', 'We sell CRM setup.', 'Do not email chains.', 'We do not sell to chains.', 'Find clinics that do not offer online booking.']) assert.equal(withdrawnOffer(q), null, q)
  // a "do not offer" about something else is left to the ordinary comparison (it resolved before withdrawals were read)
  for (const q of ['Find dental practices in NYC hiring. We do not offer free trials.', "We don't offer refunds."])
    assert.deepEqual(effectiveOffer({ seller: saved, query: q }, ''), { offer: DENTAL_SELLER, source: 'recorded', conflict: null }, q)
  // the overlap is read on the product words only: an exclusion that shares just the audience is not a withdrawal
  for (const q of ["We don't offer refunds to restaurants.", "We can't offer discounts for payroll software."])
    assert.equal(effectiveOffer({ seller: 'Payroll software to restaurants - https://s.example', query: q }, '').source, 'recorded', q)
  assert.equal(effectiveOffer({ seller: 'Payroll software to restaurants - https://s.example', query: 'We do not sell payroll software to chains.' }, '').source, 'conflict', 'same product, buyer excluded: a choice')
  // fails closed for a withdrawal that names the saved product in other words; terms only (refunds, trials) do not withdraw it
  const syn = effectiveOffer({ seller: saved, query: 'We no longer sell scheduling tools.' }, '')
  assert.deepEqual([syn.source, syn.conflict!.withdrawn, syn.conflict!.stated], ['conflict', 'scheduling tools', null])
  // a term-only withdrawal still conflicts when the saved product is made of those words
  const tr = effectiveOffer({ seller: 'Sales training courses for SaaS teams - https://s.example', query: 'We no longer sell training.' }, '')
  assert.deepEqual([tr.source, tr.conflict!.withdrawn], ['conflict', 'training'])
  // a comma-joined replacement is not swallowed into the withdrawn text. statedOffer does not read an offer after a comma
  // clause, so stated is null: the chooser offers keep-saved or write-this-play's-offer, never the withdrawn text
  const comma = effectiveOffer({ seller: saved, query: `We do not sell ${DENTAL_PRODUCT} anymore, we now sell CRM setup and outbound consulting.` }, '')
  assert.deepEqual([comma.source, comma.conflict!.withdrawn, comma.conflict!.stated], ['conflict', DENTAL_PRODUCT, null])
  // with no saved offer anywhere a withdrawal states none: nothing to draft with (no_profile), nothing invented
  const none = draftOffer({ seller: null, query: `We no longer sell ${DENTAL_PRODUCT}.` }, '')
  assert.equal(none.offer, null)
  // the changed-buyer, material and unknown-place negatives are unchanged
  for (const q of [`We sell ${DENTAL_PRODUCT} to veterinary practices.`, `We sell ${DENTAL_PRODUCT}. Payroll is included.`, `Independent dental practices in Premium Tiers. We sell ${DENTAL_PRODUCT}.`])
    assert.equal(effectiveOffer({ seller: saved, query: q }, '').source, 'conflict', q)
  // caller paths: template, follow-up-free rewrite and scoring refuse; an explicit choice then drafts with exactly that offer
  const db = setup(DENTAL_SELLER)
  try {
    db.prepare('UPDATE scan_jobs SET query = ? WHERE id = ?').run(`We no longer sell ${DENTAL_PRODUCT}.`, 'london')
    assert.equal((await readPlayOffer(sqliteDb(db), 'A', 'london'))!.source, 'conflict')
    assert.throws(() => createDraft(db, 'A', 'lead-london', 'Acme'), /offer_conflict/)
    assert.equal(offerBlockFor(db, 'A', 'london'), '', 'scoring gets no offer block for the unresolved play')
    const d = createDraft(db, 'A', 'lead-dental', 'Acme')
    const before = body(db, d)
    db.prepare("UPDATE outreach_messages SET lead_id = 'lead-london' WHERE id = ?").run(d)
    const r = recording()
    assert.equal((await polishDraft(db, 'A', d, 'Acme', { master, providers: r.providers }) as { reason?: string }).reason, 'offer_conflict')
    assert.equal(r.prompts.length, 0, 'no model call'); assert.equal(body(db, d), before, 'draft unchanged')
    assert.equal(await setPlayOffer(sqliteDb(db), 'A', 'london', 'CRM setup and outbound consulting'), true)
    assert.deepEqual(await readPlayOffer(sqliteDb(db), 'A', 'london'), { offer: 'CRM setup and outbound consulting', source: 'play', conflict: null })
    db.prepare("DELETE FROM outreach_messages WHERE lead_id = 'lead-london'").run()
    assert.match(body(db, createDraft(db, 'A', 'lead-london', 'Acme')), /CRM setup and outbound consulting/)
    assert.equal((db.prepare("SELECT sells FROM users WHERE id = 'A'").get() as { sells: string }).sells, DENTAL_SELLER, 'profile unchanged')
  } finally { db.close() }
})
