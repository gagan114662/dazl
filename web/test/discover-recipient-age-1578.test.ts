// Review of #1578 at 33005234, two holes found with valid positives:
//  1. the card showed one published address and the server drafted to another (the card took the first row it was handed, the server
//     the earliest stored). One rule now picks it for the card, the card's recipient hold and the draft: lib/discover/card.ts
//     discoverRecipient.
//  2. a draft made while its signal was fresh still passed the approve and send checks after the signal was years old: the shared
//     currentness gate asked only whether a discovery lead has a date.
// Real store, real SQL projection (enrichmentsForLeads), real card, real createDraft / approve / send checks. No network, nothing sent.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { addEnrichment, enrichmentsForLeads } from '../lib/connectors/store.ts'
import { discoverContact, discoverRecipient, SIGNAL_MAX_AGE_DAYS } from '../lib/discover/card.ts'
import { approveBlockReason, createDraft, discoverRecipientRefusal, OutreachError, sendBlockReason, sendMessage, suppress } from '../lib/outreach/service.ts'
import { currentnessHeld } from '../lib/outreach/currentness.ts'
import { leadCardSummary } from '../lib/scan/lead-card.ts'

const SITE = 'https://northwind-dental.example/contact'
function fixture(o: { date?: string | null; kind?: string } = {}) {
  process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const id = 'b'.repeat(24)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller) VALUES ('j1', 'T', 'b', 'i', 'l', 'running', 'Dental clinics opening a new location', 'Clinic fit-out contractor')").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, evidence_excerpt, event_date, date_status, confidence, fit, intent, why, source_kind, company_domain) VALUES (?, 'j1', 'Dana Ruiz', 'Northwind Dental', 'Opening a second clinic', 'https://news.example/northwind', 85, 'Northwind Dental will open its second clinic', ?, 'verified', 85, 4, 4, 'expanding', ?, 'northwind-dental.example')").run(id, o.date === undefined ? '2026-10-14' : o.date, o.kind ?? 'discover')
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'j1'").run()
  return { db, id }
}
const email = (db: Database.Database, id: string, value: string, at: number, o: { tenant?: string; source?: string } = {}) =>
  addEnrichment(db, o.tenant ?? 'T', id, { connector: 'discover', kind: 'email', value, label: 'published on a public page', confidence: null, source_url: o.source ?? SITE, source_date: '2026-11-22', retrieved_at: at })
// what the Leads page has for this lead: the stored row, the real enrichment projection, the server's recipient verdict
const row = (db: Database.Database, id: string) => ({ ...(db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as object), enrichments: enrichmentsForLeads(db, 'T', [id])[id] ?? [], recipient_refused: discoverRecipientRefusal(db, 'T', id) })
const shown = (db: Database.Database, id: string) => discoverContact(row(db, id) as never)?.email?.address ?? null
const approve = (db: Database.Database, id: string) => { const a = leadCardSummary(row(db, id) as never).approve; return a.ok ? 'ok' : a.reason }
const draft = (db: Database.Database, id: string, tenant = 'T') => { try { return { to: (db.prepare('SELECT to_email FROM outreach_messages WHERE id = ?').get(createDraft(db, tenant, id, 'Fit-out Co', { manual: true })) as { to_email: string }).to_email } } catch (e) { if (e instanceof OutreachError) return { code: e.code }; throw e } }
const drafts = (db: Database.Database) => (db.prepare('SELECT COUNT(*) AS n FROM outreach_messages').get() as { n: number }).n
const NOW = Date.parse('2026-11-22T12:00:00Z')

test('#1578 the address the card shows is the address the draft is written to, whatever order the rows were stored or read in', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  for (const order of [['alice', 'bob'], ['bob', 'alice']]) {
    const { db, id } = fixture()
    // stored in this order; bob is the earlier published record either way
    for (const who of order) email(db, id, `${who}@northwind-dental.example`, who === 'bob' ? 1 : 99)
    assert.equal(shown(db, id), 'bob@northwind-dental.example', `stored ${order.join(' then ')}`)
    assert.equal(approve(db, id), 'ok', 'a valid two-address lead is approvable')
    assert.deepEqual(draft(db, id), { to: 'bob@northwind-dental.example' })
  }
  // the same instant: the address first in order, for the card and the draft alike
  const tie = fixture()
  email(tie.db, tie.id, 'bob@northwind-dental.example', 5); email(tie.db, tie.id, 'alice@northwind-dental.example', 5)
  assert.equal(shown(tie.db, tie.id), 'alice@northwind-dental.example')
  assert.deepEqual(draft(tie.db, tie.id), { to: 'alice@northwind-dental.example' })
})

test('#1578 a row that is not an address, or names no page, is not a published address: card and draft agree on the one that is', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const { db, id } = fixture()
  email(db, id, 'not-an-address', 1)
  // the store itself refuses a row that names no page, so an unsourced address cannot reach a card or a draft from it
  assert.throws(() => email(db, id, 'carol@northwind-dental.example', 2, { source: '' }), /CHECK constraint failed/)
  email(db, id, 'dana@northwind-dental.example', 3)
  assert.equal(shown(db, id), 'dana@northwind-dental.example')
  assert.equal(approve(db, id), 'ok')
  assert.deepEqual(draft(db, id), { to: 'dana@northwind-dental.example' })
  // only rows that are not published addresses: nothing to show, nothing to draft to
  const none = fixture()
  email(none.db, none.id, 'not-an-address', 1); email(none.db, none.id, 'also not one', 2)
  assert.equal(shown(none.db, none.id), null)
  assert.match(approve(none.db, none.id), /No email address is published/)
  assert.deepEqual(draft(none.db, none.id), { code: 'no_email_contact' })
  // the rule itself, on rows however they arrive: no page, or not the run's own row, is never the published address
  const r = (o: Record<string, unknown>) => ({ connector: 'discover', kind: 'email', value: 'x@northwind-dental.example', source_url: SITE, retrieved_at: 0, ...o })
  assert.equal(discoverRecipient([r({ connector: 'apollo' })] as never), null, 'only the run\'s own rows')
  assert.equal(discoverRecipient([r({ source_url: '' }), r({ source_url: null })] as never), null, 'an address with no page that prints it')
  assert.deepEqual(discoverRecipient([r({ source_url: null }), r({ value: 'Dana@Northwind-Dental.example ', retrieved_at: 9 })] as never), { address: 'dana@northwind-dental.example', source: SITE })
})

test('#1578 the chosen address is never passed over to escape its hold: suppressed or personal, the lead is held and nothing is drafted', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  // the earlier address is on the do-not-contact list; a later, clean one exists
  const s = fixture()
  email(s.db, s.id, 'bob@northwind-dental.example', 1); email(s.db, s.id, 'alice@northwind-dental.example', 2)
  suppress(s.db, 'T', 'bob@northwind-dental.example', 'manual')
  assert.equal(shown(s.db, s.id), 'bob@northwind-dental.example', 'the card still shows the chosen address')
  assert.equal(discoverRecipientRefusal(s.db, 'T', s.id), 'suppressed')
  assert.match(approve(s.db, s.id), /do-not-contact/)
  assert.deepEqual(draft(s.db, s.id), { code: 'suppressed' })
  assert.equal(drafts(s.db), 0, 'no draft to the other address')
  // the earlier address is a free-webmail mailbox the site prints; a later company address exists
  const p = fixture()
  email(p.db, p.id, 'northwinddental@gmail.com', 1); email(p.db, p.id, 'alice@northwind-dental.example', 2)
  assert.equal(shown(p.db, p.id), 'northwinddental@gmail.com')
  assert.equal(discoverRecipientRefusal(p.db, 'T', p.id), 'personal_email')
  assert.match(approve(p.db, p.id), /personal mailbox/)
  assert.deepEqual(draft(p.db, p.id), { code: 'personal_email' })
  assert.equal(drafts(p.db), 0)
  // control: the clean address is the earlier one; the suppressed later one changes nothing
  const c = fixture()
  email(c.db, c.id, 'alice@northwind-dental.example', 1); email(c.db, c.id, 'bob@northwind-dental.example', 2)
  suppress(c.db, 'T', 'bob@northwind-dental.example', 'manual')
  assert.equal(approve(c.db, c.id), 'ok')
  assert.deepEqual(draft(c.db, c.id), { to: 'alice@northwind-dental.example' })
})

test('#1578 another workspace\'s rows and do-not-contact list never choose or hold this workspace\'s recipient', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const { db, id } = fixture()
  email(db, id, 'zed@northwind-dental.example', 0, { tenant: 'OTHER' })   // earlier, but not this workspace's record
  email(db, id, 'dana@northwind-dental.example', 5)
  suppress(db, 'OTHER', 'dana@northwind-dental.example', 'manual')
  assert.equal(shown(db, id), 'dana@northwind-dental.example')
  assert.equal(discoverRecipientRefusal(db, 'T', id), null)
  assert.deepEqual(draft(db, id), { to: 'dana@northwind-dental.example' })
  assert.deepEqual(draft(db, id, 'OTHER'), { code: 'not_found' }, 'the other workspace cannot draft to this lead')
})

test('#1578 a draft made while the signal was fresh is held at approve and at send once the signal is more than a year old; nothing is sent', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const { db, id } = fixture()   // signal dated 2026-10-14
  email(db, id, 'dana@northwind-dental.example', 1)
  const mid = createDraft(db, 'T', id, 'Fit-out Co', { manual: true })
  assert.equal(approveBlockReason(db, 'T', mid, { skipAccount: true }), null, 'a fresh draft passes the approve check')
  assert.equal(currentnessHeld(db, 'T', id), false)
  // inside the year: still passes
  t.mock.timers.setTime(Date.parse('2026-10-14T00:00:00Z') + (SIGNAL_MAX_AGE_DAYS - 1) * 86_400_000)
  assert.equal(approveBlockReason(db, 'T', mid, { skipAccount: true }), null, 'a day inside the year')
  // only the clock moves: the same draft, the same lead
  t.mock.timers.setTime(Date.parse('2028-11-22T12:00:00Z'))
  assert.equal(currentnessHeld(db, 'T', id), true)
  assert.equal(approveBlockReason(db, 'T', mid, { skipAccount: true }), 'lead_currentness_unconfirmed')
  assert.equal(leadCardSummary(row(db, id) as never).approve.ok, false, 'the card says the same')
  assert.deepEqual(draft(db, id), { code: 'lead_currentness_unconfirmed' }, 'and no new draft is made')
  // a message approved while fresh is not sent once stale: refused before it is claimed, left exactly as it was
  db.prepare("UPDATE outreach_messages SET status = 'approved' WHERE id = ?").run(mid)
  assert.equal(sendBlockReason(db, 'T', mid, { skipAccount: true }), 'lead_currentness_unconfirmed')
  await assert.rejects(sendMessage(db, 'T', mid, { fetch: (async () => { throw new Error('nothing may be sent') }) as unknown as typeof fetch } as never), { code: 'lead_currentness_unconfirmed' })
  assert.deepEqual(db.prepare('SELECT status, attempts, claimed_at, sent_at FROM outreach_messages WHERE id = ?').get(mid), { status: 'approved', attempts: 0, claimed_at: null, sent_at: null })
  // back inside the year the age hold is gone again: it is the signal's age and nothing else. (This message was marked approved by
  // hand, so the next check, the approval hash, still refuses it; it is never sendable in this test.)
  t.mock.timers.setTime(NOW)
  assert.equal(currentnessHeld(db, 'T', id), false)
  assert.equal(sendBlockReason(db, 'T', mid, { skipAccount: true }), 'changed_since_approval')
})

test('#1578 the age rule is the discovery lane\'s only: an undated discovery lead is still held, and a lead of the older engine reads as it did at any age', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const undated = fixture({ date: null })
  assert.equal(currentnessHeld(undated.db, 'T', undated.id), true)
  // the older engine: the same old date, and its own rules (timing proof, window, review) decide, at both clocks
  const old = fixture({ date: '2022-05-11', kind: 'news' })
  const before = currentnessHeld(old.db, 'T', old.id)
  old.db.prepare('UPDATE leads SET human_confirmed_at = 1700000000 WHERE id = ?').run(old.id)
  assert.equal(currentnessHeld(old.db, 'T', old.id), false, 'a lead the user confirmed, with no window asked for, is not held by age')
  t.mock.timers.setTime(Date.parse('2028-11-22T12:00:00Z'))
  assert.equal(currentnessHeld(old.db, 'T', old.id), false)
  assert.equal(typeof before, 'boolean')
})
