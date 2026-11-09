import type { PlanView, PlanViewNode } from '@/lib/scan/targeting'

// "How dazl reads your request": the compiled targeting plan, shown on the review step before anything runs (#876). Pure display of what the gates will
// check: each condition in plain words with its own clock, how they combine, and every ambiguity with the narrow reading chosen.
const JOIN = { and: 'ALL of these must be shown', or: 'ANY ONE of these is enough', not: 'NONE of these may apply' } as const

function Node({ n, depth }: { n: PlanViewNode; depth: number }) {
  if (n.op === 'cond') {
    return (
      <li className="min-w-0" data-testid="plan-cond" data-kind={n.kind}>
        <span className="font-medium text-[#111]">{n.id}</span>{' '}
        <span className="break-words">{n.means}</span>
        {n.window && <span className="text-[#555]"> &middot; {n.window}</span>}
        <span className="block text-xs text-[#555] break-words">Your words: &ldquo;{n.text}&rdquo;</span>
      </li>
    )
  }
  const kids = n.op === 'not' ? [n.of] : n.of
  return (
    <li className="min-w-0" data-testid="plan-group" data-op={n.op}>
      <span className="text-xs font-semibold uppercase tracking-wide text-[#555]">{n.op.toUpperCase()}</span>{' '}
      <span className="text-xs text-[#555]">{JOIN[n.op]}</span>
      <ul className={`mt-1 space-y-2 ${depth < 4 ? 'pl-3 border-l border-gray-300' : ''}`}>{kids.map((k, i) => <Node key={i} n={k} depth={depth + 1} />)}</ul>
    </li>
  )
}

export default function PlanViewCard({ plan }: { plan: PlanView | null | undefined }) {
  if (!plan) return null
  if (!plan.root) {
    return (
      <section className="mb-3 text-xs text-[#555]" data-testid="plan-view" data-empty="true" aria-label="How dazl reads your request">
        <p>How dazl reads your request: no trigger or exclusion it can check, so only the profile below applies. Nothing is added to it.</p>
        {plan.filters.length > 0 && <ul className="mt-1 space-y-1" data-testid="plan-filters">{plan.filters.map(f => <li key={f.kind} className="break-words"><span className="font-medium text-[#111]">{f.kind === 'who' ? 'Person to reach' : f.kind[0].toUpperCase() + f.kind.slice(1)}:</span> {f.values.join('; ')} <span>({f.semantics})</span></li>)}</ul>}
      </section>
    )
  }
  return (
    <section className="mb-3 rounded border border-gray-200 p-3 text-xs text-[#333]" data-testid="plan-view" aria-label="How dazl reads your request">
      <h3 className="text-sm font-semibold text-[#111] mb-1">How dazl reads your request</h3>
      <p className="text-[#555] mb-2">A lead is kept only when this plan is shown true on a source for that company. Unknown is not treated as false, and nothing is broadened.</p>
      {plan.root && <ul className="space-y-2">{plan.root.op === 'cond' ? <Node n={plan.root} depth={0} /> : <Node n={plan.root} depth={0} />}</ul>}
      {plan.filters.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="plan-filters">
          {plan.filters.map(f => <li key={f.kind} className="break-words"><span className="font-medium text-[#111]">{f.kind === 'who' ? 'Person to reach' : f.kind[0].toUpperCase() + f.kind.slice(1)}:</span> {f.values.join('; ')} <span className="text-[#555]">({f.semantics})</span></li>)}
        </ul>
      )}
      {plan.ambiguities.length > 0 && (
        <div className="mt-2" data-testid="plan-ambiguities">
          <p className="font-medium text-[#111]">Not clear in your request. dazl took the narrowest reading:</p>
          <ul className="space-y-1 mt-1">{plan.ambiguities.map((a, i) => <li key={i} className="break-words">&ldquo;{a.text}&rdquo; could mean {a.readings.join(' or ')}. Used: <span className="font-medium">{a.chosen}</span></li>)}</ul>
        </div>
      )}
    </section>
  )
}
