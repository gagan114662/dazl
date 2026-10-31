// #349 live dental control (Instinct, 2026-10-30 on production aad968d4): the ORIGINAL dental request, run while the saved
// offer is the dental sentence, was shown as a conflict with itself (campaign GET offer:null source:conflict), and the
// London request still has to be a genuine conflict. The records are reconstructed exactly as stored: both plays carry
// seller = the saved dental sentence with no website suffix (website is ""), offer NULL, offer_set_at NULL; users.sells
// is that sentence; no tenant_memory row. Nothing is shortened and no offer is forced, so the failing path is the one
// under test. Synthetic ids and contacts; no network, no model, no send.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { effectiveOffer, sameOffer, statedOffer } from '../lib/scan/play-offer-text.ts'
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
import { bothEngines } from './helpers/engines.ts'
import type { Provider } from '../lib/llm/provider.ts'

export const SAVED = 'We sell appointment booking and reminder software to independent dental practices in New York City.'
export const P = 'appointment booking and reminder software'
export const CRM = 'CRM setup and outbound sales consulting'
// the two original requests, verbatim (en dash in "1–5")
export const DENTAL_REQUEST = 'Find independent dental practices in New York City with 1–5 locations that opened a new location or are hiring a receptionist in the last 90 days. We sell appointment booking and reminder software. Exclude large chains, vendors, directories, and practices outside NYC. Show the dated evidence and an owner or practice manager contact.'
export const LONDON_REQUEST = 'Find B2B SaaS startups in London, UK that raised seed funding or are hiring their first sales representative in the last 90 days. We sell CRM setup and outbound sales consulting. Exclude agencies, directories and companies outside the UK. Show dated source evidence and founder or head of sales contacts.'
const DENTAL_ID = 'd2e67ea235567418b0b932d8', LONDON_ID = 'c53bb81d0b6d00d2a2f31144'

const resolve = (query: string, seller: string | null = SAVED, profile = SAVED) => effectiveOffer({ offer: null, seller, query }, profile)

test('#349 live control: the original dental request is the saved dental offer, not a conflict; London is a conflict', () => {
  assert.equal(statedOffer(DENTAL_REQUEST), P)
  assert.deepEqual(resolve(DENTAL_REQUEST), { offer: SAVED, source: 'recorded', conflict: null })
  // the same through the profile path (a play from before seller snapshots)
  assert.deepEqual(resolve(DENTAL_REQUEST, null), { offer: SAVED, source: 'profile', conflict: null })
  assert.deepEqual(resolve(LONDON_REQUEST), { offer: null, source: 'conflict', conflict: { stated: CRM, recorded: SAVED } })
})

// The failure class: ordinary targeting and output instructions of a request were material terms unless the grammar
// consumed every word. Each sentence Instinct listed, alone with the offer sentence, is the saved offer.
const TARGETING_OR_OUTPUT = [
  'Find independent dental practices in New York City with 1–5 locations that opened a new location or are hiring a receptionist in the last 90 days.',
  'Exclude large chains, vendors, directories, and practices outside NYC.',
  'Show the dated evidence and an owner or practice manager contact.',
  'Show dated source evidence.',
  // the London request's own targeting and output sentences, with the dental offer: still the dental offer
  'Find B2B SaaS startups in London, UK that raised seed funding or are hiring their first sales representative in the last 90 days.',
  'Exclude agencies, directories and companies outside the UK.',
  'Show dated source evidence and founder or head of sales contacts.',
  // more of the same class: sizes, windows, events, places, exclusions, output columns
  'Find dental practices with 10-50 employees.',
  'Target clinics with 2+ locations in Texas.',
  'Find practices that opened a second location in the past 6 months.',
  'Find startups that raised a Series A this year.',
  'Find agencies that launched a new product recently.',
  'Find companies that are hiring an office manager or a receptionist.',
  'Exclude franchises, job boards and recruiters.',
  'Show the source link, the date and a named contact.',
  'List the company, website, evidence and decision-maker contact.',
  'Please show dated evidence for each lead.',
  // council: a size as a list item
  'Find independent dental practices in New York City, 1-5 locations, hiring receptionists.',
  'Show the evidence with dates.',
  'Show practices an owner contact.',
  'Report practice manager phone numbers.',
  'Find practices that opened a new location or raised a round.',
  // self-probe: request forms a user writes that the grammar had no word for
  'Find London SaaS startups hiring.',
  'Target NYC dental practices hiring a receptionist.',
  'Find New York dental practices (1-5 locations).',
  'Find US dental practices with 2+ locations.',
  'Find startups that raised $2M in the last 90 days.',
  'Find startups that raised 2 million this year.',
  'Find practices hiring 2 receptionists.',
  'Find practices that are hiring for a receptionist role.',
  'Find practices that opened a 2nd location in the past six months.',
  'Find dental practices in Brooklyn or Jersey City.',
  'Find clinics within the last ninety days.',
  // council seat 3: count ranges and hyphenated role modifiers
  'Find dental practices hiring one or two receptionists.',
  'Find dental practices hiring 2-3 receptionists.',
  'Find dental practices hiring for a sales-automation role.',
  'Find startups hiring their first sales hire.',
]
test('#349 class: a targeting or output instruction of the request is never a commercial term', () => {
  const failures: string[] = []
  for (const s of TARGETING_OR_OUTPUT) {
    const q = `${s} We sell ${P}.`
    if (!sameOffer(q, SAVED)) failures.push(`sameOffer: ${s}`)
    const r = resolve(q)
    if (r.source !== 'recorded' || r.offer !== SAVED) failures.push(`effectiveOffer: ${s} -> ${r.source}`)
  }
  assert.deepEqual(failures, [])
})

// Fail-closed controls: genuine changes in product, audience, withdrawals and commercial terms, and sentences the
// grammar cannot prove to be targeting or output, stay a choice even next to the sentences above.
const STILL_A_CHOICE: [string, string][] = [
  ['changed product', `${TARGETING_OR_OUTPUT[0]} We sell ${CRM}.`],
  ['changed audience', `${TARGETING_OR_OUTPUT[0]} We sell ${P} to veterinary practices.`],
  ['withdrawal', `${TARGETING_OR_OUTPUT[0]} We sell ${P}. We no longer offer SMS reminders.`],
  ['commercial term', `${TARGETING_OR_OUTPUT[0]} We sell ${P}. Email marketing costs extra.`],
  ['commercial term in an output sentence', `Show the dated evidence and our discount. We sell ${P}.`],
  ['service claim in a targeting sentence', `Find dental practices that opened a new location and bought payroll software from us. We sell ${P}.`],
  ['event the grammar does not know', `Find dental practices that outsourced billing in the last 90 days. We sell ${P}.`],
  ['unknown place', `Find dental practices in Premium Tiers with 1–5 locations. We sell ${P}.`],
  ['predicate after the window', `Find dental practices in the last 90 days cost extra. We sell ${P}.`],
  ['result claim', `Independent dental practices hiring a coordinator won customers. We sell ${P}.`],
  ['extra service', `${TARGETING_OR_OUTPUT[2]} We sell ${P} and payroll software.`],
  // council: a sentence that hands the buyers something is an offer, never a report ("what to show")
  ['hands the buyers leads', `Provide dental practices with leads. We sell ${P}.`],
  ['hands the buyers leads', `Provide dental practices with new leads. We sell ${P}.`],
  ['hands the buyers a quote', `Give dental practices a quote. We sell ${P}.`],
  ['hands the buyers a website', `Give dental practices a new website. We sell ${P}.`],
  ['hands the buyers a website', `Provide dental practices with a website. We sell ${P}.`],
  ['hands the buyers a brand', `Provide dental practices with a new brand. We sell ${P}.`],
  ['hands the buyers a location', `Give dental practices a new location. We sell ${P}.`],
  ['hands the buyers a receptionist', `Provide dental practices with a new receptionist. We sell ${P}.`],
  ['hands the buyers contact data', `Provide dental practices with email addresses and phone numbers. We sell ${P}.`],
  ['buyers as the object of a report verb', `Show dental practices a new website. We sell ${P}.`],
  ['buyers as the object of a report verb', `Show dental practices leads. We sell ${P}.`],
  ['from us is the seller, not a place', `Find dental practices that recruited a receptionist from us. We sell ${P}.`],
  ['a contract length is not a window', `Find dental practices for 3 months. We sell ${P}.`],
  ['a contract length is not a window', `Find dental practices for one year. We sell ${P}.`],
  // council seat 3: a later person noun must not license an earlier buyer object
  ['buyer object before a person noun', `Show dental practices a new website and contact details. We sell ${P}.`],
  ['buyer object before a person noun', `Show dental practices leads and contacts. We sell ${P}.`],
  ['buyer object before a person noun', `Show clinics a new location and contacts. We sell ${P}.`],
  ['a role given, not reported', `Show practices a receptionist and a contact. We sell ${P}.`],
  ['a role given, not reported', `Show practices a receptionist or a contact. We sell ${P}.`],
  // council seat 1: a negated include/find narrows the offer; only an excluding verb skips these nouns
  ['negated include', `Do not include customer portals. We sell ${P}.`],
  ['negated include', `Don't include directory listings. We sell ${P}.`],
  ['negated find', `Never find marketplaces. We sell ${P}.`],
  // council seat 3: an instruction to the seller after a comma is not a buyer event
  ['instruction after a comma', `Customers, add a product. We sell ${P}.`],
  ['instruction after a comma', `Find practices, open a new location. We sell ${P}.`],
  // self-probe negatives for the widened forms
  ['a price event', `Find startups that raised prices. We sell ${P}.`],
  ['hiring for a service', `Find practices hiring for payroll. We sell ${P}.`],
  ['include a service', `Include customer support. We sell ${P}.`],
  ['include a product', `Include payroll software. We sell ${P}.`],
  // "include" states offer scope, so it is never a report verb, even with report nouns (council seat 1)
  ['include states scope', `Include email and phone. We sell ${P}.`],
  ['include states scope', `Include 50 leads. We sell ${P}.`],
  ['include states scope', `Include a website and a domain. We sell ${P}.`],
  ['include states scope', `Include listings. We sell ${P}.`],
  ['include states scope', `Include leads. We sell ${P}.`],
  ['include states scope (fail-closed)', `Include an owner or practice manager contact. We sell ${P}.`],
  ['an unverified capitalised modifier', `Find Premium dental practices. We sell ${P}.`],
  ['money as a term', `Find practices. We sell ${P} for $2M.`],
  // "provide"/"give" are never report verbs, even with report nouns only: an imperative "Provide X" can be the offer
  ['give/provide is not a report verb', `Provide dated evidence and a summary. We sell ${P}.`],
  ['give/provide is not a report verb', `Give us the dated evidence. We sell ${P}.`],
  // council seat 1: seats, members, units and desks are pricing units, not a buyer's size
  ['a seat count is a commercial term', `Dental practices, 10 seats. We sell ${P}.`],
  ['a seat count is a commercial term', `Dental practices with 10 seats. We sell ${P}.`],
  ['a seat count is a commercial term', `Practices, up to 20 seats. We sell ${P}.`],
  ['a unit count is a commercial term', `Find dental practices with 5 units. We sell ${P}.`],
  // council seat 3: a commercial term inside a report item is a service, not who to show
  ['a service in a report item', `Include customer support contacts. We sell ${P}.`],
  ['a service in a report item', `Show training contacts. We sell ${P}.`],
  ['a service in a report item', `Show the onboarding contact. We sell ${P}.`],
  ['a service in a report item', `Show support contacts. We sell ${P}.`], // "support" is also a role modifier: only the term rule catches it
  ['a service in a report item', `Show customer support contacts. We sell ${P}.`],
  // "receive" is not an event verb: what the buyers received may be the seller's product
  ['received a product', `Find practices that received a new product. We sell ${P}.`],
  ['received a product', `Find practices that have received a product. We sell ${P}.`],
]
test('#349 class controls: changed product, audience, withdrawals, commercial terms and unproved sentences stay a choice', () => {
  const failures: string[] = []
  for (const [why, q] of STILL_A_CHOICE) {
    const r = resolve(q)
    if (r.source !== 'conflict') failures.push(`${why}: "${q}" -> ${r.source}`)
    if (sameOffer(q, SAVED)) failures.push(`${why}: sameOffer true`)
  }
  assert.deepEqual(failures, [])
})

// The exact stored records, through the real DB-backed resolver on both engines: Home, campaign detail, the outreach
// list and drafting all read readPlayOffer. Reads write nothing; the other tenant sees no play; the profile is never
// rewritten; an explicit choice changes only that play.
const T = 'a'.repeat(32), OTHER = 'b'.repeat(32)
bothEngines('#349 live records: dental resolves to the saved offer, London is a choice, isolation and immutability', async ({ db }) => {
  await db.run('INSERT INTO users (id, email, password_hash, salt, sells, website, buyer_profile) VALUES (?, ?, ?, ?, ?, ?, NULL)', [T, 'owner@seller.example', 'x', 'y', SAVED, ''])
  await db.run('INSERT INTO users (id, email, password_hash, salt, sells, website) VALUES (?, ?, ?, ?, ?, ?)', [OTHER, 'other@seller.example', 'x', 'y', 'Bookkeeping for design agencies', ''])
  for (const [id, query, icp, industry, location, name] of [
    [DENTAL_ID, DENTAL_REQUEST, '{"summary":"independent dental practices in NYC"}', 'Dental', 'New York City', 'Dental Seller'],
    [LONDON_ID, LONDON_REQUEST, '{"summary":"London B2B SaaS startups"}', 'SaaS', 'London, UK', 'Dental Seller'],
  ] as const) {
    await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller, icp, icp_inferred, offer, offer_set_at) VALUES (?, ?, ?, ?, ?, 'done', ?, ?, ?, 1, NULL, NULL)", [id, T, name, industry, location, query, SAVED, icp])
  }
  const snapshot = async () => JSON.stringify([
    await db.all('SELECT id, offer, offer_set_at, seller, query FROM scan_jobs ORDER BY id'),
    await db.all('SELECT id, sells, website FROM users ORDER BY id'),
  ])
  const before = await snapshot()
  assert.deepEqual(await readPlayOffer(db, T, DENTAL_ID), { offer: SAVED, source: 'recorded', conflict: null })
  assert.deepEqual(await readPlayOffer(db, T, LONDON_ID), { offer: null, source: 'conflict', conflict: { stated: CRM, recorded: SAVED } })
  // another tenant: no such play
  assert.equal(await readPlayOffer(db, OTHER, DENTAL_ID), null)
  assert.equal(await readPlayOffer(db, OTHER, LONDON_ID), null)
  assert.equal(await snapshot(), before, 'reads write nothing')
  // the London choice changes that play only
  assert.equal(await setPlayOffer(db, T, LONDON_ID, CRM, 1_800_000_000), true)
  assert.deepEqual(await readPlayOffer(db, T, LONDON_ID), { offer: CRM, source: 'play', conflict: null })
  assert.deepEqual(await readPlayOffer(db, T, DENTAL_ID), { offer: SAVED, source: 'recorded', conflict: null })
  assert.deepEqual(await db.get('SELECT offer, offer_set_at FROM scan_jobs WHERE id = ?', [DENTAL_ID]), { offer: null, offer_set_at: null })
  assert.deepEqual(await db.get('SELECT sells, website FROM users WHERE id = ?', [T]), { sells: SAVED, website: '' })
  // the other tenant cannot choose for it
  assert.equal(await setPlayOffer(db, OTHER, DENTAL_ID, CRM, 1_800_000_000), false)
  assert.deepEqual(await db.get('SELECT offer FROM scan_jobs WHERE id = ?', [DENTAL_ID]), { offer: null })
})

// The drafting callers on the exact records (SQLite, as the outreach service is): the dental play drafts and rewrites
// with the dental offer, follow-ups and scoring state it; the London play is refused everywhere until chosen.
test('#349 live records: drafting, rewrite, follow-ups and scoring use the dental offer; London refuses until chosen', async () => {
  const master = randomBytes(32)
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateKeys(db); migratePlans(db); migrateMemory(db)
  db.exec('CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, sells TEXT, website TEXT)')
  db.prepare('INSERT INTO users VALUES (?, ?, ?)').run(T, SAVED, '')
  saveKey(db, T, 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  saveSettings(db, T, { sender_name: 'G', postal_address: '1 King St W, Toronto ON, Canada', booking_url: null })
  const recent = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)
  // each lead's quote satisfies its own request's evidence gates (the London request asks for seed funding plus a sales
  // hire), so the only refusal left to reach is the offer one
  const QUOTES = { [DENTAL_ID]: 'Synthetic Buyer opened a new location and is hiring a receptionist', [LONDON_ID]: 'Synthetic Buyer raised a seed round and is hiring its first sales representative' }
  for (const [id, query] of [[DENTAL_ID, DENTAL_REQUEST], [LONDON_ID, LONDON_REQUEST]] as const) {
    db.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status,query,seller,offer,offer_set_at) VALUES(?, ?,'Dental Seller','i','l','running',?,?,NULL,NULL)").run(id, T, query, SAVED)
    db.prepare("INSERT INTO leads(id,scan_job_id,name,company,contact,signal,source_url,evidence_excerpt,confidence,human_confirmed_at,human_confirmed_from,event_date) VALUES(?,?,'Pat','Synthetic Buyer','sales@buyer.invalid',?,'https://buyer.invalid/news',?,70,1800000000,'test_review',?)").run(`lead-${id}`, id, QUOTES[id], QUOTES[id], recent)
    db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(id)
    // the London request needs the sales-hiring proof: a durable recorded pass, as the scan gate writes it
    if (id === LONDON_ID) db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES ('g-london', ?, ?, 'scan:gate', 'gate_passed', 'quote', 'https://buyer.invalid/news', ?, 1800000000)").run(`lead-${id}`, T, recent)
  }
  const prompts: string[] = []
  const providers = { anthropic: { completeDetailed: async (_k: string, prompt: string) => { prompts.push(prompt); return { text: 'x', model: 'm' } } } } as unknown as Record<string, Provider>
  const body = (id: string) => (db.prepare('SELECT body FROM outreach_messages WHERE id = ?').get(id) as { body: string }).body
  try {
    const d = createDraft(db, T, `lead-${DENTAL_ID}`, 'Acme')
    assert.match(body(d), /appointment booking and reminder software/)
    // the stub answers "x", which is unusable as a rewrite: what matters is that the rewrite ran (one provider call) with the dental offer and was not refused for the offer
    const pol = await polishDraft(db, T, d, "Acme", { master, providers }) as { rewritten: boolean; reason?: string }
    assert.ok(pol.rewritten || (pol.reason !== "offer_conflict" && pol.reason !== "no_profile"), JSON.stringify(pol))
    assert.equal(prompts.length, 1); assert.match(prompts[0], /appointment booking and reminder software/); assert.doesNotMatch(prompts[0], /CRM/)
    assert.match(memoryForLead(db, T, `lead-${DENTAL_ID}`)!.positioning, /appointment booking/)
    assert.match(offerBlockFor(db, T, DENTAL_ID), /appointment booking/)
    assert.throws(() => createDraft(db, T, `lead-${LONDON_ID}`, 'Acme'), /offer_conflict/)
    assert.equal(memoryForLead(db, T, `lead-${LONDON_ID}`)?.positioning ?? '', '')
    assert.equal(offerBlockFor(db, T, LONDON_ID), '')
    assert.equal(prompts.length, 1, 'no provider call for the contested play')
    assert.deepEqual(db.prepare('SELECT offer, offer_set_at FROM scan_jobs WHERE id = ?').get(DENTAL_ID), { offer: null, offer_set_at: null })
    assert.deepEqual(db.prepare('SELECT sells FROM users WHERE id = ?').get(T), { sells: SAVED })
  } finally { db.close() }
})

// Council round 1 (seats 1 and 2): sentences the widened grammars must still treat as material, each one checked
// against the saved dental offer with the offer sentence restated. All were material on the previous resolver.
const COUNCIL_STILL_A_CHOICE = [
  'Provide phone support.', 'Provide customer support.', 'Provide an account manager.', 'Provide a named account manager for each practice.',
  'Provide 1 sales rep per location.', 'Provide quotes for each practice.',
  'Include customer portals.', 'Include directory listings.', 'Include marketplace listings and job boards.', 'Find customer portals.', 'Customer portals.',
  'Customers also receive a new app.', 'Practices also receive a website.', 'Customers have received a new platform.',
  'Customers also receive a new account manager.', 'Customers recently signed a new partnership.', 'Practices launched a website.',
]
test('#349 council: service, product and claim sentences stay material next to the restated offer', () => {
  const failures: string[] = []
  for (const s of COUNCIL_STILL_A_CHOICE) {
    const q = `We sell ${P}. ${s}`
    if (resolve(q).source !== 'conflict' || sameOffer(q, SAVED)) failures.push(s)
  }
  assert.deepEqual(failures, [])
  // the excluding verbs still skip these nouns, and a negated targeting verb counts as excluding
  for (const s of ['Exclude directories and job boards.', 'Skip marketplaces.', 'Do not target franchises or competitors.', 'Never contact aggregators.'])
    assert.equal(resolve(`${s} We sell ${P}.`).source, 'recorded', s)
})

// Council seat 1: the withdrawal gate keeps the narrow tail. A commercial-term withdrawal whose tail the new
// qualifiers could read (a size, a window, an event) is still a choice, as before this change.
test('#349 council: the withdrawal gate is not loosened by the qualifier grammars', () => {
  for (const q of ['We no longer offer free onboarding with 1-5 seats.', 'We no longer offer refunds in the last 90 days.', 'We do not offer phone support recently.',
    'We no longer offer support that launched a new product.', 'Find dental practices in NYC. We no longer offer refunds in the last 90 days.',
    'We no longer offer refunds to practices hiring our account manager.', 'We no longer offer refunds to London practices.', 'We no longer offer support to New York practices.'])
    assert.equal(resolve(q).source, 'conflict', q)
  // and the unrelated term exclusions that resolved before still resolve
  for (const q of ['Find dental practices in NYC hiring. We do not offer free trials.', "Independent dental practices in New York City hiring a front-desk coordinator. We don't provide on-site training.", 'We do not offer refunds to restaurants.'])
    assert.equal(resolve(q).source, 'recorded', q)
})
