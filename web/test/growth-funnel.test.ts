// #404: Dazl's own acquisition funnel from recorded events, on synthetic cohorts only (made-up accounts and addresses;
// nothing is sent, charged or fetched). Runs on SQLite, and on Postgres when DAZL_TEST_PG_URL is set (CI).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Db } from '../lib/db/client.ts'
import { record } from '../lib/audit.ts'
import { applyStripeEvent } from '../lib/billing/stripe.ts'
import { ACTIVATION_DAYS, jsonUsage, MAX_CALL_TOKENS, priceModelRows, REPEAT_DAYS, RETENTION_DAYS, funnelReport, syntheticEmail, usageOf } from '../lib/growth/funnel.ts'
import { bothEngines } from './helpers/engines.ts'

const DAY = 86400
const T0 = Date.UTC(2026, 5, 1) / 1000 // 2026-06-01
const NOW = T0 + 200 * DAY
const G = 'growth-ws' // dazl's own growth workspace (a personal workspace: its id is the founder's users.id)

async function user(db: Db, id: string, email: string, at: number) {
  await db.run('INSERT INTO users (id, email, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)', [id, email, 'h', 's', at])
}
async function member(db: Db, tenant: string, id: string, role: string) {
  await db.run('INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, ?, ?)', [tenant, id, role, T0])
}
let seq = 0
// one play: status, source-checked count, and how many of its leads pass the usable-lead checks
async function play(db: Db, tenant: string, at: number, o: { status?: string; verified?: number; usable?: number; held?: number; test?: boolean; csv?: boolean } = {}) {
  const id = `job${++seq}`
  const marker = o.test ? 'test only' : 'software'
  await db.run(`INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location, query, csv_domain, created_at, finished_at, verified)
    VALUES (?, ?, 'running', 'Biz', ?, ?, 'saas founders hiring', ?, ?, ?, ?)`,
  [id, tenant, marker, o.test ? 'test only' : 'Toronto', o.csv ? 'csv.example.test' : null, at, o.status === 'failed' ? null : at + 600, o.verified ?? 0])
  for (let i = 0; i < (o.usable ?? 0); i++) await db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url, date_status, event_date) VALUES (?, ?, 'Synthetic Co', 'raised a seed round', 'https://news.example.test/a', 'verified', '2026-05-20')", [`${id}-u${i}`, id])
  // held leads: in review, or with no verified date, never make a run usable
  for (let i = 0; i < (o.held ?? 0); i++) await db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url, date_status, review_reason) VALUES (?, ?, 'Synthetic Co', 'maybe hiring', 'https://news.example.test/b', 'unverified', 'identity')", [`${id}-h${i}`, id])
  // leads are only ever added to a running job (a store trigger); the run then ends as recorded
  await db.run('UPDATE scan_jobs SET status = ? WHERE id = ?', [o.status ?? 'done', id])
  return id
}
async function plan(db: Db, tenant: string, at: number, action: 'billing.plan_changed' | 'billing.payment_failed' | 'billing.refunded', summary: Record<string, unknown>) {
  await record(db, { tenantId: tenant, actorId: 'stripe', actorKind: 'service', action, resourceType: 'plan', summary }, at)
}
async function send(db: Db, to: string, at: number, o: { test?: boolean; signal?: string; source?: string } = {}) {
  const id = `msg${++seq}`
  await db.run("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, test) VALUES (?, ?, ?, ?, 'Quick idea', 'A short synthetic first touch body.', 'sent', ?, ?)",
    [id, G, `lead-${id}`, to, at, o.test ? 1 : 0])
  if (o.signal) await db.run('INSERT INTO outreach_signal_context (message_id, tenant_id, lead_id, scan_job_id, signal_kind, source_kind, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, G, `lead-${id}`, 'gjob', o.signal, o.source ?? null, at])
  return id
}

// The synthetic population. Each account exercises one rule; the expected numbers below are counted by hand from it.
async function seed(db: Db) {
  await user(db, G, 'founder@growth.dazl-fixture.co', T0 - 100 * DAY)
  await member(db, G, G, 'owner')
  await user(db, 'S', 'staff@growth.dazl-fixture.co', T0 + 1 * DAY) // dazl staff: internal
  await member(db, G, 'S', 'admin')

  // A: contacted three times from two plays (one address, case and spaces vary), positive reply; signs up, activates,
  // repeats, pays, stays
  const a1 = await send(db, 'ana@quillfeather.co', T0, { signal: 'funding_round', source: 'news' })
  await send(db, ' Ana@Quillfeather.co ', T0 + 1 * DAY, { signal: 'hiring_surge', source: 'jobs' })
  await send(db, 'ANA@quillfeather.co', T0 + 2 * DAY)
  await db.run("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, from_email, excerpt, classification, received_at, outreach_message_id) VALUES ('g1', ?, 't1', 'ana@quillfeather.co', 'sounds good', 'positive', ?, ?)", [G, T0 + 3 * DAY, a1])
  await user(db, 'A', 'ana@quillfeather.co', T0 + 5 * DAY)
  await play(db, 'A', T0 + 6 * DAY, { verified: 2, usable: 2 })
  await play(db, 'A', T0 + 10 * DAY, { verified: 1, usable: 1 })
  await plan(db, 'A', T0 + 12 * DAY, 'billing.plan_changed', { plan: 'pro', previous: 'free', ends: false })

  // B: claimed a preview the growth workspace sent; plays finish with nothing usable
  await user(db, 'B', 'ben@harrowgate.io', T0 + 3 * DAY)
  await db.run("INSERT INTO preview_claims (id, run_id, seller_tenant_id, recipient_email, business, snapshot, created_at, expires_at, claimed_by_tenant, claimed_at) VALUES ('pc1', 'r1', ?, 'ben@harrowgate.io', 'Harrowgate', '{}', ?, ?, 'B', ?)", [G, T0, T0 + 30 * DAY, T0 + 3 * DAY])
  await play(db, 'B', T0 + 4 * DAY, { verified: 0, held: 3 })
  await play(db, 'B', T0 + 5 * DAY, { verified: 2, held: 2 }) // source-checked but every lead held: still not usable
  // B's invited teammate: a seat, not an acquisition
  await user(db, 'J', 'jo@harrowgate.io', T0 + 6 * DAY)
  await db.run("INSERT INTO invitations (id, tenant_id, email, role, token_hash, invited_by, created_at, expires_at, accepted_at, accepted_by) VALUES ('inv1', 'B', 'jo@harrowgate.io', 'operator', 'th1', 'B', ?, ?, ?, 'J')", [T0, T0 + 9 * DAY, T0 + 6 * DAY])

  // C: unrelated signup; a colleague at the same company was contacted and booked, and a TEST message to C itself
  // was sent before signup. C only ever ran a test fixture: abandoned setup, unattributed
  await send(db, 'dan@lumenfold.com', T0)
  await db.run("INSERT INTO calcom_bookings (tenant_id, booking_uid, attendee_email, created_at) VALUES (?, 'bk1', 'Dan@Lumenfold.com', ?)", [G, T0 + 2 * DAY])
  await send(db, 'cara@lumenfold.com', T0, { test: true })
  await user(db, 'C', 'cara@lumenfold.com', T0 + 4 * DAY)
  await play(db, 'C', T0 + 5 * DAY, { verified: 3, usable: 3, test: true })
  await play(db, 'C', T0 + 5 * DAY, { verified: 3, usable: 3, csv: true }) // an import is not the account's own play

  // D: started a play that failed
  await user(db, 'D', 'dev@brightmoor.net', T0 + 2 * DAY)
  await play(db, 'D', T0 + 3 * DAY, { status: 'failed' })

  // E: contacted, signs up, activates (a same-day second run is not repeat use), pays, a payment fails, churns at day 60
  await send(db, 'eve@saltmarsh.co', T0 + 1 * DAY, { signal: 'hiring_surge', source: 'jobs' })
  await user(db, 'E', 'eve@saltmarsh.co', T0 + 7 * DAY)
  await play(db, 'E', T0 + 9 * DAY, { verified: 1, usable: 1 })
  await play(db, 'E', T0 + 9 * DAY + 3600, { verified: 1, usable: 1 })
  await plan(db, 'E', T0 + 20 * DAY, 'billing.plan_changed', { plan: 'pro', previous: 'free', ends: false })
  await plan(db, 'E', T0 + 30 * DAY, 'billing.payment_failed', { status: 'past_due' })
  await plan(db, 'E', T0 + 60 * DAY, 'billing.plan_changed', { plan: 'free', previous: 'pro', ends: true })

  // F: unattributed, activates, pays, is refunded in full (plan untouched): not retained
  await user(db, 'F', 'fay@copperline.org', T0 + 8 * DAY)
  await play(db, 'F', T0 + 11 * DAY, { verified: 4, usable: 1, held: 3 })
  await plan(db, 'F', T0 + 15 * DAY, 'billing.plan_changed', { plan: 'pro', previous: 'free', ends: false })
  await plan(db, 'F', T0 + 18 * DAY, 'billing.refunded', { full: true })

  // H: contacted only AFTER signing up: unattributed
  await user(db, 'H', 'hal@tidewell.io', T0 + 2 * DAY)
  await send(db, 'hal@tidewell.io', T0 + 9 * DAY)

  // I: contacted, then unsubscribed from the growth workspace: attribution unknown (consent withdrawn)
  await send(db, 'ivy@ferncastle.co', T0)
  await db.run("INSERT INTO suppressions (tenant_id, email, reason) VALUES (?, 'ivy@ferncastle.co', 'unsubscribe')", [G])
  await user(db, 'I', 'ivy@ferncastle.co', T0 + 3 * DAY)

  // M: paid before the audit trail existed: the verified checkout conversion stands in; still Pro
  await user(db, 'M', 'max@orchardpeak.co', T0 + 2 * DAY)
  await db.run("INSERT INTO lifecycle_events (event_key, kind, email, account_tenant, created_at, activated_at) VALUES ('payment|max@orchardpeak.co', 'payment', 'max@orchardpeak.co', 'M', ?, ?)", [T0 + 8 * DAY, T0 + 8 * DAY])
  await db.run("INSERT INTO tenant_plans (tenant_id, plan) VALUES ('M', 'pro')")

  // L: signed up five days ago: immature for every window
  await user(db, 'L', 'lee@ashgrove.co', NOW - 5 * DAY)

  // synthetic accounts and a synthetic prospect: excluded
  await user(db, 'K1', 'k@example.com', T0 + 2 * DAY)
  await user(db, 'K2', 'qa@foo.test', T0 + 2 * DAY)
  await send(db, 'buyer@example.org', T0)

  // a team workspace with two owners pays: which account it belongs to is ambiguous, so it stays unmatched
  await member(db, 'TW', 'A', 'owner'); await member(db, 'TW', 'E', 'owner')
  await plan(db, 'TW', T0 + 30 * DAY, 'billing.plan_changed', { plan: 'pro', previous: 'free', ends: false })

  // the growth workspace's own Pro plan and its own plays are dazl's, never a customer's
  await plan(db, G, T0, 'billing.plan_changed', { plan: 'pro', previous: 'free', ends: false })
  await play(db, G, T0, { verified: 5, usable: 5 })

  // reply reading on for the growth workspace; no Cal.com hook
  await db.run("INSERT INTO mail_read_consent (tenant_id, version) VALUES (?, 'v1')", [G])
  // cost: the growth workspace's monthly model spend (daily rows are the same money again), and dazl-funded trial runs
  for (const [p, usd] of [['m:2026-06', 12.5], ['m:2026-07', 7.5], ['d:2026-06-02', 99]] as const)
    await db.run('INSERT INTO tenant_spend_pools (tenant_id, period, reserved_usd, reported_usd, calls, updated_at) VALUES (?, ?, ?, ?, 1, ?)', [G, p, usd, usd, T0])
  await db.run("INSERT INTO trial_reservations (id, tenant_id, reserve_usd, day, created_at, settled_at, spent_usd) VALUES ('tr1', 'A', 0.5, 1, ?, ?, 0.4)", [T0, T0 + 6 * DAY])
  await db.run("INSERT INTO trial_reservations (id, tenant_id, reserve_usd, day, created_at) VALUES ('tr2', 'B', 0.5, 1, ?)", [T0])
}

const ENV = { DAZL_ENV: 'production' }

bothEngines('funnel: one count per customer, distinct setup/payment states, first-party attribution, matured windows, cost', async ({ db }) => {
  await seed(db)
  const r = await funnelReport(db, G, { now: NOW, env: ENV })
  const t = r.totals
  assert.equal(t.signups, 10) // A B C D E F H I L M
  assert.deepEqual(r.excluded, { staging_environment: false, synthetic_accounts: 2, internal_accounts: 2, invited_members: 1, test_runs: 1, test_messages: 1 })
  assert.deepEqual(t.attribution, { direct: 1, assisted: 2, unattributed: 6, unknown_opted_out: 1 })
  assert.equal(r.attribution.causal, 'not_established')
  assert.deepEqual(t.setup, { abandoned_setup: 5, runs_failed: 1, zero_result: 1, activated: 3 })
  assert.deepEqual(t.activated, { eligible: 9, count: 3, rate: 3 / 9 })
  assert.deepEqual(t.repeat_use, { eligible: 3, count: 1, rate: 1 / 3 })
  assert.equal(t.paid, 4)
  assert.equal(t.activated_paying, 3)
  assert.deepEqual([t.payment_failed, t.refunded, t.churned, t.lapsed], [1, 1, 1, 0])
  assert.deepEqual(t.retained, { d30: { eligible: 4, count: 3, rate: 0.75 }, d90: { eligible: 4, count: 2, rate: 0.5 } })

  assert.deepEqual(r.prospects, { contacted: 5, qualified_conversations: 2, signed_up: 2, activated: 2, paid: 2, reply_reading: true, bookings_hook: false })
  const src = Object.fromEntries(r.attribution.by_source.map(s => [`${s.signal_kind}/${s.source_kind}`, s]))
  assert.deepEqual({ ...src['funding_round/news'] }, { signal_kind: 'funding_round', source_kind: 'news', contacted: 1, qualified: 1, signed_up: 1, activated: 1, paid: 1 })
  assert.equal(src['hiring_surge/jobs'].signed_up, 1)
  assert.equal(src['null/null'].contacted, 3) // dan, hal, ivy: no snapshot is an explicit unknown bucket

  assert.deepEqual(r.cohorts.map(c => [c.cohort, c.signups, c.mature]), [['2026-06', 9, true], ['2026-12', 1, false]])
  assert.deepEqual(r.cohorts[1].activated, { eligible: 0, count: 0, rate: null })

  assert.equal(r.cost.recorded_usd, 20.4)
  assert.equal(r.cost.complete, false)
  assert.deepEqual(r.cost.components.filter(c => c.status === 'not_recorded').map(c => c.name), ['enrichment'])
  // no model call rows: the pool's vendor-settled total is the model spend (the larger of the two, never added)
  assert.deepEqual(r.cost.model_spend, { token_priced_usd: 0, pool_reported_usd: 20, counted_usd: 20, rule: r.cost.model_spend.rule })
  assert.deepEqual(r.cost.components.filter(c => ['scans', 'outreach_drafting', 'evaluation'].includes(c.name)).map(c => [c.name, c.usd, c.status, c.priced_calls, c.unpriced_calls]),
    [['scans', 0, 'recorded', 0, 0], ['outreach_drafting', 0, 'recorded', 0, 0], ['evaluation', 0, 'recorded', 0, 0]])
  assert.deepEqual(r.cost.per_activated_paying, { customers: 3, usd_lower_bound: 6.8 })
  assert.deepEqual(r.cost.per_retained_paying, { window_days: 30, customers: 3, usd_lower_bound: 6.8 })
  assert.deepEqual(r.coverage.payment_timeline, { audit: 3, lifecycle_fallback: 1 })
  assert.equal(r.coverage.refund_events, 1)
  assert.equal(r.coverage.unmatched_paid_workspaces, 1)
  assert.equal(r.coverage.unsettled_trial_reservations, 1)
  assert.equal(r.coverage.attribution_known, 0.9)
  assert.ok(r.coverage.notes.some(n => /Cal\.com/.test(n)))

  // aggregate only: no address, account or workspace id leaves the report
  const body = JSON.stringify(r)
  for (const s of ['quillfeather', 'harrowgate', 'lumenfold', 'saltmarsh', 'orchardpeak', 'dazl-fixture', G, '"TW"']) assert.ok(!body.includes(s), s)
})

bothEngines('funnel: recomputing is stable, and more messages or visits never add a customer', async ({ db }) => {
  await seed(db)
  const before = await funnelReport(db, G, { now: NOW, env: ENV })
  await send(db, 'ana@quillfeather.co', T0 + 3 * DAY) // a fourth touch to A
  await play(db, 'A', T0 + 40 * DAY, { verified: 1, usable: 1 }) // another visit and play
  const after = await funnelReport(db, G, { now: NOW, env: ENV })
  assert.equal(after.totals.signups, before.totals.signups)
  assert.equal(after.prospects.contacted, before.prospects.contacted)
  assert.deepEqual(after.totals.setup, before.totals.setup)
  assert.equal(after.totals.paid, before.totals.paid)
})

bothEngines('funnel: on a staging server every row is test data and nothing is counted', async ({ db }) => {
  await seed(db)
  const r = await funnelReport(db, G, { now: NOW, env: { DAZL_ENV: 'staging' } })
  assert.equal(r.environment, 'staging')
  assert.equal(r.excluded.staging_environment, true)
  assert.equal(r.totals.signups, 0)
  assert.equal(r.totals.paid, 0)
  assert.equal(r.excluded.synthetic_accounts, 13)
})

bothEngines('funnel: a lapse to Free without an end, and a fallback payment with no known end, are not guessed', async ({ db }) => {
  await user(db, G, 'founder@growth.dazl-fixture.co', T0 - DAY)
  await user(db, 'P', 'pat@marblecove.co', T0)
  await plan(db, 'P', T0 + DAY, 'billing.plan_changed', { plan: 'pro', previous: 'free', ends: false })
  await plan(db, 'P', T0 + 10 * DAY, 'billing.plan_changed', { plan: 'free', previous: 'pro', ends: false, status: 'unpaid' })
  await user(db, 'Q', 'quin@marblecove.co', T0)
  await db.run("INSERT INTO lifecycle_events (event_key, kind, email, account_tenant, created_at, activated_at) VALUES ('payment|quin@marblecove.co', 'payment', 'quin@marblecove.co', 'Q', ?, ?)", [T0 + DAY, T0 + DAY])
  const r = await funnelReport(db, G, { now: NOW, env: ENV })
  assert.equal(r.totals.lapsed, 1)
  assert.equal(r.totals.churned, 0)
  assert.deepEqual(r.totals.retained.d30, { eligible: 1, count: 0, rate: 0 }) // Q's retention is unknown, not lost
  assert.equal(r.coverage.retention_unknown, 1)
})

bothEngines('charge.refunded is recorded for the report and changes no plan; a replay records nothing twice', async ({ db }) => {
  const checkout = { id: 'evt_c1', type: 'checkout.session.completed', created: T0, data: { object: { mode: 'subscription', client_reference_id: 'R', customer: 'cus_r', subscription: 'sub_r' } } }
  assert.equal(await applyStripeEvent(db, checkout), 'applied')
  const refund = { id: 'evt_r1', type: 'charge.refunded', created: T0 + DAY, data: { object: { customer: 'cus_r', refunded: true } } }
  assert.equal(await applyStripeEvent(db, refund), 'applied')
  assert.equal(await applyStripeEvent(db, refund), 'duplicate')
  const rows = await db.all<{ summary: string }>("SELECT summary FROM audit_events WHERE tenant_id = 'R' AND action = 'billing.refunded'")
  assert.equal(rows.length, 1)
  assert.equal(JSON.parse(rows[0].summary).full, true)
  assert.equal((await db.get<{ plan: string }>("SELECT plan FROM tenant_plans WHERE tenant_id = 'R'"))!.plan, 'pro')
  // a refund for a customer no tenant has changes nothing
  assert.equal(await applyStripeEvent(db, { id: 'evt_r2', type: 'charge.refunded', data: { object: { customer: 'cus_unknown', refunded: true } } }, { log: () => {} }), 'ignored')
})

// #404 cost: model calls priced from recorded tokens at the served model's listed price (claude-sonnet-4-5: $3 in, $15 out per
// million; cache reads 0.1x and writes 2x the input price). Every malformed or unpriced row is an unpriced call, never $0.
async function scanCall(db: Db, tenant: string, model: string | null, input: number | null, output: number | null) {
  await db.run("INSERT INTO scan_model_calls (tenant_id, job_id, attempt, seq, stage, method, model_served, input_tokens, output_tokens, outcome, prompt_chars) VALUES (?, NULL, 0, ?, 'extraction', 'completeDetailed', ?, ?, ?, 'ok', 100)",
    [tenant, ++seq, model, input, output])
}
async function draftCall(db: Db, tenant: string, outcome: string, model: string | null, t: (number | null)[] = [null, null, null, null]) {
  await db.run("INSERT INTO outreach_llm_usage (tenant_id, message_id, purpose, vendor, outcome, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens) VALUES (?, ?, 'polish', 'anthropic', ?, ?, ?, ?, ?, ?)",
    [tenant, `m${++seq}`, outcome, model, ...t])
}
async function qualCall(db: Db, tenant: string, status: string, model: string | null, usage: string | null) {
  await db.run('INSERT INTO lead_qualifications (tenant_id, lead_id, prompt_sha256, status, vendor, model, served_model, usage) VALUES (?, ?, ?, ?, \'anthropic\', \'claude-sonnet-4-5\', ?, ?)',
    [tenant, `lead${++seq}`, 'sha', status, model, usage])
}
async function seedCalls(db: Db) {
  await user(db, G, 'founder@growth.dazl-fixture.co', T0 - DAY)
  // scans: one priced ($3 + $1.50), a research call with no tokens, an unlisted model, a corrupt huge count; another workspace's call
  await scanCall(db, G, 'claude-sonnet-4-5-20250929', 1_000_000, 100_000)
  await scanCall(db, G, null, null, null)
  await scanCall(db, G, 'gpt-unlisted', 10, 10)
  await scanCall(db, G, 'claude-sonnet-4-5', MAX_CALL_TOKENS + 1, 10)
  await scanCall(db, 'A', 'claude-sonnet-4-5', 1_000_000, 0)
  // drafting: one priced with cache ($0.30 + $0.15 + $0.30 + $0.60); a refusal before any call; a pending (crashed) call; a negative count
  await draftCall(db, G, 'rewritten', 'claude-sonnet-4-5', [100_000, 10_000, 1_000_000, 100_000])
  await draftCall(db, G, 'no_key', null)
  await draftCall(db, G, 'spend_limit', null)
  await draftCall(db, G, 'pending', null)
  await draftCall(db, G, 'error', 'claude-sonnet-4-5', [-5, 10, null, null])
  await draftCall(db, 'B', 'rewritten', 'claude-sonnet-4-5', [1_000_000, 0, null, null])
  // evaluation: one priced ($0.60 + $0.30); not JSON, an array, a string count, a failed and a running claim; another workspace's
  await qualCall(db, G, 'done', 'claude-sonnet-4-5', '{"input_tokens":200000,"output_tokens":20000}')
  await qualCall(db, G, 'done', 'claude-sonnet-4-5', 'not json')
  await qualCall(db, G, 'done', 'claude-sonnet-4-5', '[1,2]')
  await qualCall(db, G, 'done', 'claude-sonnet-4-5', '{"input_tokens":"5","output_tokens":1}')
  await qualCall(db, G, 'failed', null, null)
  await qualCall(db, G, 'running', null, null)
  await qualCall(db, 'B', 'done', 'claude-sonnet-4-5', '{"input_tokens":1000000,"output_tokens":0}')
}

bothEngines('cost: model tokens of the growth workspace are priced per call; malformed rows are unpriced, other workspaces never count', async ({ db }) => {
  await seedCalls(db)
  await db.run('INSERT INTO tenant_spend_pools (tenant_id, period, reserved_usd, reported_usd, calls, updated_at) VALUES (?, ?, 5, 5, 1, ?)', [G, 'm:2026-06', T0])
  const r = await funnelReport(db, G, { now: NOW, env: ENV })
  const by = Object.fromEntries(r.cost.components.map(c => [c.name, [c.usd, c.status, c.priced_calls, c.unpriced_calls]]))
  assert.deepEqual(by.scans, [4.5, 'partial', 1, 3])
  assert.deepEqual(by.outreach_drafting, [1.35, 'partial', 1, 2])
  assert.deepEqual(by.evaluation, [0.9, 'partial', 1, 5])
  assert.deepEqual(by.enrichment, [null, 'not_recorded', undefined, undefined])
  assert.deepEqual({ ...r.cost.model_spend, rule: '' }, { token_priced_usd: 6.75, pool_reported_usd: 5, counted_usd: 6.75, rule: '' })
  assert.equal(r.cost.recorded_usd, 6.75)
  assert.equal(r.cost.complete, false)
  // a larger pool total (calls with no token row) is counted instead; the two are never added
  await db.run('INSERT INTO tenant_spend_pools (tenant_id, period, reserved_usd, reported_usd, calls, updated_at) VALUES (?, ?, 5, 5, 1, ?)', [G, 'm:2026-07', T0])
  const r2 = await funnelReport(db, G, { now: NOW, env: ENV })
  assert.deepEqual([r2.cost.model_spend.counted_usd, r2.cost.recorded_usd], [10, 10])
  // with scan usage recording off the scan line is a lower bound even when every stored call is priced
  const r3 = await funnelReport(db, G, { now: NOW, env: { ...ENV, DAZL_MODEL_USAGE: '0' } })
  assert.match(r3.cost.components.find(c => c.name === 'scans')!.note, /DAZL_MODEL_USAGE=0/)
  // fails without the fix: before #404 pricing, drafting and evaluation were not_recorded and recorded_usd was the pool alone
  assert.notEqual(r.cost.recorded_usd, 5)
})

test('usage parsing: wrong types, negatives, fractions, huge, non-JSON and nested values are no price (fail closed)', () => {
  assert.equal(usageOf(null, null), undefined)
  assert.deepEqual(usageOf('12', '3'), { input_tokens: 12, output_tokens: 3 }) // Postgres BIGINT text
  for (const [i, o] of [[1.5, 2], [true, 1], [-1, 1], ['1e3', 1], [MAX_CALL_TOKENS + 1, 1], [{}, 1], [[1], 1], [5, null], [NaN, 1], [Infinity, 1]] as unknown[][]) {
    const priced = priceModelRows([{ purpose: 'scans', model: 'claude-sonnet-4-5', usage: usageOf(i, o), call: true }])
    assert.deepEqual([priced.scans.priced_calls, priced.scans.unpriced_calls], [0, 1], JSON.stringify([i, o]))
  }
  for (const t of [undefined, null, 123, '', 'x'.repeat(3000), 'null', '[]', '"s"', '{"input_tokens":{"a":1},"output_tokens":1}', '{"input_tokens":1}', '{\uD800}'] as unknown[])
    assert.equal(priceModelRows([{ purpose: 'evaluation', model: 'claude-sonnet-4-5', usage: jsonUsage(t), call: true }]).evaluation.unpriced_calls, 1, String(t).slice(0, 40))
  // extra keys are ignored; an unlisted or missing model is unpriced; a refusal row is not a call
  const ok = priceModelRows([
    { purpose: 'evaluation', model: 'claude-sonnet-4-5', usage: jsonUsage('{"input_tokens":1000000,"output_tokens":0,"server_tool_use":{"web_search_requests":2}}'), call: true },
    { purpose: 'evaluation', model: 'other-model', usage: usageOf(1, 1), call: true },
    { purpose: 'evaluation', model: null, usage: usageOf(1, 1), call: true },
    { purpose: 'evaluation', model: 'claude-sonnet-4-5', usage: undefined, call: false },
  ]).evaluation
  assert.deepEqual(ok, { usd: 3, priced_calls: 1, unpriced_calls: 2 })
})

// #404 owner decision (2026-11-03 night): 14-day activation, 30- and 90-day retention. Boundaries are inclusive and a
// window counts only once it has fully elapsed.
bothEngines('windows: activation within exactly 14 days, repeat within 30, retention at 30 and 90 days; immature windows are not counted', async ({ db }) => {
  assert.equal(ACTIVATION_DAYS, 14); assert.equal(REPEAT_DAYS, 30); assert.deepEqual([...RETENTION_DAYS], [30, 90])
  await user(db, G, 'founder@growth.dazl-fixture.co', T0 - DAY)
  // W1: first usable play finishes exactly 14 days after signup (activated), and its repeat exactly 30 days later (counts)
  await user(db, 'W1', 'wa@northfield.co', T0)
  await play(db, 'W1', T0 + 14 * DAY - 600, { verified: 1, usable: 1 })
  await play(db, 'W1', T0 + 44 * DAY - 600, { verified: 1, usable: 1 })
  // W2: one second too late for activation
  await user(db, 'W2', 'wb@northfield.co', T0)
  await play(db, 'W2', T0 + 14 * DAY - 599, { verified: 1, usable: 1 })
  // W5: activated on day 1; its second play is one second past the 30-day repeat window
  await user(db, 'W5', 'we@northfield.co', T0)
  await play(db, 'W5', T0 + DAY - 600, { verified: 1, usable: 1 })
  await play(db, 'W5', T0 + 31 * DAY - 599, { verified: 1, usable: 1 })
  // W3 signed up exactly 14 days before the report (eligible); W4 one second later (not yet eligible)
  await user(db, 'W3', 'wc@northfield.co', NOW - 14 * DAY)
  await user(db, 'W4', 'wd@northfield.co', NOW - 14 * DAY + 1)
  const r = await funnelReport(db, G, { now: NOW, env: ENV })
  assert.deepEqual(r.totals.activated, { eligible: 4, count: 2, rate: 0.5 })
  // W2's late first result is its setup state, not an activation: it never enters repeat use (fails without activatedInWindow: eligible 3)
  assert.deepEqual(r.totals.repeat_use, { eligible: 2, count: 1, rate: 0.5 })
  assert.equal(r.totals.setup.activated, 3)
  assert.match(r.definitions.activation, /within 14 days/)
  assert.match(r.definitions.retained, /30, 90/)

  // retention: P pays on day 1 and stays on Pro
  await user(db, 'P', 'pat@northfield.co', T0)
  const paid = T0 + DAY
  await plan(db, 'P', paid, 'billing.plan_changed', { plan: 'pro', previous: 'free', ends: false })
  const at = async (now: number) => (await funnelReport(db, G, { now, env: ENV })).totals.retained
  assert.deepEqual(await at(paid + 30 * DAY - 1), { d30: { eligible: 0, count: 0, rate: null }, d90: { eligible: 0, count: 0, rate: null } })
  assert.deepEqual(await at(paid + 30 * DAY), { d30: { eligible: 1, count: 1, rate: 1 }, d90: { eligible: 0, count: 0, rate: null } })
  assert.deepEqual(await at(paid + 90 * DAY - 1), { d30: { eligible: 1, count: 1, rate: 1 }, d90: { eligible: 0, count: 0, rate: null } })
  assert.deepEqual(await at(paid + 90 * DAY), { d30: { eligible: 1, count: 1, rate: 1 }, d90: { eligible: 1, count: 1, rate: 1 } })
})

test('reserved test domains are synthetic; ordinary domains are not', () => {
  for (const e of ['a@example.com', 'a@sub.example.org', 'a@x.test', 'a@x.example', 'a@x.invalid', 'a@localhost.localhost', 'nobody']) assert.equal(syntheticEmail(e), true, e)
  for (const e of ['a@quillfeather.co', 'a@examples.com', 'a@testing.io']) assert.equal(syntheticEmail(e), false, e)
})

test('GET /api/growth/funnel: owners of the configured growth workspace only', () => {
  const web = fileURLToPath(new URL('..', import.meta.url))
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/growth-funnel-route-runtime.mts'], { cwd: web, env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /GROWTH ROUTE ok/)
})
