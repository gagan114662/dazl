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
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { addEnrichment, enrichmentsForLeads } from '../lib/connectors/store.ts'
import { discoverContact, discoverLine, discoverRecipient, discoverSources, SIGNAL_MAX_AGE_DAYS } from '../lib/discover/card.ts'
import { approve as approveMessage, approveBlockReason, createDraft, discoverRecipientRefusal, OutreachError, saveSettings, sendBlockReason, sendMessage, suppress, TEST_INBOX } from '../lib/outreach/service.ts'
import { completeOAuth, startOAuth } from '../lib/gmail/oauth.ts'
import { historyCampaigns, listCampaignsNow } from '../lib/outreach/campaigns.ts'
import { campaignDetail } from '../lib/outreach/campaign-detail.ts'
import { leadStatus } from '../lib/outreach/campaign-view.ts'
import { publishedContact, publishedEmail } from '../lib/outreach/published-email.ts'
import { domainReviewFor } from '../lib/outreach/domain-review.ts'
import { findContactForConfirmedLead } from '../lib/scan/find-contact.ts'
import { confirmLeadReview } from '../lib/scan/review-confirm.ts'
import { setDomainReview } from '../lib/scan/domain-review-action.ts'
import { sqliteDb } from '../lib/db/client.ts'
import type { Get } from '../lib/connectors/sitecrawl.ts'
import { currentnessHeld, discoverSignalHeld } from '../lib/outreach/currentness.ts'
import { CRAWLED_NOTE_TAIL, detailsContact, leadCardSummary } from '../lib/scan/lead-card.ts'
import { campaignStatus } from '../lib/run-status.ts'
import { readyItems } from '../lib/ready-card.ts'

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

test('#1571 (review of #1578) the address the card shows is the address the draft is written to, whatever order the rows were stored or read in', t => {
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

test('#1571 (review of #1578) a row that is not an address, or names no page, is not a published address: card and draft agree on the one that is', t => {
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

test('#1571 (review of #1578) the chosen address is never passed over to escape its hold: suppressed or personal, the lead is held and nothing is drafted', t => {
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

test('#1571 (review of #1578) another workspace\'s rows and do-not-contact list never choose or hold this workspace\'s recipient', t => {
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

const env = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: 'https://app.test' }
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (e: string) => 'x.' + Buffer.from(JSON.stringify({ email: e, email_verified: true })).toString('base64url') + '.y'
const tokenOk = (async (url: string) => (String(url).includes('token') ? json({ access_token: 'at-1' }) : json({}, 404))) as unknown as typeof fetch
const DAY = 86_400_000, SIGNAL = Date.parse('2026-10-14T00:00:00Z'), YEAR = SIGNAL_MAX_AGE_DAYS * DAY

// Review of cc3c3c87: the earlier form of this test marked a row approved by hand (no approval hash, so it could never be sent) and
// passed its send stub under a key the send path does not read. This one approves for real, wires the provider hand-off, and shows the
// same message going out while fresh.
test('#1571 (review of #1578) a genuinely approved, sendable message is refused at approve and at send once its signal is more than a year old; inside the year it is sent', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const { db, id } = fixture()   // signal dated 2026-10-14
  email(db, id, 'dana@northwind-dental.example', 1)
  const master = Buffer.from(process.env.DAZL_MASTER_KEY!, 'base64')
  const mid = createDraft(db, 'T', id, 'Fit-out Co', { manual: true })
  // a real sender and a connected mailbox, so nothing but the lead's own state can refuse this message
  saveSettings(db, 'T', { sender_name: 'Pat Smith', postal_address: '1 King St W, Toronto ON M5H 1A1, Canada' } as never)
  const state = new URL(startOAuth(db, 'T', { env, now: Math.floor(NOW / 1000) })).searchParams.get('state')!
  await completeOAuth(db, 'T', 'code', state, { env, master, now: Math.floor(NOW / 1000), fetchImpl: (async () => json({ refresh_token: 'rt-secret-123', scope: 'openid email https://www.googleapis.com/auth/gmail.send', id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  const handed: string[] = []   // every message handed to the mail provider
  const deps = (ms: number) => ({ env, master, now: Math.floor(ms / 1000), baseUrl: 'https://app.test', fetchImpl: tokenOk, sendFn: async (_token: string, raw: string) => { handed.push(raw); return { id: 'gm1' } } }) as never
  const stored = () => db.prepare('SELECT status, attempts, claimed_at, sent_at, (approved_hash IS NOT NULL) AS hashed FROM outreach_messages WHERE id = ?').get(mid)
  const STALE = SIGNAL + YEAR + 1   // one millisecond past the year

  // approve: refused while stale and the draft stays a draft; accepted while fresh
  t.mock.timers.setTime(STALE)
  assert.throws(() => approveMessage(db, 'T', mid), { code: 'lead_currentness_unconfirmed' })
  assert.deepEqual(stored(), { status: 'draft', attempts: 0, claimed_at: null, sent_at: null, hashed: 0 })
  t.mock.timers.setTime(NOW)
  approveMessage(db, 'T', mid)
  assert.deepEqual(stored(), { status: 'approved', attempts: 0, claimed_at: null, sent_at: null, hashed: 1 })
  // positive control: with every account check included, nothing refuses this message while its signal is fresh. It IS sendable.
  assert.equal(sendBlockReason(db, 'T', mid, { now: Math.floor(NOW / 1000) }), null)

  // only the clock moves. The same approved message is refused for its age before it is claimed; nothing reaches the provider.
  t.mock.timers.setTime(STALE)
  assert.equal(sendBlockReason(db, 'T', mid, { now: Math.floor(STALE / 1000) }), 'lead_currentness_unconfirmed')
  await assert.rejects(sendMessage(db, 'T', mid, deps(STALE)), { code: 'lead_currentness_unconfirmed' })
  assert.equal(handed.length, 0, 'nothing was handed to the mail provider')
  assert.deepEqual(stored(), { status: 'approved', attempts: 0, claimed_at: null, sent_at: null, hashed: 1 })
  assert.equal(leadCardSummary(row(db, id) as never).approve.ok, false, 'the card says the same')
  assert.deepEqual(draft(db, id), { code: 'lead_currentness_unconfirmed' }, 'and no new draft is made')

  // back inside the year the very same message goes out, once: the hold was the signal's age and nothing else
  t.mock.timers.setTime(NOW)
  assert.equal(await sendMessage(db, 'T', mid, deps(NOW)), 'sent')
  assert.equal(handed.length, 1, 'handed to the provider exactly once')
  assert.equal((stored() as { status: string }).status, 'sent')
})

test('#1571 (review of #1578) the limit is one year exactly: 365 days old is in, one millisecond more is out, for the card, the approve check and a new draft alike', t => {
  assert.equal(SIGNAL_MAX_AGE_DAYS, 365)
  t.mock.timers.enable({ apis: ['Date'], now: SIGNAL + YEAR })   // exactly 365 days after the signal's day
  const { db, id } = fixture(); email(db, id, 'dana@northwind-dental.example', 1)
  assert.equal(currentnessHeld(db, 'T', id), false, 'exactly a year old: in')
  assert.equal(approve(db, id), 'ok')
  const mid = createDraft(db, 'T', id, 'Fit-out Co', { manual: true })
  assert.equal(approveBlockReason(db, 'T', mid, { skipAccount: true }), null)
  t.mock.timers.setTime(SIGNAL + YEAR + 1)
  assert.equal(currentnessHeld(db, 'T', id), true, 'one millisecond past a year: out')
  assert.match(approve(db, id), /more than a year old/)
  assert.equal(approveBlockReason(db, 'T', mid, { skipAccount: true }), 'lead_currentness_unconfirmed')
  const next = fixture(); email(next.db, next.id, 'dana@northwind-dental.example', 1)
  assert.deepEqual(draft(next.db, next.id), { code: 'lead_currentness_unconfirmed' })
  // and well inside it
  t.mock.timers.setTime(SIGNAL + YEAR - DAY)
  assert.equal(currentnessHeld(db, 'T', id), false)
})

test('#1571 (review of #1578) the age rule is the discovery lane\'s only: an undated discovery lead is still held, and a lead of the older engine reads as it did at any age', t => {
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

// Review of cc3c3c87, the readers the first change missed.
test('#1571 (review of #1578) an address a crawl stored on a discovery lead is never the line beside Approve: the card shows the address the draft goes to', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const crawled = (db: Database.Database, id: string, value: string) => addEnrichment(db, 'T', id, { connector: 'sitecrawl', kind: 'email', value, label: null, confidence: null, source_url: SITE, source_date: '2026-11-22', retrieved_at: 1 })
  // the run's own published address, and an address a later crawl (Find contact) stored on the same lead
  const { db, id } = fixture()
  email(db, id, 'bob@northwind-dental.example', 5); crawled(db, id, 'alice@northwind-dental.example')
  const card = leadCardSummary(row(db, id) as never)
  assert.match(card.contact ?? '', /bob@northwind-dental\.example/)
  assert.doesNotMatch(card.contact ?? '', /alice@/)
  assert.equal(card.contactNoPerson, 'bob@northwind-dental.example')
  assert.deepEqual(card.approve, { ok: true })
  assert.deepEqual(draft(db, id), { to: 'bob@northwind-dental.example' })
  // only the crawled address, also copied into the lead's own contact field: nothing to draft to, so no address on the line
  const c = fixture()
  crawled(c.db, c.id, 'alice@northwind-dental.example'); c.db.prepare("UPDATE leads SET contact = 'alice@northwind-dental.example' WHERE id = ?").run(c.id)
  const only = leadCardSummary(row(c.db, c.id) as never)
  assert.doesNotMatch(only.contact ?? '', /@/)
  assert.equal(only.contactNoPerson, null)
  assert.match(approve(c.db, c.id), /No email address is published/)
  assert.deepEqual(draft(c.db, c.id), { code: 'no_email_contact' })
  // a lead of the older engine keeps its own contact on the line, as before
  const old = fixture({ kind: 'news' })
  old.db.prepare("UPDATE leads SET contact = '+1 416 555 0100' WHERE id = ?").run(old.id)
  assert.equal(leadCardSummary(row(old.db, old.id) as never).contactNoPerson, '+1 416 555 0100')
})

test('#1571 (review of #1578) the Sources link for Email is the page of the chosen address, and a nearly-valid first address is not passed over', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const TEAM = 'https://northwind-dental.example/team'
  const { db, id } = fixture()
  email(db, id, 'alice@northwind-dental.example', 99, { source: TEAM }); email(db, id, 'bob@northwind-dental.example', 1)
  const r = row(db, id)
  assert.deepEqual(discoverContact(r as never)?.email, { address: 'bob@northwind-dental.example', source: SITE })
  assert.equal(discoverSources(r as never).find(s => s.field === 'email')?.url, SITE, 'the page that prints the address shown, not the first row\'s page')
  // an earlier row the server reads as an address and the card does not, on the do-not-contact list, with a clean address after it:
  // the lead is held; neither the card nor the draft moves on to the clean one
  const m = fixture()
  email(m.db, m.id, 'bob@-northwind-dental.example', 1); email(m.db, m.id, 'alice@northwind-dental.example', 2)
  suppress(m.db, 'T', 'bob@-northwind-dental.example', 'manual')
  assert.equal(shown(m.db, m.id), null, 'no address is shown rather than the next one')
  assert.equal(discoverSources(row(m.db, m.id) as never).some(s => s.field === 'email'), false)
  assert.notEqual(approve(m.db, m.id), 'ok')
  assert.ok('code' in draft(m.db, m.id), 'the server refuses it')
  assert.equal(drafts(m.db), 0, 'nothing is drafted to the other address')
})

test('#1571 (review of #1578) Campaigns offers no source review for a discovery lead held by its signal\'s date, and counts it exactly as Leads history and the campaign page do', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  type Q = { sourceChecked: number; research: number; held: number; heldResearch: number; heldDateOnly?: number }
  for (const [label, date, ms] of [['stale', '2026-10-14', SIGNAL + YEAR + DAY], ['undated', null, NOW], ['fresh', '2026-10-14', NOW]] as [string, string | null, number][]) {
    const { db, id } = fixture({ date }); email(db, id, 'dana@northwind-dental.example', 1)
    db.prepare("UPDATE scan_jobs SET candidates = 1, dropped = 0 WHERE id = 'j1'").run()
    t.mock.timers.setTime(ms)
    const card = (await listCampaignsNow(db, 'T', 10, new Date(ms)))[0] as unknown as { qualification: Q; next: { label: string } }
    const hist = (await historyCampaigns(db, sqliteDb(db), 'T', ['j1'], new Date(ms)))[0] as unknown as { qualification: Q }
    const page = await campaignDetail(sqliteDb(db), 'T', 'j1')
    assert.ok(hist && page, `${label}: the history card and the campaign page read this search`)
    const held = label !== 'fresh'
    assert.equal(currentnessHeld(db, 'T', id), held, label)
    assert.deepEqual([card.qualification.held, card.qualification.heldResearch, card.qualification.heldDateOnly ?? 0], held ? [1, 0, 1] : [0, 0, 0], label)
    assert.equal('heldDateOnly' in card.qualification, held, `${label}: the field is there only when a lead is held this way`)
    assert.doesNotMatch(card.next.label, /Review the source/, `${label}: no review is offered that cannot release the lead`)
    // the three surfaces say the same thing about this lead: source-checked, not research
    assert.deepEqual([card.qualification.sourceChecked, card.qualification.research], [1, 0], label)
    assert.deepEqual([hist.qualification.sourceChecked, hist.qualification.research], [card.qualification.sourceChecked, card.qualification.research], `${label}: Campaigns card and Leads history card`)
    assert.equal(leadStatus(page.leads[0] as never, page.messages as never).text, 'Source-checked, not drafted', `${label}: campaign page`)
    // Third review (3fa0629d): Home's checklist reads the same counts (as /api/campaigns returns them) and still asked for that review.
    const api = campaignStatus(card as never, db.prepare("SELECT * FROM scan_jobs WHERE id = 'j1'").get() as never) as unknown as { qualification: Q; next: { label: string } }
    assert.equal(api.qualification.heldDateOnly ?? 0, held ? 1 : 0, `${label}: the count reaches the page`)
    assert.doesNotMatch(api.next.label, /Review the source|your review/, label)
    const home = readyItems({ profile: { sells: 'fit-outs', website: 'https://fitout.example', business_name: 'Fit-out Co', buyer: { summary: 'clinics', who: ['owner'] } }, usage: null, outreach: null,
      jobs: [{ id: 'j1', status: 'done', error: null, query: 'Dental clinics opening a new location', csv_domain: null, created_at: 1, lead_count: 1 }], totals: { searches: 1, finished: 1 }, messages: [], campaigns: [api] } as never).find(x => x.id === 'qualified')!
    if (held) assert.deepEqual([home.state, home.detail, home.fix?.label], ['todo', "1 lead in this search is held by its signal's date (none, or more than a year old) - no review changes a date. Search again for a newer signal", 'Change the search'], `${label}: Home`)
    else assert.deepEqual([home.state, home.detail], ['done', '1 source-checked or confirmed by you'], `${label}: Home`)
    // the helper reads only this workspace's leads
    assert.equal(discoverSignalHeld(db, 'T', id, new Date(ms)), held, label)
    assert.equal(discoverSignalHeld(db, 'OTHER', id, new Date(ms)), false, `${label}: another workspace`)
  }
  // a lead of the older engine with the same old date is never a "date only" hold
  const old = fixture({ date: '2022-05-11', kind: 'news' })
  assert.equal(discoverSignalHeld(old.db, 'T', old.id), false)
})

test('#1571 (review of #1578) a stored signal date that does not read as a day is no date: held by the gate, the card and a new draft', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  for (const d of ['2026-13-45', 'soon', '20261014']) {
    const { db, id } = fixture({ date: d }); email(db, id, 'dana@northwind-dental.example', 1)
    assert.equal(currentnessHeld(db, 'T', id), true, d)
    assert.match(approve(db, id), /no date/, d)
    assert.deepEqual(draft(db, id), { code: 'lead_currentness_unconfirmed' }, d)
  }
})

// Second review (a59c6b38): the card line was right, but Details and the card's route and status lines still read the older engine's
// address on the same lead. The state below is reached with the product's own steps: the lead is in review, the user confirms it, runs
// "Find contact" (canned pages, no network), then checks the website.
const html = (b: string) => `<html><body>${b}</body></html>`
const PAGES: Record<string, string> = {
  'news.example/northwind': html('Northwind Dental will open its second clinic. <a href="https://northwind-dental.example">Northwind Dental</a>'),
  'news.example/robots.txt': '', 'northwind-dental.example/robots.txt': '',
  'northwind-dental.example/': html('Northwind Dental home <a href="/contact-us">Contact us</a>'),
  'northwind-dental.example/contact-us': html('Northwind Dental. Email: hello@northwind-dental.example'),
}
const cannedGet: Get = async url => { const u = new URL(url); const p = PAGES[`${u.hostname.replace(/^www\./, '')}${u.pathname}`]; return p === undefined ? { status: 404, body: '', finalUrl: url } : { status: 200, body: p, finalUrl: url } }
// A lead taken through those steps. own: the address its own run published (null: none). checked: the user also made the website check.
async function crawled(o: { own?: string | null; checked?: boolean; kind?: string } = {}) {
  const { db, id } = fixture({ kind: o.kind })
  if (o.own !== null && o.kind === undefined) email(db, id, o.own ?? 'bob@northwind-dental.example', Math.floor(NOW / 1000) - 3600)
  db.prepare("UPDATE scan_jobs SET attempts = 1, candidates = 1, dropped = 0 WHERE id = 'j1'").run()
  db.prepare("UPDATE leads SET review_reason = 'source_review_required' WHERE id = ?").run(id)
  assert.equal(await confirmLeadReview(sqliteDb(db), 'T', id, Math.floor(NOW / 1000)), true)
  const found = await findContactForConfirmedLead(db, 'T', id, { get: cannedGet, gapMs: 0, env: {} }) as { status: string; contacts: number }
  assert.deepEqual([found.status, found.contacts], ['done', 1], 'the crawl stored one address')
  const before = row(db, id)
  const rv = domainReviewFor(before as never, before.enrichments as never)
  assert.equal(rv.state, 'required', 'a crawled website waits for the user\'s check')
  if (o.checked) setDomainReview(db, 'T', id, 'confirm', rv.binding ?? undefined, NOW)
  return { db, id }
}
const CRAWLED_NOTE = `A website crawl found hello@northwind-dental.example. ${CRAWLED_NOTE_TAIL}`

test('#1571 (review of #1578) after a real "Find contact" on a discovery lead, nothing beside its draft action names the crawled address: Details, route and status follow the published one', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const { db, id } = await crawled({ checked: true })
  const r = row(db, id)
  const older = publishedContact(r as never)
  assert.equal(older?.email, 'hello@northwind-dental.example', 'the state is the reviewed one: the older projection now reads the crawled address')
  // the card
  const card = leadCardSummary(r as never)
  assert.match(card.contact ?? '', /bob@northwind-dental\.example/)
  assert.deepEqual(card.approve, { ok: true })
  assert.equal(card.route, null, 'no route lines about another address beside Approve')
  assert.doesNotMatch(card.contactStatus?.text ?? '', /hello@|shared company inbox|Restricted inbox/)
  // Details
  assert.deepEqual(detailsContact(r as never), { contact: null, draftTo: null, alsoCrawled: 'hello@northwind-dental.example', crawledNote: CRAWLED_NOTE }, 'no second contact and no second draft button; the crawled address is said as what it is')
  // and the draft a person asks for goes where the card says
  assert.deepEqual(draft(db, id), { to: 'bob@northwind-dental.example' })

  // Third review (3fa0629d): the sentence said "Drafts for this lead go only to the address its own proof run published". That was false
  // for a draft nobody asked for. The sentence now claims only Approve, and says the rest. Its last clause and the behaviour it describes
  // are held together here. This does NOT approve that behaviour: it is the open question P2-a (one recipient rule for automatic drafts
  // too), awaiting the coordinating reviewer. Whoever changes that rule changes the sentence in the same commit, or this fails.
  assert.match(CRAWLED_NOTE_TAIL, /^Approve on this card never drafts to it, only to an address this lead's own proof run published\. A draft made automatically \(autopilot\) may still use it\.$/)
  const auto = await crawled({ checked: true })
  const nobodyAsked = auto.db.prepare('SELECT to_email FROM outreach_messages WHERE id = ?').get(createDraft(auto.db, 'T', auto.id, 'Fit-out Co')) as { to_email: string }
  assert.equal(nobodyAsked.to_email, 'hello@northwind-dental.example', 'OPEN (P2-a): a draft made without a person asking still uses the crawled address, as the sentence says')

  // the crawl stored the very address Approve drafts to: there is no second address, so nothing is said about one
  const same = await crawled({ checked: true, own: 'hello@northwind-dental.example' })
  assert.deepEqual(detailsContact(row(same.db, same.id) as never), { contact: null, draftTo: null, alsoCrawled: 'hello@northwind-dental.example', crawledNote: null })
  assert.deepEqual(draft(same.db, same.id), { to: 'hello@northwind-dental.example' })
  // the lead's own run published no address: the crawled one is still not what Approve uses (Approve is off), and the sentence does not say "also"
  const none = await crawled({ checked: true, own: null })
  assert.equal(detailsContact(row(none.db, none.id) as never).crawledNote, CRAWLED_NOTE)
  assert.notEqual(approve(none.db, none.id), 'ok')
  assert.deepEqual(draft(none.db, none.id), { code: 'no_email_contact' })

  // a crawled restricted inbox on a discovery lead whose published address is fine: the card does not call its contact restricted
  const p = fixture(); email(p.db, p.id, 'bob@northwind-dental.example', 5)
  addEnrichment(p.db, 'T', p.id, { connector: 'sitecrawl', kind: 'email', value: 'privacy@northwind-dental.example', label: null, confidence: null, source_url: SITE, source_date: '2026-11-22', retrieved_at: 1 })
  const pr = row(p.db, p.id), pcard = leadCardSummary(pr as never)
  assert.doesNotMatch(pcard.contactStatus?.text ?? '', /Restricted inbox/)
  assert.deepEqual([pcard.approve, detailsContact(pr as never).draftTo, detailsContact(pr as never).alsoCrawled], [{ ok: true }, null, 'privacy@northwind-dental.example'])

  // a lead of the older engine: Details is the older projection exactly, as before
  const o = fixture({ kind: 'news' })
  addEnrichment(o.db, 'T', o.id, { connector: 'sitecrawl', kind: 'email', value: 'alice@northwind-dental.example', label: null, confidence: null, source_url: SITE, source_date: '2026-11-22', retrieved_at: 1 })
  const or = row(o.db, o.id)
  assert.deepEqual(detailsContact(or as never), { contact: publishedContact(or as never), draftTo: publishedEmail(or as never), alsoCrawled: null, crawledNote: null })
  assert.equal(detailsContact(or as never).contact?.email, 'alice@northwind-dental.example')
})

// Third review (3fa0629d): the page's side of that was pinned by one declaration line; a page that printed the crawled address again, hid
// the website check, or dropped the sentence passed every test. The contact part of Details is now a component, and this renders it
// (react-dom/server, in its own process because .tsx needs a loader) from the rows the product's own steps leave behind.
function renderDetails(rows: Record<string, unknown>): Record<string, string> {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tsx-loader.mjs', './test/helpers/details-contact-render.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000, input: JSON.stringify(rows) })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const line = r.stdout.split('\n').find(x => x.startsWith('DETAILS-CONTACT-MARKUP '))
  assert.ok(line, r.stdout + r.stderr)
  return JSON.parse(line.slice('DETAILS-CONTACT-MARKUP '.length)) as Record<string, string>
}
const words = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
const withoutNote = (h: string) => h.replace(/<span[^>]*data-testid="also-crawled"[^>]*>[^<]*<\/span>/, '')

test('#1571 (review of #1578) the Details a person reads, rendered from real rows: a discovery lead gets no crawled contact line and no second draft button, and keeps the website check', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  // what the lead list hands the page for a lead: its row and whether the shared gate holds it now
  const view = (x: { db: Database.Database; id: string }) => ({ ...row(x.db, x.id), currentness_held: currentnessHeld(x.db, 'T', x.id) })
  const rows: Record<string, unknown> = {
    unchecked: view(await crawled()),
    checked: view(await crawled({ checked: true })),
    same: view(await crawled({ checked: true, own: 'hello@northwind-dental.example' })),
    none: view(await crawled({ checked: true, own: null })),
    older: view(await crawled({ checked: true, kind: 'news' })),
    olderUnchecked: view(await crawled({ kind: 'news' })),
  }
  const stale = await crawled({ checked: true })
  t.mock.timers.setTime(SIGNAL + YEAR + DAY)
  rows.stale = view(stale)
  assert.equal((rows.stale as { currentness_held: boolean }).currentness_held, true)
  const out = renderDetails(rows)

  for (const k of ['unchecked', 'checked', 'none', 'stale']) {
    assert.match(out[k], /data-testid="also-crawled"/, k)
    assert.ok(words(out[k]).includes(CRAWLED_NOTE), `${k}: the sentence, whole`)
    assert.doesNotMatch(withoutNote(out[k]), /hello@/, `${k}: the crawled address is nowhere else: not a contact line`)
  }
  for (const k of ['unchecked', 'checked', 'none', 'stale', 'same']) {
    assert.doesNotMatch(out[k], /Draft email|I reviewed the source/, `${k}: no second draft button and no review that cannot release the lead`)
    assert.doesNotMatch(out[k], /Look for a published contact/, `${k}: a crawl already ran`)
  }
  assert.doesNotMatch(out.same, /also-crawled|hello@/, 'one address: nothing to tell apart')
  // the website check for the crawled site is still offered, and can still be withdrawn: the server holds a draft on it
  assert.match(out.unchecked, /A draft needs your check first\. <button[^>]*>This website is the right company<\/button>/)
  assert.match(words(out.checked), /You checked that northwind-dental\.example is the right company\. withdraw/)
  assert.match(words(out.stale), /You checked that northwind-dental\.example is the right company\. withdraw/)

  // a lead of the older engine, same steps: its contact line and its own draft button, as before; never the new sentence
  assert.match(words(out.older), /hello@northwind-dental\.example - /)
  assert.match(out.older, /<button[^>]*>Draft email<\/button>/)
  assert.match(words(out.olderUnchecked), /hello@northwind-dental\.example - /)
  assert.match(out.olderUnchecked, /This website is the right company/)
  assert.doesNotMatch(out.olderUnchecked, /Draft email/, 'held by the website check, as before')
  assert.doesNotMatch(out.older + out.olderUnchecked, /also-crawled|A website crawl found/)

  // the Leads page renders that component for every lead and keeps no contact logic of its own
  const page = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  assert.ok(page.includes('<DetailsContact l={l} reviewMsg={reviewMsg[l.id]} contactMsg={contactMsg[l.id]} drafted={drafted[l.id]} onDomainReview={domainReview} onFindContact={findContact} onConfirmReview={confirmReview} onApprove={id => void approveLead(id)} />'))
  for (const own of ['publishedContact(', 'publishedEmail(', 'detailsContact(', 'domainReviewFor(', 'pickCrawledEmail(']) assert.equal(page.includes(own), false, `the page has no ${own}...) of its own`)
})

test('#1571 (review of #1578) only a real calendar day is a date; the card\'s "Missing" line and Approve agree on it', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  for (const d of ['2026', '2026-10', '2026-02-30', 'soon']) {
    const { db, id } = fixture({ date: d }); email(db, id, 'dana@northwind-dental.example', 1)
    assert.equal(currentnessHeld(db, 'T', id), true, d)
    assert.match(approve(db, id), /no date/, d)
    assert.match(discoverLine(row(db, id) as never), /Missing: .*a date for the signal/, `${d}: the card does not say a dated signal was found`)
  }
  // a stored day with a time after it is still that day
  const timed = fixture({ date: '2026-10-14 09:00' }); email(timed.db, timed.id, 'dana@northwind-dental.example', 1)
  assert.equal(currentnessHeld(timed.db, 'T', timed.id), false)
  assert.equal(approve(timed.db, timed.id), 'ok')
})

// Third review (3fa0629d), notes: three protections no test held.
test('#1571 (review of #1578) "held only by its date" counts a lead once and only while it is held; the gate reads the clock it is handed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const ms = SIGNAL + YEAR + DAY
  t.mock.timers.setTime(ms)
  const q = async (db: Database.Database) => (await listCampaignsNow(db, 'T', 10, new Date(ms)))[0].qualification as unknown as Record<string, number>
  const stale = () => { const f = fixture(); email(f.db, f.id, 'dana@northwind-dental.example', 1); f.db.prepare("UPDATE scan_jobs SET candidates = 1, dropped = 0 WHERE id = 'j1'").run(); return f }
  // already research for another cause (confirmed out of a hold no review lifts): counted there, not a second time as date-only
  const a = stale(); a.db.prepare("UPDATE leads SET human_confirmed_at = 1700000000, human_confirmed_from = 'job_closed' WHERE id = ?").run(a.id)
  const qa = await q(a.db)
  assert.deepEqual([qa.held, qa.heldResearch, 'heldDateOnly' in qa], [1, 1, false])
  // unverified: not among the held at all, so not date-only either
  const b = stale(); b.db.prepare('UPDATE leads SET confidence = NULL WHERE id = ?').run(b.id)
  const qb = await q(b.db)
  assert.deepEqual([qb.held, qb.unverified, 'heldDateOnly' in qb], [0, 1, false])
  // control: the plain stale lead is the one counted
  const c = stale(), qc = await q(c.db)
  assert.deepEqual([qc.held, qc.heldResearch, qc.heldDateOnly], [1, 0, 1])

  // a caller that hands the gate a time gets the verdict for that time, whatever the process clock says
  t.mock.timers.setTime(NOW)
  assert.deepEqual([currentnessHeld(c.db, 'T', c.id), currentnessHeld(c.db, 'T', c.id, new Date(ms)), discoverSignalHeld(c.db, 'T', c.id, new Date(ms))], [false, true, true])
  t.mock.timers.setTime(ms)
  assert.deepEqual([currentnessHeld(c.db, 'T', c.id), currentnessHeld(c.db, 'T', c.id, new Date(NOW)), discoverSignalHeld(c.db, 'T', c.id, new Date(NOW))], [true, false, false])
})

test('#1571 (review of #1578) the test-fixture exemption is kept: a test message to the approved test inbox on the designated test workspace is not held by its lead\'s age at approve; any other message is', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const saved = process.env.OUTREACH_TEST_TENANT_ID
  try {
    process.env.OUTREACH_TEST_TENANT_ID = 'T'
    const { db, id } = fixture(); email(db, id, TEST_INBOX, 1)
    db.prepare("INSERT INTO sequence_settings (tenant_id, test_addresses) VALUES ('T', ?)").run(JSON.stringify([TEST_INBOX]))
    const mid = createDraft(db, 'T', id, 'Fit-out Co', { manual: true })
    assert.equal((db.prepare('SELECT test FROM outreach_messages WHERE id = ?').get(mid) as { test: number }).test, 1, 'a fixture message')
    assert.equal(approveBlockReason(db, 'T', mid, { skipAccount: true }), null)
    t.mock.timers.setTime(SIGNAL + YEAR + DAY)
    assert.equal(currentnessHeld(db, 'T', id), true, 'the lead itself is past the year')
    assert.equal(approveBlockReason(db, 'T', mid, { skipAccount: true }), null, 'the fixture exemption still applies')
    // controls: the same message without the designation, and an ordinary message on the designated workspace
    delete process.env.OUTREACH_TEST_TENANT_ID
    assert.equal(approveBlockReason(db, 'T', mid, { skipAccount: true }), 'lead_currentness_unconfirmed')
    process.env.OUTREACH_TEST_TENANT_ID = 'T'
    db.prepare('UPDATE outreach_messages SET test = 0 WHERE id = ?').run(mid)
    assert.equal(approveBlockReason(db, 'T', mid, { skipAccount: true }), 'lead_currentness_unconfirmed')
  } finally { if (saved === undefined) delete process.env.OUTREACH_TEST_TENANT_ID; else process.env.OUTREACH_TEST_TENANT_ID = saved }
})
