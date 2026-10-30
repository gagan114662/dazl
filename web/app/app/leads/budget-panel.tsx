'use client'
import { budgetFromForm, type BudgetForm } from '@/lib/scan/run-budget-form'
import { describeRunBudget } from '@/lib/scan/run-budget'

// Optional spend limit for one run. Everything the limit does NOT cover is shown BEFORE the user presses Run, from the same
// describeRunBudget the server answers with. It is a partial reservation limit, never a whole-scan dollar ceiling.
export default function BudgetPanel({ form, setForm }: { form: BudgetForm; setForm: (f: BudgetForm) => void }) {
  const { budget, error } = budgetFromForm(form)
  const d = budget ? describeRunBudget(budget) : null
  const set = (patch: Partial<BudgetForm>) => setForm({ ...form, ...patch })
  return (
    <div className="border border-black/20 p-3 mb-3 text-xs" data-testid="budget-panel">
      <label className="flex items-center gap-2 font-medium">
        <input type="checkbox" checked={form.enabled} onChange={e => set({ enabled: e.target.checked })} /> Limit what this run may spend (optional)
      </label>
      {form.enabled && (
        <div className="mt-2 space-y-2">
          <label className="block">Dollar limit for the model requests dazl sends
            <input data-testid="budget-max-usd" className="field ml-2 w-28" inputMode="decimal" placeholder="e.g. 0.50" value={form.maxUsd} onChange={e => set({ maxUsd: e.target.value })} />
          </label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.noFallback} onChange={e => set({ noFallback: e.target.checked })} /> No paid web-search research fallback</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.noEnrichment} onChange={e => set({ noEnrichment: e.target.checked })} /> No bring-your-own enrichment credits</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.noJudge} onChange={e => set({ noJudge: e.target.checked })} /> Skip the verification judge</label>
          {error && <p className="text-red-700" data-testid="budget-error">{error}</p>}
          {d && (
            <div className="bg-black/5 p-2" data-testid="budget-disclosure">
              <p className="font-medium">What this limit covers - read before you run</p>
              <p>{d.ceiling}</p>
              <ul className="list-disc ml-4 mt-1">
                {d.surfaces.map(s => <li key={s.surface}><b>{s.surface.replace(/_/g, ' ')}</b>: {s.status.replace('_', ' ')} - {s.note}</li>)}
              </ul>
              <p className="font-medium mt-2">Not covered by this limit</p>
              <ul className="list-disc ml-4">{d.excluded_paths.map(x => <li key={x}>{x}</li>)}</ul>
              <ul className="list-disc ml-4 mt-1">{d.limits.map(x => <li key={x}>{x}</li>)}</ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
