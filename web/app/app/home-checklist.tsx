'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { homeSources, homeSteps } from '@/lib/home-checklist'
import type { ReadinessInput } from '@/lib/readiness'
import type { SourceProgress } from '@/lib/scan/progress'
import { loadReadinessInput } from './readiness-input'

// Home's five steps from website to first sent email, each linking to where it is done, from the tenant's real state.
// Read-only. Hidden once all five are done; the full setup checklist stays in "Setup details".
export default function HomeChecklist() {
  const [input, setInput] = useState<ReadinessInput | null>(null)
  const [lastRun, setLastRun] = useState<SourceProgress[] | null>(null)
  useEffect(() => {
    const load = async () => {
      const { input: next } = await loadReadinessInput()
      setInput(next)
      // The latest finished play's recorded per-source progress: which sources actually ran.
      const latest = next.jobs?.filter(j => j.query && !j.csv_domain && !j.test_only && j.status === 'done').sort((a, b) => b.created_at - a.created_at)[0]
      if (latest) {
        const s = await fetch(`/api/scan/status?job_id=${latest.id}`).then(r => r.ok ? r.json() : null).catch(() => null)
        setLastRun(Array.isArray(s?.progress) ? s.progress : null)
      }
    }
    void load()
    const refresh = () => void load()
    window.addEventListener('profile-updated', refresh)
    return () => window.removeEventListener('profile-updated', refresh)
  }, [])
  if (!input) return null
  const steps = homeSteps(input)
  const done = steps.filter(s => s.state === 'done').length
  if (done === steps.length) return null
  const src = homeSources(input, lastRun)
  return (
    <section className="hc card p-5 sm:p-6 mb-6" data-testid="home-checklist" aria-labelledby="hc-title">
      <div className="flex items-center justify-between gap-3">
        <h2 id="hc-title" className="text-lg font-bold tracking-tight">From your website to your first reply</h2>
        <span className="text-sm font-semibold text-[var(--ink-2)] shrink-0" data-testid="hc-progress">{done} of {steps.length}</span>
      </div>
      <ol className="hc-steps mt-5">
        {steps.map((s, n) => (
          <li key={s.id} className="hc-step" data-testid={`hc-${s.id}`} data-hc-state={s.state} data-hc-next={s.next ? 'true' : undefined}>
            <span aria-hidden className={`hc-dot ${s.state === 'done' ? 'hc-dot-done' : s.next ? 'hc-dot-next' : ''}`}>{s.state === 'done' ? '✓' : s.state === 'unknown' ? '?' : n + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-sm">{s.label}<span className="sr-only">{s.state === 'done' ? ' (done)' : s.state === 'unknown' ? ' (could not check)' : ' (to do)'}</span></div>
              <div className="text-xs text-[var(--ink-2)] mt-0.5 break-words line-clamp-2" title={s.detail}>{s.detail}</div>
              {s.state !== 'done' && (s.href.includes('?setup=')
                // Secondary buttons: Home keeps one primary action, the journey's. The next step is marked by its dark dot.
                // The setup steps read ?setup= once, on load, so that link loads the page.
                ? <a href={s.href} className="btn-ghost btn-sm mt-2 inline-flex">{s.action}</a>
                : <Link href={s.href} className="btn-ghost btn-sm mt-2 inline-flex">{s.action}</Link>)}
            </div>
          </li>
        ))}
      </ol>
      {src && src.names.length > 0 && <p className="mt-5 pt-4 border-t border-[var(--line)] text-xs text-[var(--ink-2)] flex flex-wrap items-center gap-1.5" data-testid="hc-sources" data-basis={src.basis}>
        <span className="mr-1">{src.basis === 'ran' ? 'Sources in your last play:' : 'Sources ready for your first play:'}</span>
        {src.names.map(n => <span key={n} className="pill pill-mint">{n}</span>)}
      </p>}
    </section>
  )
}
