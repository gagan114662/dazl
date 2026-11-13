import { test } from 'node:test'
import assert from 'node:assert/strict'
import { budgetFromForm, EMPTY_BUDGET_FORM, panelDisclosure, type BudgetForm } from '../lib/scan/run-budget-form.ts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalizeScanBudget } from '../lib/scan/run-budget.ts'

const f = (o: Partial<BudgetForm>): BudgetForm => ({ ...EMPTY_BUDGET_FORM, ...o })

test('form off (default): no budget at all, so the request is exactly today\'s', () => {
  assert.deepEqual(budgetFromForm(EMPTY_BUDGET_FORM), { budget: null, error: null })
  assert.deepEqual(budgetFromForm(f({ enabled: false, maxUsd: '5', noJudge: true })), { budget: null, error: null }, 'a hidden value is never sent')
})

test('form on: builds exactly the API budget object, through the API validator', () => {
  assert.deepEqual(budgetFromForm(f({ enabled: true, maxUsd: '0.50', noFallback: true, noEnrichment: true, noJudge: true })).budget, { max_usd: 0.5, paid_fallback: false, credit_enrichment: false, judge: false })
  assert.deepEqual(budgetFromForm(f({ enabled: true, maxUsd: ' 2 ' })).budget, { max_usd: 2 })
  assert.deepEqual(budgetFromForm(f({ enabled: true, noJudge: true })).budget, { judge: false })
  const b = budgetFromForm(f({ enabled: true, maxUsd: '3', noFallback: true })).budget
  assert.deepEqual(normalizeScanBudget(b, true), { ok: true, value: JSON.stringify(b), budget: b })
})

test('form on but unusable: an error and no budget (the Run button is disabled on it)', () => {
  for (const bad of ['abc', '-1', '0', '1e3', '1,5', '$5', '.', '1000.5', '5 dollars']) {
    const r = budgetFromForm(f({ enabled: true, maxUsd: bad })); assert.equal(r.budget, null, bad); assert.ok(r.error, bad)
  }
  const none = budgetFromForm(f({ enabled: true })); assert.equal(none.budget, null); assert.match(none.error!, /Set a dollar limit or tick at least one option/)
})

test('#381 the panel tells a keyless (free-trial) account no extra round, an own-key account the round (review on #1132)', () => {
  const sf = (hasKey: boolean | null) => panelDisclosure({ max_usd: 1 }, hasKey)!.surfaces.find(x => x.surface === 'search_and_fetch')!.note
  assert.doesNotMatch(sf(false), /one more round/, 'keyless: the scan runs on the free trial, which never takes the round')
  assert.match(sf(true), /one more round/)
  assert.match(sf(null), /one more round/, 'not loaded yet: the larger statement')
  assert.equal(panelDisclosure(null, true), null, 'no budget, no disclosure')
  const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
  assert.match(read('../app/app/leads/budget-panel.tsx'), /panelDisclosure\(budget, hasKey\)/, 'the panel renders this disclosure')
  assert.match(read('../app/app/leads/leads-client.tsx'), /<BudgetPanel [^>]*hasKey=\{keyState \? keyState\.has_key : null\}/, 'the leads page passes the key state it already loads')
})

// preview CI at de03f481 (#381): the disclosure named the operator switch DAZL_ADAPTIVE_DISCOVERY_ENABLED=0, one 33-character
// word a phone cannot wrap, so the leads page scrolled sideways at 390 px (test/ui/budget.ui.mjs "mobile: no horizontal
// page scroll"). Every word the budget panel shows must fit a phone line.
test('the budget disclosure has no word too long to wrap on a phone', () => {
  for (const [budget, hasKey] of [[null, null], [{ max_usd: 1 }, true], [{ max_usd: 1 }, false], [{ max_usd: 1, paid_fallback: false, judge: false }, true]] as const) {
    const d = panelDisclosure(budget as never, hasKey)
    if (!d) continue
    const words = [d.ceiling, ...d.surfaces.map(s => s.note), ...d.excluded_paths, ...d.limits].join(' ').split(/\s+/)
    assert.deepEqual(words.filter(w => w.length > 30), [], JSON.stringify(budget))
  }
})
