// Revenue pipeline (#366, lib/pipeline/deals.ts) on both engines, synthetic data only: routing of qualified
// conversations to an owner, audited stage changes, won/lost with reasons, history reconstruction, report reconciliation
// and tenant isolation.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bothEngines, type EngineCtx } from './helpers/engines.ts'
import { addRule, applyChange, changeDeal, deactivateRule, getDeal, listDeals, listRules, parseChange, parseRule, pickOwner, pipelineReport, routeQualifiedConversations, routingTenants, stateAt, type Deal } from '../lib/pipeline/deals.ts'

const A = 'pipe-tenant-a', B = 'pipe-tenant-b', NOW = 1_900_000_000
const n = async (c: EngineCtx, sql: string, p: (string | number)[] = []) => Number((await c.db.get<{ n: number }>(sql, p))?.n ?? 0)

// One workspace: its owner, an operator, a viewer; one play with four leads (one a test lead) and reply threads:
//   T1 positive (acme.example)       -> qualified
//   T2 positive (beta.example)       -> qualified
//   T3 positive, then a later "no"   -> not qualified
//   T4 positive from a suppressed address -> not qualified
//   T5 positive on a verification-fixture thread -> not qualified
//   T6 positive on a test lead       -> not qualified
//   T7 positive, thread settled by an opt-out stop -> not qualified
async function seed(c: EngineCtx, t: string) {
  for (const [id, role] of [[t, 'owner'], [`${t}-op`, 'operator'], [`${t}-view`, 'viewer']]) {
    await c.db.run("INSERT INTO users (id, email, password_hash, salt, name) VALUES (?, ?, 'x', 'x', ?)", [id, `${id}@example.test`, `Name ${id}`])
    await c.db.run('INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, ?, ?)', [t, id, role, NOW - 100])
  }
  const job = `${t}-job`
  await c.db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query) VALUES (?, ?, 'Seller', 'SaaS', 'Remote', 'running', 'q')", [job, t])
  const leads: Record<string, string> = {}
  for (const [k, company, kind] of [['L1', 'Acme', 'web'], ['L2', 'Beta', 'web'], ['L3', 'Gamma', 'web'], ['L4', 'TestCo', 'test']]) {
    leads[k] = `${t}-${k}`
    await c.db.run("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, source_kind, dedup_key, created_at) VALUES (?, ?, 'Pat', ?, 'Hiring', 'https://example.test/s', 50, ?, ?, ?)",
      [leads[k], job, company, kind, `${t}-${k}`, NOW - 90])
  }
  await c.db.run("UPDATE scan_jobs SET status = 'done' WHERE id = ?", [job])
  const reply = (id: string, thread: string, lead: string, from: string, cls: string, at: number) =>
    c.db.run('INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [`${t}-${id}`, t, thread, lead, from, 'synthetic', cls, at])
  await reply('m1', `${t}-T1`, leads.L1, 'pat@acme.example', 'positive', NOW - 50)
  await reply('m1b', `${t}-T1`, leads.L1, 'pat@acme.example', 'positive', NOW - 40) // a second positive reply in the same thread: still one deal
  await reply('m2', `${t}-T2`, leads.L2, 'sam@beta.example', 'positive', NOW - 45)
  await reply('m3', `${t}-T3`, leads.L3, 'kim@gamma.example', 'positive', NOW - 44)
  await reply('m3b', `${t}-T3`, leads.L3, 'kim@gamma.example', 'negative', NOW - 30)
  await reply('m4', `${t}-T4`, leads.L3, 'Gone@Gamma.example', 'positive', NOW - 43)
  await c.db.run("INSERT INTO suppressions (tenant_id, email, reason, created_at) VALUES (?, 'gone@gamma.example', 'unsubscribe', ?)", [t, NOW - 42])
  await reply('m5', `dazl-test-thread-${t}`, leads.L1, 'pat@acme.example', 'positive', NOW - 41)
  await reply('m6', `${t}-T6`, leads.L4, 'x@testco.example', 'positive', NOW - 41)
  await reply('m7', `${t}-T7`, leads.L3, 'lee@gamma.example', 'positive', NOW - 41)
  await c.db.run("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, followups_sent, stopped) VALUES (?, ?, ?, 'lee@gamma.example', 'root', ?, 0, 'opt_out')", [t, `${t}-T7`, leads.L3, NOW - 41])
  return { job, leads }
}

const rule = (o: Record<string, unknown>) => { const r = parseRule(o); assert.ok(r, JSON.stringify(o)); return r }

bothEngines('routing: only with a rule; qualified conversations only; first matching rule picks the owner; idempotent and audited', async c => {
  await seed(c, A)
  assert.deepEqual(await routeQualifiedConversations(c.db, A, { now: NOW }), { created: 0, assigned: 0, unassigned: 0, rules: 0 }, 'no rule: the pipeline is off for the workspace')
  assert.equal(await n(c, 'SELECT count(*) AS n FROM deals'), 0)
  assert.deepEqual(await routingTenants(c.db), [])
  assert.equal((await addRule(c.db, A, A, rule({ match_kind: 'domain', match_value: 'beta.example', owner_id: `${A}-op`, sla_hours: 24 }), { now: NOW })).ok, true)
  assert.equal((await addRule(c.db, A, A, rule({ match_kind: 'any', owner_id: A }), { now: NOW })).ok, true)
  assert.deepEqual(await routingTenants(c.db), [A])
  const r = await routeQualifiedConversations(c.db, A, { now: NOW })
  assert.deepEqual(r, { created: 2, assigned: 2, unassigned: 0, rules: 2 })
  const deals = await listDeals(c.db, A, { now: NOW })
  assert.deepEqual(deals.map(d => [d.thread_id, d.owner_id, d.stage, d.route_reason, d.title]).sort(), [[`${A}-T1`, A, 'new', 'rule', 'Acme'], [`${A}-T2`, `${A}-op`, 'new', 'rule', 'Beta']])
  const t2 = deals.find(d => d.thread_id === `${A}-T2`)!
  assert.equal(t2.sla_due_at, NOW + 24 * 3600, 'the matching rule sets the first-response SLA')
  assert.equal(t2.owner_label, `Name ${A}-op`)
  assert.equal(t2.sla_overdue, false)
  assert.equal((await listDeals(c.db, A, { now: NOW + 25 * 3600 })).find(d => d.id === t2.id)!.sla_overdue, true, 'still new past its SLA')
  assert.equal((await pipelineReport(c.db, A, { now: NOW + 25 * 3600 })).sla_overdue, 1)
  assert.deepEqual(await routeQualifiedConversations(c.db, A, { now: NOW + 1 }), { created: 0, assigned: 0, unassigned: 0, rules: 2 }, 'a replay creates nothing')
  assert.deepEqual(await routingTenants(c.db), [A], 'a cheap prefilter: unqualified positive threads keep the workspace listed, and routing them creates nothing')
  assert.equal(await n(c, "SELECT count(*) AS n FROM audit_events WHERE tenant_id = ? AND action = 'deal.routed' AND actor_kind = 'service'", [A]), 2)
  assert.equal(await n(c, "SELECT count(*) AS n FROM deal_stage_events WHERE tenant_id = ? AND kind = 'created' AND seq = 1", [A]), 2)
})

bothEngines('routing: two concurrent runs make one deal per conversation', async c => {
  await seed(c, A)
  await addRule(c.db, A, A, rule({ match_kind: 'any', owner_id: A }), { now: NOW })
  const [x, y] = await Promise.all([routeQualifiedConversations(c.db, A, { now: NOW }), routeQualifiedConversations(c.db, A, { now: NOW })])
  assert.equal(x.created + y.created, 2)
  assert.equal(await n(c, 'SELECT count(*) AS n FROM deals WHERE tenant_id = ?', [A]), 2)
  assert.equal(await n(c, 'SELECT count(*) AS n FROM deal_stage_events WHERE tenant_id = ?', [A]), 2)
}, { pgMax: 4 })

bothEngines('routing: a rule whose owner left (or is only a viewer) is skipped; no usable rule leaves the deal unassigned', async c => {
  await seed(c, A)
  assert.deepEqual(await addRule(c.db, A, A, rule({ match_kind: 'any', owner_id: `${A}-view` })), { ok: false, error: 'owner_not_member' }, 'a viewer cannot own deals')
  await addRule(c.db, A, A, rule({ match_kind: 'any', owner_id: `${A}-op` }), { now: NOW })
  await c.db.run('DELETE FROM memberships WHERE tenant_id = ? AND member_id = ?', [A, `${A}-op`])
  const r = await routeQualifiedConversations(c.db, A, { now: NOW })
  assert.deepEqual(r, { created: 2, assigned: 0, unassigned: 2, rules: 1 })
  const deals = await listDeals(c.db, A, { owner: 'none' })
  assert.equal(deals.length, 2)
  assert.ok(deals.every(d => d.route_reason === 'owner_not_member' && d.owner_label === null))
})

bothEngines('tenant isolation: another workspace cannot see, change, route into or assign to this one', async c => {
  const a = await seed(c, A)
  await seed(c, B)
  await addRule(c.db, A, A, rule({ match_kind: 'any', owner_id: A }), { now: NOW })
  assert.deepEqual(await addRule(c.db, B, B, rule({ match_kind: 'any', owner_id: A })), { ok: false, error: 'owner_not_member' }, "B cannot route to A's member")
  assert.deepEqual(await addRule(c.db, B, B, rule({ match_kind: 'play', match_value: a.job, owner_id: B })), { ok: false, error: 'bad_request' }, "B cannot name A's play")
  assert.deepEqual(await routeQualifiedConversations(c.db, B, { now: NOW }), { created: 0, assigned: 0, unassigned: 0, rules: 0 }, "A's rules never route B's conversations")
  await routeQualifiedConversations(c.db, A, { now: NOW })
  const [d] = await listDeals(c.db, A)
  const before = JSON.stringify(await c.db.all('SELECT * FROM deals ORDER BY id'))
  assert.deepEqual(await listDeals(c.db, B), [])
  assert.equal(await getDeal(c.db, B, d.id), null)
  assert.deepEqual(await changeDeal(c.db, B, B, d.id, d.version, { stage: 'qualified' }), { ok: false, error: 'not_found' })
  assert.deepEqual(await changeDeal(c.db, A, A, d.id, d.version, { owner_id: B }), { ok: false, error: 'owner_not_member' }, "A cannot assign to B's member")
  const [rr] = await listRules(c.db, A)
  assert.equal(await deactivateRule(c.db, B, B, rr.id), false)
  assert.equal(JSON.stringify(await c.db.all('SELECT * FROM deals ORDER BY id')), before, "A's deals unchanged")
  assert.equal((await pipelineReport(c.db, B, { now: NOW })).deals, 0)
})

bothEngines('stages: audited moves, won needs amount and reason, closed deals are frozen until reopened, stale edits refused', async c => {
  await seed(c, A)
  await addRule(c.db, A, A, rule({ match_kind: 'any', owner_id: A }), { now: NOW })
  await routeQualifiedConversations(c.db, A, { now: NOW })
  const d = (await listDeals(c.db, A)).find(x => x.thread_id === `${A}-T1`)!
  let v = d.version
  const step = async (ch: Parameters<typeof changeDeal>[5], at: number) => { const r = await changeDeal(c.db, A, `${A}-op`, d.id, v, ch, { now: at }); assert.ok(r.ok, JSON.stringify(r)); v = r.deal.version; return r.deal }
  await step({ stage: 'qualified' }, NOW + 10)
  await step({ stage: 'meeting', owner_id: `${A}-op` }, NOW + 20)
  assert.deepEqual(await changeDeal(c.db, A, A, d.id, v - 1, { stage: 'proposal' }, { now: NOW + 25 }), { ok: false, error: 'conflict' }, 'a stale version is refused, never merged')
  assert.deepEqual(await changeDeal(c.db, A, A, d.id, v, { stage: 'won', close_reason: 'fit' }, { now: NOW + 26 }), { ok: false, error: 'amount_required' })
  await step({ stage: 'proposal', amount_minor: 1_250_000, currency: 'usd' }, NOW + 30)
  assert.deepEqual(await changeDeal(c.db, A, A, d.id, v, { stage: 'won' }, { now: NOW + 31 }), { ok: false, error: 'reason_required' })
  assert.deepEqual(await changeDeal(c.db, A, A, d.id, v, { stage: 'won', close_reason: 'competitor' }, { now: NOW + 31 }), { ok: false, error: 'bad_reason' }, 'competitor is a lost reason')
  const won = await step({ stage: 'won', close_reason: 'fit', close_note: 'signed' }, NOW + 40)
  assert.equal(won.closed_at, NOW + 40); assert.equal(won.currency, 'USD')
  assert.deepEqual(await changeDeal(c.db, A, A, d.id, v, { amount_minor: 1 }, { now: NOW + 41 }), { ok: false, error: 'bad_transition' }, 'a closed deal is frozen')
  assert.deepEqual(await changeDeal(c.db, A, A, d.id, v, { stage: 'lost', close_reason: 'price' }, { now: NOW + 41 }), { ok: false, error: 'bad_transition' }, 'won -> lost needs a reopen first')
  const reopened = await step({ stage: 'negotiation' }, NOW + 50)
  assert.equal(reopened.close_reason, null); assert.equal(reopened.closed_at, null)
  await step({ stage: 'lost', close_reason: 'competitor' }, NOW + 60)
  const g = (await getDeal(c.db, A, d.id))!
  assert.deepEqual(g.history.map(e => [e.seq, e.kind, e.from_stage, e.stage]), [
    [1, 'created', null, 'new'], [2, 'changed', 'new', 'qualified'], [3, 'changed', 'qualified', 'meeting'], [4, 'changed', 'meeting', 'proposal'],
    [5, 'closed', 'proposal', 'won'], [6, 'reopened', 'won', 'negotiation'], [7, 'closed', 'negotiation', 'lost']])
  assert.equal(g.deal.version, 7)
  // historical stages are reconstructable from the history alone
  assert.equal(stateAt(g.history, NOW - 1), null)
  assert.deepEqual([NOW, NOW + 15, NOW + 45, NOW + 55, NOW + 99].map(t => stateAt(g.history, t)?.stage), ['new', 'qualified', 'won', 'negotiation', 'lost'])
  assert.equal(stateAt(g.history, NOW + 45)?.amount_minor, 1_250_000)
  assert.equal(await n(c, "SELECT count(*) AS n FROM audit_events WHERE tenant_id = ? AND resource_type = 'deal' AND resource_id = ? AND action IN ('deal.changed', 'deal.closed', 'deal.reopened')", [A, d.id]), 6)
  await assert.rejects(c.db.run("UPDATE deal_stage_events SET stage = 'won' WHERE deal_id = ?", [d.id]), /append-only/, 'history cannot be rewritten')
})

bothEngines('report: one count per canonical deal, money per currency, rebuilt as of any time and reconciled with the deals table', async c => {
  await seed(c, A)
  await addRule(c.db, A, A, rule({ match_kind: 'domain', match_value: 'beta.example', owner_id: `${A}-op`, sla_hours: 1 }), { now: NOW })
  await routeQualifiedConversations(c.db, A, { now: NOW })
  const deals = await listDeals(c.db, A)
  const t1 = deals.find(x => x.thread_id === `${A}-T1`)!, t2 = deals.find(x => x.thread_id === `${A}-T2`)!
  assert.equal(t1.owner_id, null, 'no rule matched acme.example'); assert.equal(t1.route_reason, 'no_matching_rule')
  let r = await changeDeal(c.db, A, A, t1.id, 1, { amount_minor: 500_00, currency: 'EUR' }, { now: NOW + 100 }); assert.ok(r.ok)
  r = await changeDeal(c.db, A, A, t1.id, 2, { stage: 'won', close_reason: 'price' }, { now: NOW + 200 }); assert.ok(r.ok)
  r = await changeDeal(c.db, A, A, t2.id, 1, { amount_minor: 300_00, currency: 'USD', stage: 'proposal' }, { now: NOW + 150 }); assert.ok(r.ok)
  const now = await pipelineReport(c.db, A, { now: NOW + 7200 })
  assert.equal(now.deals, 2)
  assert.equal(now.by_stage.reduce((s, x) => s + x.deals, 0), now.deals, 'stage counts sum to the deal total: nothing double counted')
  assert.deepEqual(now.won, { deals: 1, amounts: { EUR: 500_00 }, by_reason: { price: 1 } })
  assert.deepEqual(now.open, { deals: 1, unassigned: 0, amounts: { USD: 300_00 }, without_amount: 0 })
  assert.deepEqual(now.reconciliation, { checked: true, deals_table: 2, mismatched: 0 })
  assert.equal(now.sla_overdue, 0, 'the SLA deal left the new stage')
  assert.equal(now.cohorts.length, 1); assert.equal(now.cohorts[0].deals, 2); assert.deepEqual(now.cohorts[0].won_amounts, { EUR: 500_00 })
  assert.ok(now.definitions.attribution.includes('no causal claim'))
  const past = await pipelineReport(c.db, A, { asOf: NOW + 120, now: NOW + 7200 })
  assert.equal(past.won.deals, 0, 'as of before the close, the deal was open')
  assert.deepEqual(past.open, { deals: 2, unassigned: 1, amounts: { EUR: 500_00 }, without_amount: 1 })
  assert.equal(past.sla_overdue, 0, 'T2 was new but inside its 1h SLA')
  assert.equal(past.reconciliation.checked, false)
  // a tampered current row no longer matches its history: the report says so instead of silently trusting either
  await c.db.run('UPDATE deals SET amount_minor = 1 WHERE id = ?', [t1.id])
  assert.equal((await pipelineReport(c.db, A, { now: NOW + 7200 })).reconciliation.mismatched, 1)
})

// Pure rules, no store.
const base: Deal = { id: 'd', thread_id: 't', lead_id: 'l', title: 'x', owner_id: null, stage: 'new', amount_minor: null, currency: null, close_date: null, close_reason: null, close_note: null, rule_id: null, route_reason: 'rule', sla_due_at: null, created_at: 1, updated_at: 1, closed_at: null, version: 1 }
test('applyChange / parseChange / parseRule / pickOwner refuse anything malformed', () => {
  const owners = new Set(['m1'])
  assert.equal(applyChange(base, {}, owners, 2), 'no_change')
  assert.equal(applyChange(base, { amount_minor: 10 }, owners, 2), 'bad_currency', 'amount without currency')
  assert.equal(applyChange(base, { amount_minor: -1, currency: 'USD' }, owners, 2), 'bad_amount')
  assert.equal(applyChange(base, { amount_minor: 1.5, currency: 'USD' }, owners, 2), 'bad_amount')
  assert.equal(applyChange(base, { amount_minor: 1, currency: 'US' }, owners, 2), 'bad_currency')
  assert.equal(applyChange(base, { close_date: '2026-02-30' }, owners, 2), 'bad_date')
  assert.equal(applyChange(base, { owner_id: 'm2' }, owners, 2), 'owner_not_member')
  assert.equal(applyChange(base, { close_reason: 'fit' }, owners, 2), 'bad_transition', 'a reason without a close')
  assert.equal(applyChange(base, { stage: 'lost', close_reason: 'fit' }, owners, 2) !== 'bad_reason', true, 'fit is also a lost reason')
  assert.equal(parseChange({ stage: 'won', extra: 1 }), null)
  assert.equal(parseChange({ stage: 'archived' }), null)
  assert.equal(parseChange({ owner_id: "x' OR 1=1" }), null)
  assert.deepEqual(parseChange({ version: 3, stage: 'meeting' }), { stage: 'meeting' })
  assert.equal(parseRule({ match_kind: 'domain', match_value: 'not a domain', owner_id: 'm1' }), null)
  assert.equal(parseRule({ match_kind: 'any', owner_id: 'm1', sla_hours: 721 }), null)
  assert.equal(parseRule({ match_kind: 'everyone', owner_id: 'm1' }), null)
  const rules = [{ id: 'r1', position: 1, match_kind: 'domain' as const, match_value: 'acme.example', owner_id: 'gone', sla_hours: null, active: 1, created_by: 'x', created_at: 1 },
    { id: 'r2', position: 2, match_kind: 'domain' as const, match_value: 'acme.example', owner_id: 'm1', sla_hours: null, active: 1, created_by: 'x', created_at: 1 }]
  assert.equal(pickOwner(rules, owners, { job_id: 'j', from_email: 'a@eu.acme.example' }).rule?.id, 'r2', 'subdomain matches; a departed owner is skipped')
  assert.deepEqual(pickOwner(rules, owners, { job_id: 'j', from_email: 'a@notacme.example' }), { rule: null, reason: 'no_matching_rule' }, 'a suffix that is not a subdomain does not match')
  assert.deepEqual(pickOwner(rules.slice(0, 1), owners, { job_id: 'j', from_email: 'a@acme.example' }), { rule: null, reason: 'owner_not_member' })
})
