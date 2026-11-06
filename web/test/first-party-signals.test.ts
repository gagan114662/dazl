// #390 first-party demand signals (lib/signals/first-party.ts): consent-gated, tenant-scoped, deduped, never deanonymising.
// Synthetic events only; no network. Runs on SQLite and (in CI) Postgres.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { bothEngines } from './helpers/engines.ts'
import type { Db } from '../lib/db/client.ts'
import {
  classifyEvent, configStatus, eraseFirstParty, ingest, parseConfigInput, purgeFirstPartyRetention, readConfig, recordConfig,
  setCollection, signBody, verifyRequest, IDENTITY_CONFIDENCE, type FpConfig, type FpConfigInput,
} from '../lib/signals/first-party.ts'
import { fpTypeLabel } from '../lib/signals/first-party-labels.ts'
import { connectorStatus } from '../lib/connectors/store.ts'
import Database from 'better-sqlite3'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { confirmLeadReview } from '../lib/scan/review-confirm.ts'
import { createDraft, draftBlockReason, OutreachError } from '../lib/outreach/service.ts'
import { contactSearchNote, publishedEmail } from '../lib/outreach/published-email.ts'
import { approveState, leadCardSummary } from '../lib/scan/lead-card.ts'
import type { CardLead } from '../lib/scan/opportunity.ts'
import { companySearchEligible } from '../lib/scan/find-contact-eligible.ts'

process.env.DAZL_MASTER_KEY ??= randomBytes(32).toString('base64')
const NOW = 1_793_000_000 // 2026-10-26
const CFG: FpConfigInput = { site_domain: 'seller.test', basis: 'consent', privacy_url: 'https://seller.test/privacy', retention_days: 90 }
const iso = (s: number) => new Date(s * 1000).toISOString()
const form = (id: string, email: string, extra: Record<string, unknown> = {}) => ({ id, type: 'demo_request', occurred_at: iso(NOW - 3600), page_url: 'https://seller.test/demo?utm=x&email=jane%40acme.io#f', consent: 'granted', person: { email, name: 'Jane Doe', company: 'Acme' }, ...extra })
const visit = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'site_visit', occurred_at: iso(NOW - 600), page_url: 'https://www.seller.test/pricing', consent: 'granted', network: 'business', account: { domain: 'acme.io', basis: 'logged_in_account' }, ...extra })
const body = (...events: unknown[]) => JSON.stringify({ events })
const run = (db: Db, tenant: string, ...events: unknown[]) => { const raw = body(...events); return ingest(db, tenant, raw, signBody('s', NOW, raw), NOW) }
const fpLeads = (db: Db, tenant: string) => db.all<{ id: string; name: string; company: string; contact: string | null; company_domain: string | null; event_date: string; date_status: string; review_reason: string; source_kind: string; source_url: string; signal: string; dedup_key: string }>(
  "SELECT l.id, l.name, l.company, l.contact, l.company_domain, l.event_date, l.date_status, l.review_reason, l.source_kind, l.source_url, l.signal, l.dedup_key FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ? AND l.source_kind = 'first_party' ORDER BY l.name, l.company", [tenant])
const fpEvents = (db: Db, tenant: string) => db.all<{ lead_id: string; value: string; label: string; confidence: number; source_url: string; source_date: string }>(
  "SELECT lead_id, value, label, confidence, source_url, source_date FROM lead_enrichments WHERE tenant_id = ? AND connector = 'first_party' ORDER BY source_date, value", [tenant])

test('config input: own https privacy notice, consent basis only, bounded retention', () => {
  assert.deepEqual(parseConfigInput({ ...CFG, site_domain: 'WWW.Seller.test' }), CFG)
  assert.ok('error' in parseConfigInput({ ...CFG, basis: 'legitimate_interest' }))
  assert.ok('error' in parseConfigInput({ ...CFG, privacy_url: 'https://elsewhere.test/privacy' }))
  assert.ok('error' in parseConfigInput({ ...CFG, privacy_url: 'http://seller.test/privacy' }))
  assert.ok('error' in parseConfigInput({ ...CFG, retention_days: 5000 }))
  assert.ok('error' in parseConfigInput({ ...CFG, site_domain: '10.0.0.1' }))
})

test('signature: timestamp + body HMAC, replay window', () => {
  const raw = body(visit('e1'))
  assert.equal(verifyRequest('sec', String(NOW), signBody('sec', NOW, raw), raw, NOW), 'ok')
  assert.equal(verifyRequest('sec', String(NOW), signBody('other', NOW, raw), raw, NOW), 'bad_signature')
  assert.equal(verifyRequest('sec', String(NOW), signBody('sec', NOW, raw), raw + ' ', NOW), 'bad_signature')
  assert.equal(verifyRequest('sec', String(NOW + 1), signBody('sec', NOW, raw), raw, NOW), 'bad_signature') // timestamp is signed
  assert.equal(verifyRequest('sec', String(NOW - 301), signBody('sec', NOW - 301, raw), raw, NOW), 'stale')
  assert.equal(verifyRequest('sec', null, signBody('sec', NOW, raw), raw, NOW), 'bad_signature')
})

test('identity: residential/VPN, third-party resolution and consumer domains stay unknown; a visit never carries a person', () => {
  const cfg: FpConfig = { v: 1, secret: 's', ...CFG, recorded_at: NOW, recorded_by: 'u', policy: 'fp-v1' }
  const out = (e: unknown) => classifyEvent(e, cfg, 'A', NOW).outcome
  for (const network of ['residential', 'vpn', 'mobile', 'proxy', 'tor']) assert.equal(out(visit('v', { network })), 'unknown', network)
  assert.equal(out(visit('v', { account: { domain: 'acme.io', basis: 'reverse_ip' } })), 'unknown')
  assert.equal(out(visit('v', { account: { domain: 'acme.io', basis: 'clearbit' } })), 'unknown')
  assert.equal(out(visit('v', { account: undefined })), 'unknown')
  assert.equal(out(visit('v', { account: { domain: 'gmail.com', basis: 'logged_in_account' } })), 'unknown')
  assert.equal(out(visit('v', { person: { email: 'jane@acme.io' } })), 'rejected:person_on_account_event')
  assert.equal(out(visit('v', { name: 'Jane' })), 'rejected:person_on_account_event')
  assert.equal(out(visit('v', { account: { domain: 'seller.test', basis: 'logged_in_account' } })), 'rejected:internal')
  assert.equal(out(visit('v', { page_url: 'https://evil.test/pricing' })), 'rejected:off_domain')
  assert.equal(out(visit('v', { page_url: 'https://seller.test.evil.test/' })), 'rejected:off_domain')
  assert.equal(out(visit('v', { occurred_at: iso(NOW + 3600) })), 'rejected:bad_time')
  assert.equal(out(visit('v', { occurred_at: iso(NOW - 91 * 86400) })), 'rejected:bad_time') // older than the recorded retention
  // consent: only an explicit grant, and an opt-out signal beats it
  assert.equal(out(visit('v', { consent: undefined })), 'not_consented')
  assert.equal(out(visit('v', { consent: 'denied' })), 'not_consented')
  assert.equal(out(visit('v', { gpc: true })), 'not_consented')
  assert.equal(out(form('f', 'jane@acme.io', { opt_out: true })), 'not_consented')
  assert.equal(out(form('f', 'jane@seller.test')), 'rejected:internal')
  assert.equal(out(form('f', 'not-an-email')), 'rejected:no_submitter_email')
  assert.equal(out(form('f', 'jane@gmail.com', { person: { email: 'jane@gmail.com' } })), 'unknown') // no name, no company, consumer mail
  const free = classifyEvent(form('f', 'jane@gmail.com'), cfg, 'A', NOW).event!
  assert.equal(free.companyDomain, null) // a consumer mailbox says nothing about a company
  assert.equal(free.company, 'Acme') // self-reported, kept as such
  assert.equal(fpTypeLabel('demo_request:abc'), 'Demo request')
})

bothEngines('a consented form event becomes one tenant-scoped, deduped lead with source, time and identity confidence; no email stored', async ({ db }) => {
  assert.equal((await run(db, 'A', form('e1', 'Jane@Acme.io'))).status, 'not_configured') // nothing recorded: nothing collected
  await recordConfig(db, 'A', CFG, 'actor-a', NOW)
  const r1 = await run(db, 'A', form('e1', 'Jane@Acme.io'))
  assert.equal(r1.status, 'ok')
  assert.deepEqual(r1.results.map(r => r.outcome), ['created'])
  const replay = await run(db, 'A', form('e1', 'jane@acme.io'), form('e2', 'jane@acme.io', { type: 'form_submission', occurred_at: iso(NOW - 60) }))
  assert.deepEqual(replay.results.map(r => r.outcome), ['duplicate', 'attached'])
  const leads = await fpLeads(db, 'A')
  assert.equal(leads.length, 1)
  const [l] = leads
  assert.equal(l.name, 'Jane Doe'); assert.equal(l.company, 'Acme'); assert.equal(l.company_domain, 'acme.io')
  assert.equal(l.contact, null) // a form address is not a published address
  assert.equal(l.source_kind, 'first_party'); assert.equal(l.review_reason, 'first_party_signal'); assert.equal(l.date_status, 'unverified')
  assert.equal(l.event_date, '2026-10-26'); assert.equal(l.source_url, 'https://seller.test/demo') // query and fragment stripped
  assert.match(l.dedup_key, /^fp:p:[a-f0-9]{40}$/)
  const ev = await fpEvents(db, 'A')
  assert.equal(ev.length, 2)
  assert.ok(ev.every(e => e.lead_id === l.id && Number(e.confidence) === IDENTITY_CONFIDENCE.self_submitted && e.source_date === '2026-10-26' && /^self_submitted; consent basis consent \(fp-v1\); receipt [a-f0-9]{16}$/.test(e.label)))
  // the address never lands anywhere in the tenant's rows
  const dump = JSON.stringify([await db.all('SELECT * FROM leads'), await db.all('SELECT * FROM lead_enrichments'), await db.all('SELECT * FROM connector_audit')])
  assert.ok(!/jane@acme/i.test(dump))
  // another tenant: its own config, its own leads; the same event id is a new event there, and A's rows are untouched
  await recordConfig(db, 'B', { ...CFG, site_domain: 'other.test', privacy_url: 'https://other.test/p' }, 'actor-b', NOW)
  const b = await run(db, 'B', form('e1', 'jane@acme.io', { page_url: 'https://other.test/demo' }))
  assert.deepEqual(b.results.map(r => r.outcome), ['created'])
  assert.equal((await fpLeads(db, 'A')).length, 1); assert.equal((await fpEvents(db, 'A')).length, 2)
  assert.notEqual((await fpLeads(db, 'B'))[0].dedup_key, l.dedup_key) // hashes are per tenant
  assert.deepEqual((await configStatus(db, 'A')).stored, { leads: 1, events: 2 })
  assert.equal((await connectorStatus(db, 'A')).length, 0) // the config is not a connector key
})

bothEngines('account-level visit: a company lead with no person, never merged into a named person at that company', async ({ db }) => {
  await recordConfig(db, 'A', CFG, 'actor-a', NOW)
  const r = await run(db, 'A', form('f1', 'jane@acme.io'), visit('v1'), visit('v2', { type: 'product_event', label: 'Invited 3 teammates' }),
    visit('v3', { network: 'vpn' }), visit('v4', { network: 'residential' }), visit('v5', { account: { domain: 'beta.io', basis: 'reverse_ip' } }))
  assert.deepEqual(r.results.map(x => x.outcome), ['created', 'created', 'attached', 'unknown', 'unknown', 'unknown'])
  const leads = await fpLeads(db, 'A')
  assert.equal(leads.length, 2)
  const acct = leads.find(l => l.dedup_key === 'fp:a:acme.io')!
  assert.equal(acct.name, ''); assert.equal(acct.company, 'acme.io'); assert.equal(acct.contact, null)
  assert.match(acct.signal, /not identified: this does not say any named person at acme\.io visited/)
  const ev = await fpEvents(db, 'A')
  assert.equal(ev.filter(e => e.lead_id === acct.id).length, 2)
  assert.ok(ev.filter(e => e.lead_id === acct.id).every(e => Number(e.confidence) === IDENTITY_CONFIDENCE.logged_in_account))
  assert.equal(ev.length, 3) // unknown traffic is counted in the response, never stored
  assert.equal((await db.all("SELECT 1 FROM leads WHERE company LIKE '%beta%'")).length, 0)
})

bothEngines('opt-out disables collection; withdrawn consent erases the subject; retention and erase delete', async ({ db }) => {
  await recordConfig(db, 'A', CFG, 'actor-a', NOW)
  assert.equal(await setCollection(db, 'A', false), true)
  const off = await run(db, 'A', form('e1', 'jane@acme.io'), visit('v1'))
  assert.equal(off.status, 'off')
  assert.equal((await fpLeads(db, 'A')).length, 0); assert.equal((await fpEvents(db, 'A')).length, 0)
  assert.equal((await readConfig(db, 'A'))!.enabled, false)
  assert.equal(await setCollection(db, 'A', true), true)
  await run(db, 'A', form('e1', 'jane@acme.io'), visit('v1'), form('e9', 'sam@corp.io', { person: { email: 'sam@corp.io', name: 'Sam' } }))
  assert.equal((await fpLeads(db, 'A')).length, 3)
  const w = await run(db, 'A', { id: 'w1', type: 'form_submission', consent: 'withdrawn', person: { email: 'JANE@acme.io' } })
  assert.deepEqual(w.results.map(x => x.outcome), ['withdrawn'])
  assert.deepEqual((await fpLeads(db, 'A')).map(l => l.dedup_key.slice(0, 5)).sort(), ['fp:a:', 'fp:p:']) // Jane gone, Sam and the account stay
  // retention: 91 days later every event is past the recorded 90 days; leads left without events go too, collecting or not
  await setCollection(db, 'A', false)
  assert.equal(await purgeFirstPartyRetention(db, { now: NOW + 91 * 86400 }), 2)
  assert.equal((await fpLeads(db, 'A')).length, 0)
  assert.equal((await db.all("SELECT 1 FROM scan_jobs WHERE user_id = 'A' AND industry = 'first_party'")).length, 0)
  // erase: data and config (secret) gone; the endpoint has nothing to verify against
  await setCollection(db, 'A', true)
  await run(db, 'A', visit('v7'))
  assert.equal(await eraseFirstParty(db, 'A'), 1)
  assert.equal(await readConfig(db, 'A'), null)
  assert.equal((await fpEvents(db, 'A')).length, 0)
  const audit = (await db.all<{ lookup: string; status: string }>("SELECT lookup, status FROM connector_audit WHERE tenant_id = 'A' AND connector = 'first_party'")).map(a => a.status)
  for (const s of ['recorded', 'disabled', 'enabled', 'ok', 'erased']) assert.ok(audit.includes(s), s)
})

// #390 review point 2: a CONFIRMED first-party lead still has no stored contact (the submitter's address is never kept),
// so no draft gate accepts it. The server gate names the reason (no_email_contact, the outreach route's 422 "no
// published email address"), and the card rule the Leads view and Home share (approveState via leadCardSummary) gives
// one named reason, never a silent empty state. The only way on is the existing user-requested contact search on the
// company website (companySearchEligible), after which every draft gate applies as for any confirmed lead.
test('[sqlite] a confirmed first-party lead with no contact is not draftable: one named reason on the gate, the Leads view and Home', async () => {
  const raw = new Database(':memory:')
  migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  try {
    await recordConfig(db, 'A', CFG, 'actor-a', NOW)
    const r = await run(db, 'A', form('f1', 'jane@acme.io'), visit('v1'))
    assert.deepEqual(r.results.map(x => x.outcome), ['created', 'created'])
    const ids = (await fpLeads(db, 'A')).map(l => l.id)
    assert.equal(ids.length, 2) // a named person (form) and an account-level visit
    const card = (id: string) => {
      const l = raw.prepare('SELECT * FROM leads WHERE id = ?').get(id) as CardLead & { id: string }
      return { ...l, enrichments: raw.prepare('SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ?').all(id) as NonNullable<CardLead['enrichments']> }
    }
    for (const id of ids) {
      // before confirming: held for review, and the gate says so
      assert.equal(draftBlockReason(raw, 'A', id), 'lead_not_verified')
      assert.equal(approveState(card(id)).ok, false)
      assert.equal(await confirmLeadReview(db, 'A', id, NOW), true)
      const l = card(id)
      assert.equal(l.contact, null); assert.ok(l.human_confirmed_at); assert.equal(l.review_reason, null)
      // the server gate: one named reason, and createDraft writes nothing
      assert.equal(draftBlockReason(raw, 'A', id), 'no_email_contact')
      assert.throws(() => createDraft(raw, 'A', id, 'Seller'), (e: unknown) => e instanceof OutreachError && e.code === 'no_email_contact')
      // the card rule both views render (Leads cards and Home's journey/first-run cards): the same reason, in words
      assert.equal(publishedEmail(l), null)
      const NO_EMAIL = { ok: false, reason: 'No published email address to draft to yet. See Details to look for one.' }
      assert.deepEqual(approveState(l), NO_EMAIL)
      assert.deepEqual(leadCardSummary(l).approve, NO_EMAIL)
      // the Leads view's details: a named note and the existing contact search on the company website, not an empty state
      assert.equal(companySearchEligible(l), true)
      assert.match(contactSearchNote(l) ?? '', /^No contact stored\./)
    }
    assert.equal((raw.prepare("SELECT count(*) AS n FROM outreach_messages WHERE tenant_id = 'A'").get() as { n: number }).n, 0)
    // another tenant cannot reach the lead through the gate
    assert.equal(draftBlockReason(raw, 'B', ids[0]), 'not_found')
  } finally { await db.close() }
})

bothEngines('the deployment gate never weakens retention: the tick purge still deletes expired events with the flag OFF (#390)', async ({ db }) => {
  // The OFF gate stops NEW record/enable/ingest; it must not stop privacy cleanup for an already-recorded config.
  const prev = process.env.DAZL_FIRST_PARTY_ENABLED
  delete process.env.DAZL_FIRST_PARTY_ENABLED
  try {
    const secret = await recordConfig(db, 'tenantA', { ...CFG, retention_days: 30 }, 'actor', NOW)
    const r = await ingest(db, 'tenantA', body(form('old-1', 'old@acme.io')), signBody(secret, NOW, body(form('old-1', 'old@acme.io'))), NOW)
    assert.equal(r.status, 'ok')
    assert.equal((await fpEvents(db, 'tenantA')).length, 1)
    const purged = await purgeFirstPartyRetention(db, { now: NOW + 31 * 86400 }) // past the recorded 30 days, flag OFF
    assert.equal(purged, 1)
    assert.equal((await fpEvents(db, 'tenantA')).length, 0)
    assert.equal((await fpLeads(db, 'tenantA')).length, 0)
  } finally { if (prev === undefined) delete process.env.DAZL_FIRST_PARTY_ENABLED; else process.env.DAZL_FIRST_PARTY_ENABLED = prev }
})
