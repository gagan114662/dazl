// #1319 (Quest live check, prod 0bb5630, 2026-11-21): two cost lines contradicted themselves.
// 1. The run page read "Estimated $0.09 - $2.81 at start" and, in the same paragraph, "against an estimate of $0.09-$0.66": the second is
//    the MODEL part only and must say so.
// 2. The cost panel read "$3.33 left (daily limit binds)" when the run's own per-run limit was what bound the amount left.
import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateRun, compareActual, capLine } from '../lib/scan/price-estimate.ts'

test('the actual-vs-estimate line names the model estimate it compares against, never a bare "estimate"', () => {
  const est = estimateRun({ budget: { max_usd: 5 }, payer: 'you' })
  const priced = compareActual(est, { inputTokens: 20_000, outputTokens: 2_000, tokensComplete: true, model: 'claude-sonnet-4-5', searches: 3, reservedUsd: 0, requests: 4, requestsWithTokens: 4, cacheWriteTokens: 0, cacheReadTokens: 0 })
  assert.match(priced.summary, /against the model-request estimate of \$\d/)
  assert.doesNotMatch(priced.summary, /against an estimate of/)
  for (const a of [
    { inputTokens: null, outputTokens: null, tokensComplete: false, searches: 0, reservedUsd: 0, requests: 0, refusedBeforeSending: 2 },
    { inputTokens: null, outputTokens: null, tokensComplete: false, searches: 0, reservedUsd: 0, requests: 2, requestsWithTokens: 0 },
    { inputTokens: null, outputTokens: null, tokensComplete: false, searches: 0, reservedUsd: 0, requests: 0 },
  ]) {
    const s = compareActual(est, a).summary
    assert.match(s, /model-request estimate/, s)
    assert.doesNotMatch(s, /(?<!model-request )\b[Ee]stimate (was|\$)/, s)
  }
})

test('the amount left names the per-run limit when that is what binds, not the daily limit', () => {
  // the live shape: a $3.33 per-run limit under a larger daily limit with room left
  const run = estimateRun({ budget: { max_usd: 3.33 }, payer: 'you', ownerCapUsd: 10, reservedUsd: 1 })
  assert.ok(Math.abs((run.cap.remaining_usd ?? 0) - 3.33) < 1e-9)
  assert.equal(run.cap.binding, 'run')
  assert.match(capLine(run.cap, run.cap.capped_total)!, /\$3\.33 left \(this run's limit binds\)/)
  assert.doesNotMatch(capLine(run.cap, run.cap.capped_total)!, /daily limit binds/)
  // the daily limit still binds when its room is the smaller one
  const day = estimateRun({ budget: { max_usd: 3.33 }, payer: 'you', ownerCapUsd: 2, reservedUsd: 1 })
  assert.equal(day.cap.binding, 'daily'); assert.match(capLine(day.cap, day.cap.capped_total)!, /\$1\.00 left \(daily limit binds\)/)
  // a tie names the daily limit; a tighter month still names the month
  assert.equal(estimateRun({ budget: { max_usd: 1 }, payer: 'you', ownerCapUsd: 2, reservedUsd: 1 }).cap.binding, 'daily')
  assert.equal(estimateRun({ budget: { max_usd: 3.33 }, payer: 'you', ownerCapUsd: 10, reservedUsd: 1, ownerMonthCapUsd: 5, reservedMonthUsd: 4 }).cap.binding, 'monthly')
})

test('when the run limit binds under a day cap, the verdict names the run limit, not the day limit and its reservations', () => {
  const e = estimateRun({ budget: { max_usd: 0.01 }, payer: 'you', ownerCapUsd: 10, reservedUsd: 1 })
  assert.equal(e.verdict.ok, false)
  assert.match(e.verdict.message, /only \$0\.01 of your \$0\.01 limit is left\.$/)
  assert.doesNotMatch(e.verdict.message, /\$10\.00|already reserved/)
  assert.ok(e.verdict.change.some(c => /^Raise the dollar limit to at least \$0\.0\d /.test(c)), e.verdict.change.join(' | '))
})

test('when the run limit binds and the day room is also short, the change list names the day room too', () => {
  const e = estimateRun({ budget: { max_usd: 0.05 }, payer: 'you', ownerCapUsd: 10, reservedUsd: 9.93 })
  assert.equal(e.verdict.ok, false); assert.equal(e.cap.binding, 'run')
  const min = e.cap.capped_total.min
  assert.ok(min > 0.07, 'the model minimum is above the day room')
  assert.ok(e.verdict.change.some(c => /daily limit has only \$0\.07 left today/.test(c)), e.verdict.change.join(' | '))
  // following the run-limit advice alone is not enough here, and the list says so
  assert.equal(estimateRun({ budget: { max_usd: min }, payer: 'you', ownerCapUsd: 10, reservedUsd: 9.93 }).verdict.ok, false)
  // with day room to spare the extra line is absent
  assert.ok(!estimateRun({ budget: { max_usd: 0.01 }, payer: 'you', ownerCapUsd: 10, reservedUsd: 1 }).verdict.change.some(c => /daily limit has only/.test(c)))
})

test('a run that is never offered the run-limit raise is not told that raise is not enough', () => {
  const e = estimateRun({ budget: { max_usd: 0.05 }, payer: 'you', companyFirst: true, ownerCapUsd: 10, reservedUsd: 9.93 })
  assert.equal(e.verdict.ok, false)
  const raise = e.verdict.change.some(c => /^Raise the dollar limit/.test(c))
  assert.equal(e.verdict.change.some(c => /raising this run's limit/.test(c)), raise, e.verdict.change.join(' | '))
})

// Quest (#1319): max_usd is the limit for that one run (spend-cap.ts effectiveCapUsd, reserved on the job's own row), and every account has a
// daily cap the transport enforces (runner.ts runWithScanSpend: accountLimits(owner), reserved on tenant_spend_pools). The screen shows both,
// read from the same source, so every number on it matches what actually stops a run.
import Database from 'better-sqlite3'
import { asDb } from '../lib/db/client.ts'
import { estimateForBody } from '../lib/scan/estimate-request.ts'
import { accountLimits, migrateSpendPools, periodOf } from '../lib/llm/spend-pool.ts'

async function serverEstimate(env: Record<string, string | undefined>, reservedToday: number, opts: { budget?: unknown; vendors?: string[]; reservedMonth?: number } = {}) {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k] }
  try {
    const raw = new Database(':memory:'); migrateSpendPools(raw)
    const now = Math.floor(Date.now() / 1000)
    if (reservedToday > 0) raw.prepare('INSERT INTO tenant_spend_pools (tenant_id, period, reserved_usd, calls, reported_usd, updated_at) VALUES (?, ?, ?, 0, 0, ?)').run('t-unnamed', periodOf('day', now), reservedToday, now)
    if (opts.reservedMonth) raw.prepare('INSERT INTO tenant_spend_pools (tenant_id, period, reserved_usd, calls, reported_usd, updated_at) VALUES (?, ?, ?, 0, 0, ?)').run('t-unnamed', periodOf('month', now), opts.reservedMonth, now)
    const body = { query: 'B2B SaaS startups in Toronto hiring a first SDR', ...('budget' in opts ? (opts.budget === undefined ? {} : { budget: opts.budget }) : { budget: { max_usd: 3.33 } }) }
    const r = await estimateForBody(body, { db: asDb(raw), tenantId: 't-unnamed', hasOwnKey: true, enrichmentVendors: opts.vendors ?? [], model: 'claude-sonnet-4-5' })
    assert.ok(r.ok, JSON.stringify(r))
    return { est: r.ok ? r.estimate : null!, day: accountLimits('t-unnamed').day, month: accountLimits('t-unnamed').month }
  } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } }
}

test('an account the operator did not name: the run limit and the enforced daily cap are both shown, each as itself', async () => {
  const { est, day } = await serverEstimate({ DAZL_OWNER_DAY_MAX_USD: undefined, DAZL_RUN_MAX_USD_USERS: undefined }, 1)
  assert.equal(est.cap.max_usd, day, 'the daily cap shown is the one the transport enforces')
  const line = capLine(est.cap, est.cap.capped_total)!
  assert.match(line, /^This run's limit: \$3\.33; Daily limit: \$\d+\.\d\d \(\$1\.00 already reserved today\);/)
  assert.match(line, /\$3\.33 left \(this run's limit binds\)/)
})

test('the daily cap shown follows the deployment setting the transport reads, and binds when it is the tighter', async () => {
  const { est, day } = await serverEstimate({ DAZL_OWNER_DAY_MAX_USD: '4', DAZL_RUN_MAX_USD_USERS: undefined }, 2)
  assert.equal(day, 4); assert.equal(est.cap.max_usd, 4)
  assert.match(capLine(est.cap, est.cap.capped_total)!, /^This run's limit: \$3\.33; Daily limit: \$4\.00 \(\$2\.00 already reserved today\);.*\$2\.00 left \(daily limit binds\)/)
})

test('with no daily cap known to the estimate, a run limit is never called a daily limit nor charged the day\'s reservations', () => {
  const e = estimateRun({ budget: { max_usd: 1 }, payer: 'you', reservedUsd: 0.95 })
  assert.ok(Math.abs((e.cap.remaining_usd ?? 0) - 1) < 1e-9); assert.equal(e.cap.binding, 'run')
  const line = capLine(e.cap, e.cap.capped_total)!
  assert.match(line, /^This run's limit: \$1\.00; \$1\.00 left \(this run's limit binds\)\./); assert.doesNotMatch(line, /[Dd]aily|reserved today/)
})

// Council: the caps shown never change what the run does. Bring-your-own enrichment is switched off only by what switches it off in the
// runner (runner.ts: a run limit, a named account or a trial), so an unnamed account's unlimited run still shows it on.
const ALL_OFF = { DAZL_OWNER_DAY_MAX_USD: undefined, DAZL_OWNER_MONTH_MAX_USD: undefined, DAZL_RUN_MAX_USD_USERS: undefined, DAZL_OWNER_MONTH_MAX_USD_USERS: undefined }
test('an unnamed account with no run limit: its own enrichment row stays on, as the run does it', async () => {
  const { est } = await serverEstimate({ ...ALL_OFF, DAZL_PAID_VENDORS: 'apollo' }, 0, { budget: undefined, vendors: ['apollo'] })
  const row = est.rows.find(r => r.id === 'apollo_credits')
  assert.ok(row, 'the apollo row is listed'); assert.ok(row!.units.max > 0, JSON.stringify(row)); assert.doesNotMatch(row!.note, /^Off/)
  // a run limit switches it off, as in the runner
  const limited = (await serverEstimate({ ...ALL_OFF, DAZL_PAID_VENDORS: 'apollo' }, 0, { vendors: ['apollo'] })).est.rows.find(r => r.id === 'apollo_credits')
  assert.equal(limited!.units.max, 0)
})

test('the month window shown is the one the transport enforces, and binds when tighter', async () => {
  const { est, month } = await serverEstimate({ ...ALL_OFF, DAZL_OWNER_MONTH_MAX_USD: '5' }, 0, { reservedMonth: 4 })
  assert.equal(month, 5); assert.equal(est.cap.month_cap_usd, 5); assert.equal(est.cap.binding, 'monthly')
  assert.match(capLine(est.cap, est.cap.capped_total)!, /Monthly limit: \$5\.00 \(\$4\.00 already reserved this month\); \$1\.00 left \(monthly limit binds\)/)
})

test('a run with no limit of its own is blocked when the enforced daily cap has too little room', async () => {
  const { est, day } = await serverEstimate(ALL_OFF, 0, { budget: undefined })
  const tight = await serverEstimate(ALL_OFF, day - 0.01, { budget: undefined })
  assert.equal(est.verdict.ok, true)
  assert.equal(tight.est.verdict.ok, false); assert.equal(tight.est.cap.binding, 'daily')
  assert.match(tight.est.verdict.message, /only \$0\.01\d* of your \$\d+\.\d\d limit is left/)
})

// Council: "This run's limit" is what stops the run: the job guard's cap, min(scan cap, max_usd, hard cap) (spend-cap.ts effectiveCapUsd),
// never the raw max_usd; and a run with no max_usd of its own still has that cap.
import { HARD_CAP_USD, scanCapConfig } from '../lib/scan/spend-cap.ts'
test('the run limit shown is the cap the job guard enforces, with or without a max_usd', async () => {
  const sc = scanCapConfig(); assert.ok(sc.ok)
  const enforced = (m: number) => Math.min(m, sc.ok ? sc.capUsd : 0, HARD_CAP_USD)
  const high = (await serverEstimate(ALL_OFF, 0, { budget: { max_usd: 10 } })).est
  assert.ok(Math.abs((high.cap.run_max_usd ?? 0) - enforced(10)) < 1e-9, String(high.cap.run_max_usd))
  assert.ok(capLine(high.cap, high.cap.capped_total)!.startsWith(`This run's limit: $${enforced(10).toFixed(2)};`), capLine(high.cap, high.cap.capped_total)!)
  const none = (await serverEstimate(ALL_OFF, 0, { budget: undefined })).est
  assert.ok(Math.abs((none.cap.run_max_usd ?? 0) - enforced(Infinity)) < 1e-9, String(none.cap.run_max_usd))
})

// Council: only the run's own limit can be raised by the person; an account window that binds is named, with when it resets.
test('when the daily or monthly cap binds, the change list names that window and its reset, not a dollar limit to raise', async () => {
  const { est, day } = await serverEstimate(ALL_OFF, 0, { budget: undefined })
  const tight = (await serverEstimate(ALL_OFF, day - 0.01, { budget: undefined })).est
  assert.equal(est.verdict.ok, true); assert.equal(tight.cap.binding, 'daily')
  assert.ok(!tight.verdict.change.some(c => /^Raise the/.test(c)), tight.verdict.change.join(' | '))
  assert.ok(tight.verdict.change.some(c => /^Your daily limit .* resets at 00:00 UTC\.$/.test(c)), tight.verdict.change.join(' | '))
  const month = (await serverEstimate({ ...ALL_OFF, DAZL_OWNER_MONTH_MAX_USD: '5' }, 0, { budget: undefined, reservedMonth: 4.99 })).est
  assert.equal(month.cap.binding, 'monthly')
  assert.ok(!month.verdict.change.some(c => /^Raise the/.test(c)), month.verdict.change.join(' | '))
  assert.ok(month.verdict.change.some(c => /^Your monthly limit .* resets on the 1st at 00:00 UTC\.$/.test(c)), month.verdict.change.join(' | '))
})
