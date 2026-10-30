import { test } from 'node:test'
import assert from 'node:assert/strict'
import { budgetFromForm, EMPTY_BUDGET_FORM, type BudgetForm } from '../lib/scan/run-budget-form.ts'
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
