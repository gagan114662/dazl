// lib/growth/lifecycle.ts (issue #404): dazl's own funnel signup -> first real lead -> repeat -> paid -> retained, per
// tenant and per first-party source, on SYNTHETIC tenants only. Payments go through the real Stripe webhook handler
// (applyStripeEvent) with Stripe-shaped events, so the funnel is computed from what the product records, not from
// rows the test writes into the event table. No network, no scan, no spend.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { sqliteDb, type Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { applyStripeEvent, type StripeEvent } from '../lib/billing/stripe.ts'
import { createPasswordUser } from '../lib/auth-db.ts'
import { funnelReport, normaliseSource, tenantFunnels, DEFINITIONS, RETAIN_MATURE_S, type TenantFunnel } from '../lib/growth/lifecycle.ts'

const DAY = 86400
const NOW = 1_800_000_000 // fixed "today" for the report
const T0 = NOW - 120 * DAY

function store() { const raw = new Database(':memory:'); migrateAllSqlite(raw); return { raw, db: sqliteDb(raw) } }
let seq = 0
async function tenant(db: Db, raw: Database.Database, id: string, opts: { email?: string; source?: string | null; at?: number } = {}) {
  assert.equal(await createPasswordUser({ id, email: opts.email ?? `${id}@dazl-customers.io`, name: 'N', business_name: 'B', password_hash: 'h', salt: 's', source: opts.source ?? null }, db), 'created')
  raw.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(opts.at ?? T0, id)
}
// a scan with `real` verified leads and any number of leads a user would NOT see as verified
function scan(raw: Database.Database, tenantId: string, at: number, real: number, notReal: ('review' | 'quarantined' | 'unscored' | 'lowfit' | 'test' | 'gate' | 'nocompany')[] = [], end: 'done' | 'failed' | 'running' = 'done') {
  const job = `job${++seq}`
  raw.prepare("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location, query, created_at, finished_at) VALUES (?, ?, 'running', 'B', 'dental', 'Ohio', 'q', ?, NULL)").run(job, tenantId, at)
  const lead = (extra: Record<string, unknown>) => {
    const id = `lead${++seq}`
    const row = { id, scan_job_id: job, name: 'Pat', company: 'Acme', signal: 'hiring', source_url: 'https://acme.example/jobs', confidence: 80, created_at: at, ...extra }
    raw.prepare(`INSERT INTO leads (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row) as (string | number | null)[])
    return id
  }
  for (let i = 0; i < real; i++) lead({})
  for (const k of notReal) {
    if (k === 'review') lead({ review_reason: 'quote_unconfirmed', confidence: null })
    if (k === 'quarantined') lead({ quarantined_at: at, quarantine_reason: 'x' })
    if (k === 'unscored') lead({ confidence: null })
    if (k === 'lowfit') lead({ fit: 1 })
    if (k === 'test') lead({ source_kind: 'test' })
    if (k === 'nocompany') lead({ company: '', name: 'Someone' })
    if (k === 'gate') { const id = lead({}); raw.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES (?, ?, ?, 'scan:gate', 'gate_failed', 'x', 'https://acme.example/', '2026-01-01', ?)").run(`e${++seq}`, id, tenantId, at) }
  }
  if (end === 'done') raw.prepare("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?").run(at + 60, job)
  if (end === 'failed') raw.prepare("UPDATE scan_jobs SET status = 'failed', error = 'provider_error', finished_at = ? WHERE id = ?").run(at + 60, job)
  return job
}
const ev = (id: string, type: string, created: number, object: Record<string, unknown>): StripeEvent => ({ id, type, created, data: { object } } as StripeEvent)
async function subscribe(db: Db, tenantId: string, at: number) {
  await applyStripeEvent(db, ev(`evt_co_${tenantId}`, 'checkout.session.completed', at, { mode: 'subscription', client_reference_id: tenantId, customer: `cus_${tenantId}`, subscription: `sub_${tenantId}` }))
}
// a Stripe-shaped invoice: its subscription line carries the service period it bought (30 days unless given)
const paid = (db: Db, tenantId: string, invoice: string, at: number, cents = 4900, type = 'invoice.paid', evId = `evt_${type}_${invoice}`, period: [number, number] | null = [at, at + 30 * 86400]) =>
  applyStripeEvent(db, ev(evId, type, at, { id: invoice, customer: `cus_${tenantId}`, subscription: `sub_${tenantId}`, amount_paid: cents,
    lines: { data: period ? [{ type: 'subscription', subscription: `sub_${tenantId}`, period: { start: period[0], end: period[1] } }] : [] } }))

async function world() {
  const { raw, db } = store()
  // A: tagged "newsletter". Activated, repeat 2 days later, paid, second payment 30 days on -> retained.
  await tenant(db, raw, 'A', { source: 'Newsletter' })
  scan(raw, 'A', T0 + DAY, 2); scan(raw, 'A', T0 + 1 * DAY + 3600, 1) /* same day: not a repeat */; scan(raw, 'A', T0 + 3 * DAY, 1)
  await subscribe(db, 'A', T0 + 4 * DAY); await paid(db, 'A', 'in_A1', T0 + 4 * DAY); await paid(db, 'A', 'in_A2', T0 + 34 * DAY)
  // B: no source. Two scans, neither with a real lead (one returns nothing, one only leads held for review etc.)
  await tenant(db, raw, 'B')
  scan(raw, 'B', T0 + DAY, 0); scan(raw, 'B', T0 + 5 * DAY, 0, ['review', 'quarantined', 'unscored', 'lowfit', 'test', 'gate', 'nocompany'])
  // C: tagged "newsletter", signed up, never scanned (abandoned setup)
  await tenant(db, raw, 'C', { source: 'newsletter' })
  // D: tagged "linkedin-post". Activated; payment failed, never paid
  await tenant(db, raw, 'D', { source: 'linkedin-post' })
  scan(raw, 'D', T0 + DAY, 1)
  await subscribe(db, 'D', T0 + 2 * DAY)
  await applyStripeEvent(db, ev('evt_fail_D', 'invoice.payment_failed', T0 + 2 * DAY, { id: 'in_D1', customer: 'cus_D', subscription: 'sub_D' }))
  // E: activated, paid, then fully refunded -> not paid
  await tenant(db, raw, 'E', { source: 'linkedin-post' })
  scan(raw, 'E', T0 + DAY, 3)
  await subscribe(db, 'E', T0 + 2 * DAY); await paid(db, 'E', 'in_E1', T0 + 2 * DAY)
  await applyStripeEvent(db, ev('evt_ref_E', 'charge.refunded', T0 + 5 * DAY, { id: 'ch_E1', customer: 'cus_E', invoice: 'in_E1', amount_refunded: 4900, refunded: true }))
  // F: paid 60 days ago, partly refunded (still paid), subscription ended, no second payment -> churned (mature, not retained)
  await tenant(db, raw, 'F')
  scan(raw, 'F', T0 + DAY, 1)
  await subscribe(db, 'F', NOW - 60 * DAY); await paid(db, 'F', 'in_F1', NOW - 60 * DAY)
  await applyStripeEvent(db, ev('evt_ref_F', 'charge.refunded', NOW - 59 * DAY, { id: 'ch_F1', customer: 'cus_F', invoice: 'in_F1', amount_refunded: 1000, refunded: false }))
  await applyStripeEvent(db, ev('evt_del_F', 'customer.subscription.deleted', NOW - 40 * DAY, { id: 'sub_F', customer: 'cus_F', status: 'canceled' }))
  // G: paid 10 days ago, one payment: retention not mature yet. Its payment arrives twice as invoice.paid (same event
  // id: a redelivery) and once as invoice.payment_succeeded (another event, same invoice): one payment.
  await tenant(db, raw, 'G', { source: 'newsletter' })
  scan(raw, 'G', NOW - 12 * DAY, 1)
  await subscribe(db, 'G', NOW - 10 * DAY)
  await paid(db, 'G', 'in_G1', NOW - 10 * DAY); await paid(db, 'G', 'in_G1', NOW - 10 * DAY)
  await paid(db, 'G', 'in_G1', NOW - 10 * DAY, 4900, 'invoice.payment_succeeded')
  // Z: synthetic (reserved test domain), fully converted: excluded from every count
  await tenant(db, raw, 'Z', { email: 'demo@example.com', source: 'newsletter' })
  scan(raw, 'Z', T0 + DAY, 5); await subscribe(db, 'Z', T0 + 2 * DAY); await paid(db, 'Z', 'in_Z1', T0 + 2 * DAY); await paid(db, 'Z', 'in_Z2', T0 + 40 * DAY)
  // a zero-amount invoice (a trial) is not a payment
  await tenant(db, raw, 'H'); scan(raw, 'H', T0 + DAY, 1); await subscribe(db, 'H', T0 + 2 * DAY); await paid(db, 'H', 'in_H0', T0 + 2 * DAY, 0)
  return { raw, db }
}

test('funnel: exact counts per tenant and per source from real events; every distinct state kept apart', async () => {
  const { db } = await world()
  const tenants = await tenantFunnels(db, { now: NOW })
  const by = Object.fromEntries(tenants.map(t => [t.tenant_id, t])) as Record<string, TenantFunnel>
  assert.deepEqual(Object.fromEntries(tenants.map(t => [t.tenant_id, t.stage])), { A: 'retained', B: 'zero_result', C: 'signed_up_only', D: 'payment_failed', E: 'refunded', F: 'churned', G: 'paid', Z: 'excluded', H: 'activated' })
  assert.equal(by.A.repeat_at, T0 + 3 * DAY, 'the same-day second scan is not the repeat; the one 2 days later is')
  assert.equal(by.A.payments, 2); assert.equal(by.A.retained, true); assert.equal(by.A.source, 'newsletter')
  assert.equal(by.B.scans, 2); assert.equal(by.B.real_leads, 0); assert.equal(by.B.activated_at, null, 'a scan with zero real leads is not activation')
  assert.equal(by.D.paid_at, null, 'a failed payment is not paid'); assert.equal(by.D.failed_payments, 1)
  assert.equal(by.E.paid_at, null, 'a fully refunded payment is not paid'); assert.equal(by.E.refunded_payments, 1)
  assert.equal(by.F.paid_at, NOW - 60 * DAY, 'a partial refund leaves it paid'); assert.equal(by.F.retained, false); assert.equal(by.F.churned_at, NOW - 40 * DAY)
  assert.equal(by.G.payments, 1, 'one invoice delivered three times is one payment'); assert.equal(by.G.retained, null, 'not mature yet')
  assert.equal(by.H.paid_at, null, 'a zero-amount invoice is not a payment')
  assert.equal(by.B.source, 'unknown'); assert.equal(by.F.source, 'unknown')

  const r = funnelReport(tenants, NOW)
  assert.equal(r.excluded_tenants, 1)
  assert.deepEqual(r.source_coverage, { tagged: 5, unknown: 3 })
  assert.deepEqual(r.total, { source: 'all', signed_up: 8, activated: 6, repeat: 1, paid: 3, retained: 1, retention_mature: 2, covered_at_cutoff: 1, coverage_unknown: 1, churned: 1, zero_result: 1, signed_up_only: 1, payment_failed: 1, refunded: 1 })
  assert.deepEqual(r.by_source, [
    { source: 'newsletter', signed_up: 3, activated: 2, repeat: 1, paid: 2, retained: 1, retention_mature: 1, covered_at_cutoff: 1, coverage_unknown: 1, churned: 0, zero_result: 0, signed_up_only: 1, payment_failed: 0, refunded: 0 },
    { source: 'unknown', signed_up: 3, activated: 2, repeat: 0, paid: 1, retained: 0, retention_mature: 1, covered_at_cutoff: 0, coverage_unknown: 0, churned: 1, zero_result: 1, signed_up_only: 0, payment_failed: 0, refunded: 0 },
    { source: 'linkedin-post', signed_up: 2, activated: 2, repeat: 0, paid: 0, retained: 0, retention_mature: 0, covered_at_cutoff: 0, coverage_unknown: 0, churned: 0, zero_result: 0, signed_up_only: 0, payment_failed: 1, refunded: 1 },
  ])
  assert.ok(Object.keys(DEFINITIONS).includes('activated') && /not causal|not proof/.test(r.note + DEFINITIONS.source))
})

test('one customer is counted once: many scans, redelivered webhooks and a second invoice event type change no counts', async () => {
  const { db, raw } = await world()
  const before = funnelReport(await tenantFunnels(db, { now: NOW }), NOW)
  // redeliver every payment event and add more scans for A and G
  await paid(db, 'A', 'in_A1', T0 + 4 * DAY); await paid(db, 'A', 'in_A1', T0 + 4 * DAY, 4900, 'invoice.payment_succeeded')
  for (let i = 0; i < 5; i++) scan(raw, 'A', T0 + (50 + i) * DAY, 2)
  const after = funnelReport(await tenantFunnels(db, { now: NOW }), NOW)
  assert.deepEqual(after.total, before.total); assert.deepEqual(after.by_source, before.by_source)
  assert.equal((raw.prepare("SELECT count(*) AS n FROM lifecycle_events WHERE tenant_id = 'A' AND kind = 'payment_succeeded'").get() as { n: number }).n, 2)
  // repeat use is a scan with real leads at least a day after the first: G's next one, a day later, counts
  scan(raw, 'G', NOW - 11 * DAY, 3)
  const g = (await tenantFunnels(db, { now: NOW })).find(t => t.tenant_id === 'G')!
  assert.equal(g.repeat_at, NOW - 11 * DAY)
  assert.equal(funnelReport(await tenantFunnels(db, { now: NOW }), NOW).total.repeat, before.total.repeat + 1)
})

test('maturity: the same paid tenant moves from not-mature to retained or not as time passes', async () => {
  const { db } = await world()
  const g = async (now: number) => (await tenantFunnels(db, { now })).find(t => t.tenant_id === 'G')!.retained
  assert.equal(await g(NOW), null)
  assert.equal(await g(NOW - 10 * DAY + RETAIN_MATURE_S), false, 'mature and no second payment: not retained')
})

test('source tags: first-party, normalised, never guessed; exclusions by reserved domain and by list', async () => {
  assert.equal(normaliseSource(' LinkedIn-Post '), 'linkedin-post')
  for (const bad of ['', '   ', 'https://evil.example/x', 'a b', 'me@x.com', 'x'.repeat(41), 42, null, undefined]) assert.equal(normaliseSource(bad), null, String(bad))
  const { db, raw } = store()
  await tenant(db, raw, 'U', { source: null })
  await tenant(db, raw, 'S', { email: 'qa@staging.test', source: 'newsletter' })
  await tenant(db, raw, 'L', { source: 'newsletter' })
  const r = funnelReport(await tenantFunnels(db, { now: NOW, excludeTenants: ['L'] }), NOW)
  assert.equal(r.excluded_tenants, 2); assert.deepEqual(r.by_source.map(x => [x.source, x.signed_up]), [['unknown', 1]])
  assert.equal((raw.prepare("SELECT count(*) AS n FROM lifecycle_events WHERE kind = 'signup'").get() as { n: number }).n, 2, 'no signup event without a tag')
})

test('report command: read-only on the store file, JSON and markdown, no emails in the per-tenant rows', async () => {
  const { spawnSync } = await import('node:child_process')
  const { mkdtempSync, statSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'funnel-')), 'app.db')
  const raw = new Database(file); migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  await tenant(db, raw, 'A', { source: 'newsletter' }); scan(raw, 'A', T0 + DAY, 1)
  await tenant(db, raw, 'Z', { email: 'demo@example.com' })
  raw.close()
  const mtime = statSync(file).mtimeMs
  const run = (...a: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/funnel.mts', '--db', file, '--now', String(NOW), ...a], { encoding: 'utf8' })
  let r = run('--tenants')
  assert.equal(r.status, 0, r.stderr)
  const j = JSON.parse(r.stdout)
  assert.equal(j.total.signed_up, 1); assert.equal(j.total.activated, 1); assert.equal(j.excluded_tenants, 1)
  assert.doesNotMatch(r.stdout, /@/, 'no email address in the output')
  r = run('--markdown'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /\| all \| 1 \| 1 \(100%\)/); assert.match(r.stdout, /1 synthetic or staging tenant\(s\) excluded/)
  assert.equal(statSync(file).mtimeMs, mtime, 'the store file was not written')
})

// Instinct review of #404 @0d26e1cc, reproduced
test('activation needs a scan that finished: a failed or unfinished scan that saved a real lead is not activation', async () => {
  const { raw, db } = store()
  await tenant(db, raw, 'F'); scan(raw, 'F', T0 + DAY, 1, [], 'failed')
  await tenant(db, raw, 'R'); scan(raw, 'R', T0 + DAY, 2, [], 'running')
  await tenant(db, raw, 'L'); scan(raw, 'L', T0 + DAY, 1, [], 'failed'); scan(raw, 'L', T0 + 2 * DAY, 1)
  // a failed scan between two finished ones is not the repeat either
  await tenant(db, raw, 'P'); scan(raw, 'P', T0 + DAY, 1); scan(raw, 'P', T0 + 3 * DAY, 4, [], 'failed')
  const by = Object.fromEntries((await tenantFunnels(db, { now: NOW })).map(t => [t.tenant_id, t]))
  assert.equal(by.F.activated_at, null); assert.equal(by.F.stage, 'zero_result')
  assert.equal(by.R.activated_at, null); assert.equal(by.R.stage, 'zero_result')
  assert.equal(by.L.activated_at, T0 + 2 * DAY, 'the later finished scan activates')
  assert.equal(by.P.activated_at, T0 + DAY); assert.equal(by.P.repeat_at, null, 'a failed later scan is not repeat use')
})

test('refunds: partial then full on one charge is not paid, in either order, redelivered or not; history is kept', async () => {
  const refund = (db: Db, t: string, evt: string, at: number, amount: number, full: boolean, invoice: string, type = 'charge.refunded') =>
    applyStripeEvent(db, ev(evt, type, at, { id: `ch_${invoice}`, customer: `cus_${t}`, invoice, amount_refunded: amount, refunded: full }))
  const { raw, db } = store()
  const setup = async (t: string) => { await tenant(db, raw, t); scan(raw, t, T0 + DAY, 1); await subscribe(db, t, T0 + 2 * DAY); await paid(db, t, `in_${t}`, T0 + 2 * DAY, 4900) }
  // in order: partial, then the rest
  await setup('IO'); await refund(db, 'IO', 'e_io1', T0 + 3 * DAY, 1000, false, 'in_IO'); await refund(db, 'IO', 'e_io2', T0 + 4 * DAY, 4900, true, 'in_IO')
  // out of order: the full refund's event arrives first, the earlier partial one after it
  await setup('OO'); await refund(db, 'OO', 'e_oo2', T0 + 4 * DAY, 4900, true, 'in_OO'); await refund(db, 'OO', 'e_oo1', T0 + 3 * DAY, 1000, false, 'in_OO')
  // duplicates: the partial delivered twice (same event), and once more under another event id with the same total
  await setup('DP'); for (const e of ['e_dp1', 'e_dp1', 'e_dp1b']) await refund(db, 'DP', e, T0 + 3 * DAY, 1000, false, 'in_DP')
  // two partials adding up to the whole amount, without Stripe's refunded flag on the last one
  await setup('SUM'); await refund(db, 'SUM', 'e_s1', T0 + 3 * DAY, 2000, false, 'in_SUM'); await refund(db, 'SUM', 'e_s2', T0 + 4 * DAY, 4900, false, 'in_SUM')
  const by = Object.fromEntries((await tenantFunnels(db, { now: NOW })).map(t => [t.tenant_id, t]))
  for (const t of ['IO', 'OO', 'SUM']) { assert.equal(by[t].paid_at, null, `${t}: fully refunded is not paid`); assert.equal(by[t].stage, 'refunded', t); assert.equal(by[t].refunded_payments, 1) }
  assert.equal(by.DP.paid_at, T0 + 2 * DAY, 'only a partial refund: still paid'); assert.equal(by.DP.refunded_payments, 0)
  const rows = (t: string) => (raw.prepare("SELECT ref FROM lifecycle_events WHERE tenant_id = ? AND kind = 'refund' ORDER BY ref").all(t) as { ref: string }[]).map(r => r.ref)
  assert.deepEqual(rows('IO'), ['ch_in_IO:1000', 'ch_in_IO:4900'], 'both refund states kept as history')
  assert.deepEqual(rows('OO'), ['ch_in_OO:1000', 'ch_in_OO:4900'])
  assert.deepEqual(rows('DP'), ['ch_in_DP:1000'], 'the same refunded total is one row however often it arrives')
})

test('retention window: one rule, N days; 30 (one monthly renewal) and 60 (two) answer differently on the same events', async () => {
  const { db } = await world()
  const r30 = Object.fromEntries((await tenantFunnels(db, { now: NOW })).map(t => [t.tenant_id, t.retained]))
  const r60 = Object.fromEntries((await tenantFunnels(db, { now: NOW, retainDays: 60 })).map(t => [t.tenant_id, t.retained]))
  // A renewed 30 days after its first payment: retained at 30, not at 60 (it needs a payment 55+ days on)
  assert.equal(r30.A, true); assert.equal(r60.A, false)
  // F paid 60 days ago and never again: mature for both windows, retained in neither
  assert.equal(r30.F, false); assert.equal(r60.F, null, 'at 60 days F is not mature yet (needs 65)')
  assert.match(DEFINITIONS.retained, /Retained at day 30.*shared definition/)
})

// Instinct review of #404 @4a6db2c: the report is as of its cutoff, for every kind of row
test('as of the cutoff: users, scans, leads and events after it do not count, including replayed or future-dated rows', async () => {
  const { raw, db } = store()
  const CUT = NOW - 30 * DAY
  // signed up, scanned and paid before the cutoff
  await tenant(db, raw, 'B4', { source: 'newsletter', at: T0 }); scan(raw, 'B4', T0 + DAY, 1); await subscribe(db, 'B4', T0 + 2 * DAY); await paid(db, 'B4', 'in_B4', T0 + 2 * DAY)
  // signed up before, but its invoice was paid after the cutoff
  await tenant(db, raw, 'PA', { at: T0 }); scan(raw, 'PA', T0 + DAY, 1); await subscribe(db, 'PA', CUT + DAY); await paid(db, 'PA', 'in_PA', CUT + DAY)
  // its only finished scan started before the cutoff but finished after it; another started after it
  await tenant(db, raw, 'SA', { at: T0 })
  const job = scan(raw, 'SA', CUT - 60, 1); raw.prepare('UPDATE scan_jobs SET finished_at = ? WHERE id = ?').run(CUT + 3600, job)
  scan(raw, 'SA', CUT + DAY, 2)
  // a lead saved after the cutoff on a scan that finished before it
  await tenant(db, raw, 'LA', { at: T0 }); const j2 = scan(raw, 'LA', T0 + DAY, 1); raw.prepare('UPDATE leads SET created_at = ? WHERE scan_job_id = ?').run(CUT + DAY, j2)
  // an account created after the cutoff
  await tenant(db, raw, 'UA', { at: CUT + DAY })
  // B4 refunded after the cutoff (a replayed refund event): still paid as of the cutoff
  await applyStripeEvent(db, ev('evt_late_ref', 'charge.refunded', CUT + 5 * DAY, { id: 'ch_B4', customer: 'cus_B4', invoice: 'in_B4', amount_refunded: 4900, refunded: true }))
  const at = Object.fromEntries((await tenantFunnels(db, { now: CUT })).map(t => [t.tenant_id, t]))
  assert.equal(at.UA, undefined, 'an account created after the cutoff does not exist yet')
  assert.equal(at.PA.paid_at, null, 'an invoice paid after the cutoff does not count'); assert.equal(at.PA.stage, 'activated')
  assert.equal(at.SA.activated_at, null, 'a scan that finished after the cutoff had not delivered by then')
  assert.equal(at.LA.activated_at, null, 'a lead saved after the cutoff did not exist yet')
  assert.equal(at.B4.paid_at, T0 + 2 * DAY, 'a refund after the cutoff has not happened yet'); assert.equal(at.B4.stage, 'paid')
  const r = funnelReport(await tenantFunnels(db, { now: CUT }), CUT)
  assert.equal(r.total.signed_up, 4); assert.equal(r.total.paid, 1); assert.equal(r.total.activated, 2)
  // the same store, a later cutoff: everything is there
  const later = Object.fromEntries((await tenantFunnels(db, { now: NOW })).map(t => [t.tenant_id, t]))
  assert.equal(later.PA.paid_at, CUT + DAY); assert.equal(later.SA.activated_at, CUT - 60); assert.equal(later.B4.paid_at, null, 'refunded by now'); assert.ok(later.UA)
})

test('retention in the funnel is the shared definition: same eligible cohort in numerator and denominator', async () => {
  const { raw, db } = store()
  // three paying tenants renewed 26 days after paying; only one is old enough to be eligible
  for (const [t, firstAgo] of [['E1', 40], ['Y1', 30], ['Y2', 27]] as const) {
    await tenant(db, raw, t); scan(raw, t, NOW - 60 * DAY, 1); await subscribe(db, t, NOW - firstAgo * DAY)
    await paid(db, t, `in_${t}a`, NOW - firstAgo * DAY); await paid(db, t, `in_${t}b`, NOW - (firstAgo - 26) * DAY)
  }
  const r = funnelReport(await tenantFunnels(db, { now: NOW }), NOW)
  assert.equal(r.total.retention_mature, 1); assert.equal(r.total.retained, 1, 'never more retained than eligible')
  assert.ok(r.total.retained <= r.total.retention_mature)
})

test('coverage per tenant is positive evidence or unknown: A lapsed with no end recorded is unknown, G inside its period is covered, F ended is not covered', async () => {
  const { db } = await world()
  const by = Object.fromEntries((await tenantFunnels(db, { now: NOW })).map(t => [t.tenant_id, t]))
  assert.equal(by.A.covered_at_cutoff, 'unknown', 'last payment 86 days ago, no end recorded: not "covered"')
  assert.equal(by.A.retained, true, 'renewed at day 30: day-30 retention is historical and still holds')
  assert.equal(by.G.covered_at_cutoff, 'covered'); assert.equal(by.F.covered_at_cutoff, 'not_covered'); assert.equal(by.C.covered_at_cutoff, null, 'never paid: not in the coverage cohort')
  const r = funnelReport(await tenantFunnels(db, { now: NOW }), NOW)
  assert.match(r.cohorts.retained, /renewal window has closed/); assert.match(r.cohorts.covered_at_cutoff, /every tenant that has paid/)
})

test('coverage from the webhook\'s recorded service periods: annual, one-off, a two-period gap, immediate and end-of-period cancellation', async () => {
  const { raw, db } = store()
  const go = async (t: string) => { await tenant(db, raw, t); scan(raw, t, NOW - 300 * DAY, 1); await subscribe(db, t, NOW - 200 * DAY) }
  // Stripe-shaped invoice line items (docs.stripe.com/api/invoice-line-item/object): type, subscription, period, price
  const line = (sub: string | null, start: number, end: number, type = 'subscription') => ({ object: 'line_item', type, subscription: sub, period: { start, end }, price: { id: 'price_pro' } })
  const invoice = (t: string, id: string, at: number, lines: unknown[]) => applyStripeEvent(db, ev(`evt_${id}`, 'invoice.paid', at, { id, object: 'invoice', customer: `cus_${t}`, subscription: `sub_${t}`, amount_paid: 4900, lines: { object: 'list', data: lines } }))
  await go('AN'); await invoice('AN', 'in_AN', NOW - 200 * DAY, [line('sub_AN', NOW - 200 * DAY, NOW + 165 * DAY)])
  // a one-off invoice item (no subscription): not service
  await go('ON'); await invoice('ON', 'in_ON', NOW - 5 * DAY, [line(null, NOW - 5 * DAY, NOW - 5 * DAY + 1, 'invoiceitem')])
  // the review case: one paid invoice with periods 30-20 days ago and 20-30 days ahead
  await go('GP'); await invoice('GP', 'in_GP', NOW - 30 * DAY, [line('sub_GP', NOW - 30 * DAY, NOW - 20 * DAY), line('sub_GP2', NOW + 20 * DAY, NOW + 30 * DAY)])
  // immediate cancellation (Stripe cancels at once and sends customer.subscription.deleted with ended_at = now)
  await go('IC'); await invoice('IC', 'in_IC', NOW - 20 * DAY, [line('sub_IC', NOW - 20 * DAY, NOW + 10 * DAY)])
  await applyStripeEvent(db, ev('evt_del_IC', 'customer.subscription.deleted', NOW - 15 * DAY, { id: 'sub_IC', object: 'subscription', customer: 'cus_IC', status: 'canceled', canceled_at: NOW - 15 * DAY, ended_at: NOW - 15 * DAY, cancel_at_period_end: false }))
  // cancellation at the end of the period, as Stripe documents it (docs.stripe.com/billing/subscriptions/cancel): the
  // subscription stays active with cancel_at_period_end, customer.subscription.updated is sent, and
  // customer.subscription.deleted only arrives when the paid period ends
  await go('PP'); await invoice('PP', 'in_PP', NOW - 20 * DAY, [line('sub_PP', NOW - 20 * DAY, NOW + 10 * DAY)])
  await applyStripeEvent(db, ev('evt_upd_PP', 'customer.subscription.updated', NOW - 15 * DAY, { id: 'sub_PP', object: 'subscription', customer: 'cus_PP', status: 'active', cancel_at_period_end: true, cancel_at: NOW + 10 * DAY, canceled_at: NOW - 15 * DAY }))
  const now = Object.fromEntries((await tenantFunnels(db, { now: NOW })).map(t => [t.tenant_id, t.covered_at_cutoff]))
  assert.deepEqual(now, { AN: 'covered', ON: 'unknown', GP: 'unknown', IC: 'not_covered', PP: 'covered' })
  // positives inside each of GP's periods, and PP once its period ends and Stripe sends the deletion
  assert.equal((await tenantFunnels(db, { now: NOW - 25 * DAY })).find(t => t.tenant_id === 'GP')!.covered_at_cutoff, 'covered')
  await applyStripeEvent(db, ev('evt_del_PP', 'customer.subscription.deleted', NOW + 10 * DAY, { id: 'sub_PP', object: 'subscription', customer: 'cus_PP', status: 'canceled', canceled_at: NOW - 15 * DAY, ended_at: NOW + 10 * DAY, cancel_at_period_end: true }))
  const later = Object.fromEntries((await tenantFunnels(db, { now: NOW + 25 * DAY })).map(t => [t.tenant_id, t.covered_at_cutoff]))
  assert.equal(later.GP, 'covered', 'inside the second period'); assert.equal(later.PP, 'not_covered', 'after the period ended and the subscription was deleted')
  const stored = JSON.parse((raw.prepare("SELECT service_periods FROM lifecycle_events WHERE ref = 'in_GP'").get() as { service_periods: string }).service_periods)
  assert.deepEqual(stored.map((p: { subscription: string; price: string }) => [p.subscription, p.price]), [['sub_GP', 'price_pro'], ['sub_GP2', 'price_pro']], 'each line kept with its identity')
  assert.equal((raw.prepare("SELECT service_periods FROM lifecycle_events WHERE ref = 'in_ON'").get() as { service_periods: string | null }).service_periods, null)
})
