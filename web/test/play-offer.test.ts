// What the tenant sells, per play (#349; lib/scan/play-offer.ts). Synthetic data only. Two plays of one tenant: a dental
// play created while the profile sold appointment software keeps that offer; a London play reviewed for CRM consulting
// keeps that one, across reloads and later profile edits, on SQLite and Postgres. A play whose request states a
// different offer than the one it recorded is a conflict until the tenant chooses, and only that play changes. Drafts
// (template and their refusal) follow the same effective offer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { pgDb, sqliteDb, type Db } from '../lib/db/client.ts'
import { createQueryJob } from '../lib/scan/store-db.ts'
import { effectiveOffer, offerOfSeller, readPlayOffer, sameOffer, setPlayOffer, statedOffer } from '../lib/scan/play-offer.ts'
import { createDraft } from '../lib/outreach/service.ts'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateMemory, saveMemory } from '../lib/memory.ts'
import { bothEngines } from './helpers/engines.ts'

const DENTAL = 'Appointment booking and reminder software for dental practices'
const CRM = 'CRM setup and outbound consulting'
const DENTAL_Q = 'Independent dental practices in New York hiring a front-desk coordinator in the past 60 days'
const LONDON_Q = `Selling ${CRM} to London B2B SaaS startups that opened a new office in the past 90 days`

test('the offer a request states, and the offer part of a recorded seller line', () => {
  assert.equal(statedOffer(LONDON_Q), CRM)
  assert.equal(statedOffer(`We sell ${CRM} to London SaaS founders`), CRM)
  assert.equal(statedOffer('I offer bookkeeping for small agencies in Leeds'), 'bookkeeping')
  assert.equal(statedOffer('Offer: fractional CFO services. Targets: Austin startups'), 'fractional CFO services')
  assert.equal(statedOffer(DENTAL_Q), null, 'plain targeting states no offer')
  assert.equal(statedOffer(''), null)
  assert.equal(offerOfSeller(`${DENTAL} - https://seller.example`), DENTAL)
  assert.equal(offerOfSeller(`${DENTAL} - seller.example`), DENTAL)
  assert.equal(offerOfSeller(DENTAL), DENTAL)
  assert.equal(offerOfSeller('Pipeline - and more - work'), 'Pipeline - and more - work', 'a dash inside the offer is kept')
  assert.equal(offerOfSeller(null), null)
  assert.ok(sameOffer('CRM setup and outbound consulting', '  crm Setup  and outbound CONSULTING '), 'case and spacing only')
  assert.ok(!sameOffer('CRM setup and outbound consulting', 'outbound consulting and CRM setup'), 'word order is a difference')
  assert.ok(!sameOffer('SEO but not PPC', 'PPC but not SEO'), 'where a negation applies is a difference')
  assert.ok(!sameOffer('CRM setup and outbound consulting', 'CRM setup and outbound consulting.'), 'punctuation is not normalized')
  assert.ok(!sameOffer('CRM setup and outbound consulting', 'outbound consulting and CRM setup for startups'), 'a buyer qualifier is a difference')
  assert.ok(!sameOffer(CRM, 'CRM setup but no outbound consulting'), 'a withdrawn service is a difference')
  assert.ok(!sameOffer('appointment software for dental practices', 'appointment software for veterinary practices'))
  assert.ok(!sameOffer('appointment software', 'appointment software for dental practices'), 'containment is not sameness')
  assert.ok(!sameOffer(CRM, DENTAL))
})

test('effective offer: reviewed > recorded > profile; a stated offer that differs is a conflict, never a guess', () => {
  assert.deepEqual(effectiveOffer({ offer: CRM, seller: DENTAL, query: LONDON_Q }, DENTAL), { offer: CRM, source: 'play', conflict: null })
  assert.deepEqual(effectiveOffer({ offer: null, seller: `${DENTAL} - https://s.example`, query: DENTAL_Q }, CRM), { offer: DENTAL, source: 'recorded', conflict: null }, 'an old play keeps its recorded offer when the profile changes')
  assert.deepEqual(effectiveOffer({ offer: null, seller: null, query: DENTAL_Q }, DENTAL), { offer: DENTAL, source: 'profile', conflict: null })
  assert.deepEqual(effectiveOffer({ offer: null, seller: DENTAL, query: LONDON_Q }, DENTAL), { offer: null, source: 'conflict', conflict: { stated: CRM, recorded: DENTAL } })
  assert.deepEqual(effectiveOffer({ offer: null, seller: CRM, query: LONDON_Q }, DENTAL), { offer: CRM, source: 'recorded', conflict: null }, 'stated and recorded agree')
  assert.deepEqual(effectiveOffer({ offer: null, seller: null, query: LONDON_Q }, ''), { offer: CRM, source: 'request', conflict: null })
  assert.deepEqual(effectiveOffer({ offer: null, seller: null, query: DENTAL_Q }, ''), { offer: null, source: 'none', conflict: null })
})

const tenant = async (db: Db, id: string, sells: string) =>
  db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt, sells) VALUES (?, ?, 'n', 'Acme', 'x', 'y', ?)", [id, `${id}@example.test`, sells])
const columns = (db: Db, id: string) => db.get('SELECT offer, offer_set_at, seller, query FROM scan_jobs WHERE id = ?', [id])

bothEngines('two plays keep their own offers across reloads and later profile edits; resolving one play changes only it', async ({ db, kind, url, schema }) => {
  const A = 'a'.repeat(32), B = 'b'.repeat(32)
  await tenant(db, A, DENTAL); await tenant(db, B, 'Bookkeeping for agencies')
  // the dental play: created while the profile sold dental software (its seller snapshot), no stated offer
  const dental = await createQueryJob(db, A, { query: DENTAL_Q, icp: null, seller: `${DENTAL} - https://seller.example` })
  // the London play, reviewed for CRM consulting before it ran
  const london = await createQueryJob(db, A, { query: LONDON_Q, icp: null, seller: `${DENTAL} - https://seller.example`, offer: CRM })
  // a London play created before review existed: dental snapshot, CRM stated in its request -> conflict
  const legacy = await createQueryJob(db, A, { query: LONDON_Q, icp: null, seller: `${DENTAL} - https://seller.example` })
  // reload through a second handle (another instance on Postgres)
  const other = kind === 'pg' ? pgDb({ connectionString: url!, searchPath: schema, max: 1 }) : db
  try {
    for (const d of [db, other]) {
      assert.deepEqual(await readPlayOffer(d, A, dental), { offer: DENTAL, source: 'recorded', conflict: null })
      assert.deepEqual(await readPlayOffer(d, A, london), { offer: CRM, source: 'play', conflict: null })
      assert.deepEqual(await readPlayOffer(d, A, legacy), { offer: null, source: 'conflict', conflict: { stated: CRM, recorded: DENTAL } })
    }
    // the profile changes later: no play's offer moves with it
    await db.run('UPDATE users SET sells = ? WHERE id = ?', ['Something else entirely', A])
    assert.equal((await readPlayOffer(other, A, dental))!.offer, DENTAL)
    assert.equal((await readPlayOffer(other, A, london))!.offer, CRM)
    // resolving the legacy play sets only that play; the dental play's row is byte-unchanged
    const before = JSON.stringify(await columns(db, dental))
    assert.equal(await setPlayOffer(other, A, legacy, `  ${CRM}  `), true)
    assert.deepEqual(await readPlayOffer(db, A, legacy), { offer: CRM, source: 'play', conflict: null })
    assert.equal(JSON.stringify(await columns(db, dental)), before)
    // another tenant can neither read nor set A's play offer
    assert.equal(await readPlayOffer(db, B, london), null)
    assert.equal(await setPlayOffer(db, B, dental, 'Bookkeeping for agencies'), false)
    assert.equal(JSON.stringify(await columns(db, dental)), before)
    assert.equal(await setPlayOffer(db, A, dental, 'x'), false, 'too short: refused')
  } finally { if (other !== db) await other.close() }
})

// Drafts: the template draft says what the lead's own play sells; a contested play gets no draft until it is resolved.
function draftDb() {
  const raw = new Database(':memory:')
  migrateScan(raw); migrateOutreach(raw); migrateConnectors(raw); migrateMemory(raw)
  raw.exec('CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, sells TEXT, website TEXT)')
  raw.prepare('INSERT INTO users VALUES(?,?,?)').run('A', DENTAL, 'https://seller.example')
  const play = (id: string, query: string, offer: string | null) => {
    raw.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status,query,seller,offer) VALUES(?, 'A','Request','test','test','running',?,?,?)").run(id, query, `${DENTAL} - https://seller.example`, offer)
    raw.prepare("INSERT INTO leads(id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence) VALUES(?,?,'Buyer','sales@buyer.invalid','Buyer is hiring an SDR','https://buyer.invalid/careers','Buyer is hiring an SDR',70)").run(`lead-${id}`, id)
  }
  play('dental', DENTAL_Q, null); play('london', LONDON_Q, CRM); play('legacy', LONDON_Q, null)
  // reviewed, and dated inside the requests' windows ("in the past 60/90 days"): the timing gate is satisfied, not bypassed
  const recent = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10)
  raw.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review', event_date=?").run(recent)
  return raw
}
const body = (raw: Database.Database, id: string) => (raw.prepare('SELECT body FROM outreach_messages WHERE id=?').get(id) as { body: string }).body

test('drafts follow their play: dental stays dental, London says CRM consulting, a contested play is refused until chosen', async () => {
  const raw = draftDb()
  try {
    const d = createDraft(raw, 'A', 'lead-dental', 'Acme')
    assert.match(body(raw, d), new RegExp(`About Acme: ${DENTAL}`))
    const l = createDraft(raw, 'A', 'lead-london', 'Acme')
    assert.match(body(raw, l), new RegExp(`About Acme: ${CRM}`))
    assert.doesNotMatch(body(raw, l), /dental/i)
    assert.throws(() => createDraft(raw, 'A', 'lead-legacy', 'Acme'), /offer_conflict/)
    assert.equal((raw.prepare("SELECT count(*) n FROM outreach_messages WHERE lead_id = 'lead-legacy'").get() as { n: number }).n, 0, 'nothing drafted')
    await setPlayOffer(sqliteDb(raw), 'A', 'legacy', CRM)
    assert.match(body(raw, createDraft(raw, 'A', 'lead-legacy', 'Acme')), new RegExp(`About Acme: ${CRM}`))
    // the dental draft already written is never rewritten
    assert.match(body(raw, d), new RegExp(DENTAL))
  } finally { raw.close() }
})

test('a play with a recorded offer wins over the tenant-wide Memory positioning; a play without one keeps Memory', () => {
  const raw = draftDb()
  try {
    saveMemory(raw, 'A', { positioning: 'Tenant-wide positioning text' })
    assert.match(body(raw, createDraft(raw, 'A', 'lead-dental', 'Acme')), new RegExp(DENTAL))
    raw.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status) VALUES('old','A','Request','test','test','running')").run()
    raw.prepare("INSERT INTO leads(id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,human_confirmed_at,human_confirmed_from) VALUES('lead-old','old','Buyer','sales@buyer.invalid','Buyer is hiring an SDR','https://buyer.invalid/careers','Buyer is hiring an SDR',70,1800000000,'test_review')").run()
    assert.match(body(raw, createDraft(raw, 'A', 'lead-old', 'Acme')), /Tenant-wide positioning text/)
  } finally { raw.close() }
})
