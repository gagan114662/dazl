import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateRun, compareActual, capLine } from '../lib/scan/price-estimate.ts'
import { SpendGuard, SpendRefused, PRICES_USD_PER_M, INPUT_MARGIN_TOKENS } from '../lib/llm/spend-guard.ts'

const row = (e: ReturnType<typeof estimateRun>, id: string) => e.rows.find(r => r.id === id)!

test('menu: every provider/source has a unit price and a projected range; the total is the sum of the priced rows', () => {
  const e = estimateRun({ budget: null, payer: 'you' })
  assert.ok(e.rows.every(r => r.unit_usd.length > 0 && r.provider.length > 0))
  const sum = e.rows.reduce((a, r) => ({ min: a.min + (r.usd?.min ?? 0), max: a.max + (r.usd?.max ?? 0) }), { min: 0, max: 0 })
  assert.deepEqual(e.total, sum); assert.ok(e.total.max > e.total.min && e.total.min > 0)
  assert.match(row(e, 'extraction').unit_usd, /\$3\.00 in \/ \$15\.00 out per 1M tokens/)
  assert.equal(e.verdict.ok, true); assert.match(e.verdict.message, /No dollar limit/)
  // #379: the unpriceable fallback is refused on every run, so it costs $0 and is no longer an unpriced row
  assert.ok(!e.unpriced.includes('Web-search research fallback'))
  assert.deepEqual(row(e, 'fallback_research').usd, { min: 0, max: 0 }); assert.match(row(e, 'fallback_research').note ?? '', /Never run/)
})

test('the estimate prices a model call exactly as the spend guard reserves it, so the estimate and the hard cap agree', () => {
  const e = estimateRun({ budget: { max_usd: 5 }, payer: 'you' })
  const x = row(e, 'extraction'), p = PRICES_USD_PER_M['claude-sonnet-4-5']
  const guardMax = 3 * (((30_000 + INPUT_MARGIN_TOKENS) * p.in) + 4_000 * p.out) / 1e6   // 3 calls at the worst-case size
  assert.ok(Math.abs(x.usd!.max - guardMax) < 1e-9)
  // A guard whose limit is the capped worst case admits the first worst-case call; one below the expected minimum refuses it.
  const one = (30_000 + INPUT_MARGIN_TOKENS) * p.in / 1e6 + 4_000 * p.out / 1e6
  new SpendGuard(one + 1e-9).reserve('claude-sonnet-4-5', 30_000, 4_000)
  assert.throws(() => new SpendGuard(one - 0.01).reserve('claude-sonnet-4-5', 30_000, 4_000), (err: unknown) => err instanceof SpendRefused)
  assert.ok(e.rows.filter(r => r.capped).every(r => r.kind === 'model'), 'only the rows the guard really bounds count against the limit')
})

test('over the remaining limit: blocked, with a raise-the-limit amount that clears the block', () => {
  const small = estimateRun({ budget: { max_usd: 0.02 }, payer: 'you' })
  assert.equal(small.verdict.ok, false); assert.equal(small.verdict.reason, 'over_budget')
  assert.match(small.verdict.message, /Blocked/); assert.ok(small.verdict.change.some(c => /Raise the dollar limit to at least \$/.test(c)))
  const need = small.cap.capped_total.min
  assert.equal(estimateRun({ budget: { max_usd: need + 0.01 }, payer: 'you' }).verdict.ok, true, 'raising it past the minimum unblocks the run')
  assert.equal(estimateRun({ budget: { max_usd: 5 }, payer: 'you' }).verdict.warning, null)
  const edge = estimateRun({ budget: { max_usd: need + 0.01 }, payer: 'you' })
  assert.match(edge.verdict.warning ?? '', /may stop early/)
})

test('already-reserved spend and the operator owner cap reduce what is left', () => {
  const e = estimateRun({ budget: { max_usd: 1 }, payer: 'you', reservedUsd: 0.95 })
  assert.equal(e.verdict.ok, false); assert.ok(Math.abs(e.cap.remaining_usd! - 0.05) < 1e-9); assert.match(e.verdict.message, /already reserved/)
  const o = estimateRun({ budget: null, payer: 'you', ownerCapUsd: 0.02 })
  assert.equal(o.verdict.ok, false); assert.equal(o.cap.max_usd, 0.02, 'the tighter of the two limits applies')
})

test('switches remove their rows from the total: judge off, first-scan mode, enrichment off under a limit, research refused', () => {
  const on = estimateRun({ budget: null, payer: 'you', enrichmentVendors: ['apollo', 'pdl'], env: { DAZL_PRICE_APOLLO_CREDIT_USD: '0.1' } })
  const off = estimateRun({ budget: { judge: false }, payer: 'you' })
  assert.deepEqual(row(off, 'judge').usd, { min: 0, max: 0 }); assert.ok(row(on, 'judge').usd!.max > 0)
  assert.equal(row(on, 'apollo_credits').usd!.max, 0.8); assert.equal(row(on, 'pdl_credits').usd, null, 'a credit with no price set is listed as not priced')
  assert.deepEqual(row(estimateRun({ budget: { max_usd: 5 }, payer: 'you', enrichmentVendors: ['apollo'] }), 'apollo_credits').usd, { min: 0, max: 0 })
  assert.deepEqual(row(estimateRun({ budget: { max_usd: 5 }, payer: 'you' }), 'fallback_research').usd, { min: 0, max: 0 })
  const first = estimateRun({ budget: { first5: true, paid_fallback: false, credit_enrichment: false }, payer: 'trial' })
  assert.ok(first.rows.some(r => r.id === 'sources_free') && !first.rows.some(r => r.id === 'tinyfish_search'))
  assert.ok(first.assumptions.some(a => /shared free trial/.test(a)) && first.payer === 'trial')
})

test('an unknown model has no listed price: its rows are unpriced, never zero', () => {
  const e = estimateRun({ budget: null, payer: 'you', model: 'mystery-model' })
  assert.equal(row(e, 'extraction').usd, null); assert.ok(e.unpriced.includes('Candidate extraction'))
})

test('ack changes when the limit or the mode changes, and is stable for the same request', () => {
  const a = estimateRun({ budget: { max_usd: 2 }, payer: 'you' }).ack
  assert.equal(estimateRun({ budget: { max_usd: 2 }, payer: 'you' }).ack, a)
  assert.notEqual(estimateRun({ budget: { max_usd: 3 }, payer: 'you' }).ack, a)
  assert.notEqual(estimateRun({ budget: { max_usd: 2, judge: false }, payer: 'you' }).ack, a)
})

test('actual vs estimate: priced from the tokens the provider reported; unknown stays unknown', () => {
  const e = estimateRun({ budget: null, payer: 'you' })
  const lo = compareActual(e, { inputTokens: 1000, outputTokens: 500, tokensComplete: true, model: 'claude-sonnet-4-5', searches: 6, reservedUsd: null })
  assert.equal(lo.within, 'under'); assert.ok(Math.abs(lo.model_usd! - (1000 * 3 + 500 * 15) / 1e6) < 1e-12); assert.match(lo.summary, /Not an invoice/)
  const mid = compareActual(e, { inputTokens: 40_000, outputTokens: 7_000, tokensComplete: false, model: 'claude-sonnet-4-5', searches: null, reservedUsd: 0.4 })
  assert.equal(mid.within, 'within'); assert.equal(mid.model_usd_complete, false); assert.match(mid.summary, /at least/)
  const none = compareActual(e, { inputTokens: null, outputTokens: null, tokensComplete: false, model: null, searches: null, reservedUsd: null })
  assert.equal(none.model_usd, null); assert.equal(none.within, 'unknown'); assert.match(none.summary, /not recorded/)
})

test('the confirmation changes with everything the person agreed to: payer, cap, reserved room, warning, rows on/off', () => {
  const base = { budget: { max_usd: 2 }, payer: 'you' as const }
  const a = estimateRun(base)
  assert.notEqual(estimateRun({ ...base, payer: 'trial' }).ack, a.ack, 'trial -> own key (or back) needs a new confirmation')
  const reserved = estimateRun({ ...base, reservedUsd: 1.5 })
  assert.notEqual(reserved.ack, a.ack, 'reserving $1.50 of a $2 cap changes the confirmation')
  assert.ok(reserved.verdict.warning && !a.verdict.warning, 'the reserved room produced a new warning, and the ack follows it')
  assert.notEqual(estimateRun({ ...base, reservedUsd: 0.5 }).ack, a.ack, 'any change in the reserved amount')
  assert.notEqual(estimateRun({ budget: { max_usd: 3 }, payer: 'you' }).ack, a.ack, 'a different limit')
  assert.notEqual(estimateRun({ ...base, ownerCapUsd: 1 }).ack, a.ack, 'a tighter operator cap')
  assert.notEqual(estimateRun({ budget: { max_usd: 2, judge: false }, payer: 'you' }).ack, a.ack, 'a row switched off')
  assert.notEqual(estimateRun({ ...base, enrichmentVendors: ['apollo'] }).ack, a.ack, 'another provider in the menu')
  assert.equal(estimateRun({ ...base }).ack, a.ack, 'identical inputs give the same confirmation (deterministic)')
  assert.equal(estimateRun({ ...base, reservedUsd: 0.00001 }).ack, a.ack, 'sub-cent float noise does not invalidate it')
})

test('monthly pool: the room left is the tighter of day and month, unknown pool state refuses, and the confirmation covers month cap, month reserved and unknown', () => {
  const base = { budget: { max_usd: 2 } as const, payer: 'you' as const }
  const none = estimateRun({ ...base })
  const month = estimateRun({ ...base, ownerMonthCapUsd: 3, reservedMonthUsd: 2.99 })
  assert.ok(month.cap.remaining_usd !== null && month.cap.remaining_usd < 0.02); assert.equal(month.verdict.ok, false); assert.equal(month.verdict.reason, 'over_budget'); assert.match(month.verdict.message, /monthly limit/)
  assert.equal(estimateRun({ ...base, ownerMonthCapUsd: 10, reservedMonthUsd: 1 }).cap.remaining_usd, 2, 'the day limit is tighter')
  assert.notEqual(estimateRun({ ...base, ownerMonthCapUsd: 3, reservedMonthUsd: 1 }).ack, estimateRun({ ...base, ownerMonthCapUsd: 3, reservedMonthUsd: 1.2 }).ack)
  assert.notEqual(estimateRun({ ...base, ownerMonthCapUsd: 3 }).ack, none.ack)
  const u = estimateRun({ ...base, poolUnknown: true })
  assert.equal(u.verdict.ok, false); assert.equal(u.verdict.reason, 'budget_unknown'); assert.equal(u.cap.unknown, true); assert.doesNotMatch(u.verdict.message, /Within your limit/); assert.notEqual(u.ack, none.ack)
})

test('NEGATIVE: an unreadable budget shows "Remaining: unknown", never $0.00 left', () => {
  const e = estimateRun({ budget: { max_usd: 2 }, payer: 'you', poolUnknown: true })
  assert.equal(e.cap.remaining_usd, null); assert.equal(e.cap.binding, null)
  const line = capLine(e.cap, e.cap.capped_total)!
  assert.match(line, /Remaining: unknown/); assert.doesNotMatch(line, /\$0\.00/); assert.doesNotMatch(line, /left/)
  const m = estimateRun({ budget: null, payer: 'you', ownerMonthCapUsd: 3, poolUnknown: true })   // monthly-only cap, unreadable
  assert.match(capLine(m.cap, m.cap.capped_total)!, /Monthly limit: \$3\.00; Remaining: unknown/); assert.doesNotMatch(capLine(m.cap, m.cap.capped_total)!, /\$0\.00/)
})
test('monthly constraint: daily and monthly limits are labelled with their own reserved amounts and the binding remaining amount names which one binds', () => {
  const m = estimateRun({ budget: { max_usd: 2 }, payer: 'you', reservedUsd: 0.5, ownerMonthCapUsd: 3, reservedMonthUsd: 2.4 })
  assert.equal(m.cap.binding, 'monthly'); assert.ok(Math.abs((m.cap.remaining_usd ?? 0) - 0.6) < 1e-9)
  assert.match(capLine(m.cap, m.cap.capped_total)!, /^Daily limit: \$2\.00 \(\$0\.50 already reserved today\); Monthly limit: \$3\.00 \(\$2\.40 already reserved this month\); \$0\.60 left \(monthly limit binds\)\./)
  const d = estimateRun({ budget: { max_usd: 2 }, payer: 'you', reservedUsd: 1.9, ownerMonthCapUsd: 30, reservedMonthUsd: 1 })
  assert.equal(d.cap.binding, 'daily'); assert.match(capLine(d.cap, d.cap.capped_total)!, /\$0\.10 left \(daily limit binds\)/)
  assert.equal(capLine(estimateRun({ budget: null, payer: 'you' }).cap, { min: 0, max: 0 }), null)
})
