'use client'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { readyComplete, readyItems, type ReadyItem } from '@/lib/ready-card'
import { loadReadinessInput } from './readiness-input'

// Home's setup checklist toward the first useful result (lib/ready-card.ts). Each step still to do has one button straight
// to its fix (secondary: Home keeps one primary action; the next step is marked by its dark dot). Read-only; gone once
// every step is done.
export default function ReadyCard() {
  const seqRef = useRef(0)
  const [items, setItems] = useState<ReadyItem[] | null>(null)
  useEffect(() => {
    // #1722: overlapping loads apply in start order, so a slow earlier read cannot revert the sender status.
    const load = () => { const seq = ++seqRef.current; void loadReadinessInput().then(({ input }) => { if (seq === seqRef.current) setItems(readyItems(input)) }) }
    load()
    window.addEventListener('profile-updated', load)
    // #1722: the sender status can change in another tab; re-read when this tab is used again.
    const wake = () => { if (!document.hidden) load() }
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
    return () => { window.removeEventListener('profile-updated', load); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake) }
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
            {x.alt && <Link href={x.alt.href} className="btn-ghost btn-sm shrink-0" data-testid={`rc-${x.id}-alt`}>{x.alt.label}</Link>}
            {x.fix && (x.fix.href.startsWith('/api/')
              // #1319: Link Google is a full-page round trip to Google (never a client-side route), and the main way forward
              ? <a href={x.fix.href} className={`${x.fix.primary ? 'btn-primary' : 'btn-ghost'} btn-sm shrink-0`} data-testid={`rc-${x.id}-fix`}>{x.fix.label}</a>
              : x.fix.href.includes('?setup=')
              // The setup steps read ?setup= once, on load, so that link loads the page.
              ? <a href={x.fix.href} className="btn-ghost btn-sm shrink-0">{x.fix.label}</a>
              : <Link href={x.fix.href} className="btn-ghost btn-sm shrink-0">{x.fix.label}</Link>)}
          </li>
        ))}
      </ul>
    </section>
  )
}
