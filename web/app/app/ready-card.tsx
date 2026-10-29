'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { readyComplete, readyItems, type ReadyItem } from '@/lib/ready-card'
import { loadReadinessInput } from './readiness-input'

// Home's setup checklist toward the first useful result (lib/ready-card.ts). Each step still to do has one button straight
// to its fix (secondary: Home keeps one primary action; the next step is marked by its dark dot). Read-only; gone once
// every step is done.
export default function ReadyCard() {
  const [items, setItems] = useState<ReadyItem[] | null>(null)
  useEffect(() => {
    const load = () => void loadReadinessInput().then(({ input }) => setItems(readyItems(input)))
    load()
    window.addEventListener('profile-updated', load)
    return () => window.removeEventListener('profile-updated', load)
  }, [])
  if (!items || readyComplete(items)) return null
  const done = items.filter(x => x.state === 'done').length
  return (
    <section className="card p-5 sm:p-6 mb-6" data-testid="ready-card" aria-labelledby="rc-title">
      <div className="flex items-center justify-between gap-3">
        <h2 id="rc-title" className="text-lg font-bold tracking-tight">Get to your first useful result</h2>
        <span className="text-sm font-semibold text-[var(--ink-2)] shrink-0" data-testid="rc-progress">{done} of {items.length} done</span>
      </div>
      <ul className="rc-grid mt-4">
        {items.map((x, n) => (
          <li key={x.id} className="rc-item" data-testid={`rc-${x.id}`} data-rc-state={x.state} data-rc-next={x.next ? 'true' : undefined}>
            <span aria-hidden className={`rc-dot ${x.state === 'done' ? 'rc-dot-done' : x.next ? 'rc-dot-next' : ''}`}>{x.state === 'done' ? '✓' : x.state === 'unknown' ? '?' : n + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-sm">{x.label}<span className="sr-only">{x.state === 'done' ? ' (done)' : x.state === 'unknown' ? ' (could not check)' : x.next ? ' (next step)' : ' (to do)'}</span></div>
              <div className="text-xs text-[var(--ink-2)] mt-0.5 break-words line-clamp-2" title={x.detail}>{x.detail}</div>
            </div>
            {x.fix && (x.fix.href.includes('?setup=')
              // The setup steps read ?setup= once, on load, so that link loads the page.
              ? <a href={x.fix.href} className="btn-ghost btn-sm shrink-0">{x.fix.label}</a>
              : <Link href={x.fix.href} className="btn-ghost btn-sm shrink-0">{x.fix.label}</Link>)}
          </li>
        ))}
      </ul>
    </section>
  )
}
