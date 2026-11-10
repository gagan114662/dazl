'use client'
import { capLine, type RunEstimate } from '@/lib/scan/price-estimate'

const usd = (n: number) => `$${n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`
const range = (r: { min: number; max: number }) => r.min === r.max ? usd(r.min) : `${usd(r.min)} - ${usd(r.max)}`

// The menu shown BEFORE a scan that can spend money: each provider/source with its unit price, the projected total as a range
// with its assumptions, and the user's confirmation. A blocked estimate has no Run button, only what to change.
export default function EstimateConfirm({ est, busy, onConfirm, onCancel }: { est: RunEstimate; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const v = est.verdict
  return (
    <section className="card p-4 sm:p-5 my-4 text-sm" data-testid="estimate-confirm" data-verdict={v.ok ? 'ok' : 'blocked'} aria-label="Price estimate">
      <h2 className="font-semibold text-base">What this run will use</h2>
      <p className="text-[var(--ink-2)] text-xs mt-1">{est.payer === 'trial' ? 'Paid by the shared free trial, not billed to you.' : 'Billed to your own keys and plans.'} An estimate, not a quote or a bill.</p>
      {/* Below sm (phones, 390px) every row stacks as a labelled block, so the projected cost is on screen without scrolling the
          table sideways (#851 reviewer pixels); from sm up it is the 4-column table. */}
      <div className="mt-3 overflow-x-auto">
        <table className="block sm:table w-full text-left text-xs sm:text-sm" data-testid="estimate-rows">
          <thead className="hidden sm:table-header-group"><tr className="text-[var(--ink-3)]"><th className="pr-3 py-1 font-medium">Provider / source</th><th className="pr-3 font-medium">Unit price</th><th className="pr-3 font-medium">Expected use</th><th className="text-right font-medium">Projected</th></tr></thead>
          <tbody className="block sm:table-row-group">
            {est.rows.map(r => (
              <tr key={r.id} className="block sm:table-row border-t border-[var(--line)] align-top py-2 sm:py-0" data-testid="estimate-row" data-row={r.id}>
                <td className="block sm:table-cell sm:pr-3 sm:py-2"><span className="font-medium">{r.label}</span><br /><span className="text-[var(--ink-3)]">{r.provider}</span></td>
                <td className="block sm:table-cell sm:pr-3 sm:py-2 mt-1 sm:mt-0"><span className="sm:hidden text-[var(--ink-3)]">Unit price: </span>{r.unit_usd}</td>
                <td className="block sm:table-cell sm:pr-3 sm:py-2 mt-1 sm:mt-0"><span className="sm:hidden text-[var(--ink-3)]">Expected use: </span>{r.note}</td>
                <td className="block sm:table-cell sm:py-2 mt-1 sm:mt-0 sm:text-right sm:whitespace-nowrap" data-testid="estimate-row-usd"><span className="sm:hidden text-[var(--ink-3)]">Projected: </span><span className="font-medium sm:font-normal">{r.usd ? range(r.usd) : 'not priced'}</span>{r.capped && <><br className="hidden sm:inline" /><span className="text-[var(--ink-3)]"><span className="sm:hidden"> - </span>counts against your limit</span></>}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="block sm:table-footer-group"><tr className="flex justify-between gap-3 sm:table-row border-t border-[var(--line)] font-semibold"><td className="py-2" colSpan={3}>Projected total{est.unpriced.length ? ' (priced rows only)' : ''}</td><td className="py-2 text-right whitespace-nowrap" data-testid="estimate-total">{range(est.total)}</td></tr></tfoot>
        </table>
      </div>
      {capLine(est.cap, est.cap.capped_total) && <p className="mt-2 text-xs" data-testid="estimate-cap">{capLine(est.cap, est.cap.capped_total)}</p>}
      <p className={`mt-2 ${v.ok ? '' : 'text-red-700 font-medium'}`} role={v.ok ? 'status' : 'alert'} data-testid="estimate-verdict">{v.message}</p>
      {v.warning && <p className="mt-1 text-xs" data-testid="estimate-warning">{v.warning}</p>}
      {!v.ok && <ul className="list-disc ml-5 mt-1 text-xs" data-testid="estimate-change">{v.change.map(c => <li key={c}>{c}</li>)}</ul>}
      <details className="mt-3 text-xs"><summary className="cursor-pointer">Assumptions</summary><ul className="list-disc ml-5 mt-1" data-testid="estimate-assumptions">{est.assumptions.map(a => <li key={a}>{a}</li>)}</ul></details>
      <div className="flex flex-wrap gap-2 mt-4">
        {v.ok && <button type="button" className="btn-primary" onClick={onConfirm} disabled={busy} data-testid="estimate-confirm-run">{busy ? 'Starting...' : `Confirm and run (about ${range(est.total)})`}</button>}
        <button type="button" className="btn-ghost" onClick={onCancel} data-testid="estimate-cancel">{v.ok ? 'Cancel' : 'Change the request'}</button>
      </div>
    </section>
  )
}
