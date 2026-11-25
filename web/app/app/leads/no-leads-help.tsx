'use client'
import type { ScanOutcome } from '../../../lib/scan/scan-outcome.ts'

// #1726 (UI part, owner Fo): a finished scan with zero leads ended at the bare line
// "The scan finished with no leads." (prod 77e8b23, 25 Nov: "residential roofing, Calgary",
// ~50s at $0.23, 0 found / 0 checked / 0 dropped), with no reason and no next step. This
// block renders the scan outcome's own plain reason (lib/scan/scan-outcome.ts, read-only)
// and 1-2 next steps, so a zero-lead screen never shows just the bare line. Nothing is
// invented: the reason is the outcome's recorded label and detail, the actions are the
// outcome's own next step plus at most one rerun of the user's own query. No hardcoded
// companies, cities or industries.

export interface NoLeadsHelpAction { text: string; href: string }
export type NoLeadsOutcome = Pick<ScanOutcome, 'kind' | 'label' | 'detail' | 'next'>

export function noLeadsHelp(outcome: NoLeadsOutcome, opts: { query?: string | null } = {}): { reason: string; actions: NoLeadsHelpAction[] } {
  const reason = outcome.detail ? `${outcome.label}. ${outcome.detail}` : `${outcome.label}.`
  const actions: NoLeadsHelpAction[] = []
  if (outcome.next) actions.push({ text: outcome.next.text, href: outcome.next.href })
  const query = opts.query?.trim()
  if (query) {
    const rerun = { text: 'Run this search again', href: `/app/leads?q=${encodeURIComponent(query)}` }
    if (!actions.some(a => a.href === rerun.href)) actions.push(rerun)
  }
  if (actions.length === 0) actions.push({ text: 'Start a new search', href: '/app/leads' })
  return { reason, actions: actions.slice(0, 2) }
}

export function NoLeadsHelp({ outcome, query }: { outcome: NoLeadsOutcome; query?: string | null }) {
  const h = noLeadsHelp(outcome, { query })
  return (
    <div className="p-10 text-center text-sm" data-testid="no-leads-help">
      <p className="text-gray-500">{h.reason}</p>
      <div className="flex flex-wrap items-center justify-center gap-2 mt-3">
        {h.actions.map(a => <a key={a.href} className="btn-ghost btn-sm" href={a.href}>{a.text}</a>)}
      </div>
    </div>
  )
}
