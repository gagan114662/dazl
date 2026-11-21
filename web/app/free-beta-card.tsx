import { FREE_BETA } from '@/lib/free-beta'

// #1428: the one plan shown at launch, on the homepage and on /pricing and /plans.
export default function FreeBetaCard() {
  return (
    <div className="lp-card p-7 max-w-md mx-auto w-full" data-testid="free-beta-card">
      <div className="text-sm font-medium text-[var(--ink-2)] mb-1">{FREE_BETA.name}</div>
      <div className="text-4xl font-semibold mb-4">{FREE_BETA.price}</div>
      <ul className="text-sm text-[var(--ink-2)] space-y-2 mb-6">
        {FREE_BETA.items.map(i => <li key={i} className="flex gap-2"><span aria-hidden className="text-[var(--ink)]">✓</span><span>{i}</span></li>)}
      </ul>
      <a href="/sign-up" className="btn-primary w-full text-center block">Start free</a>
    </div>
  )
}
