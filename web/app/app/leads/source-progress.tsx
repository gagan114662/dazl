'use client'
import type { SourceProgress } from '@/lib/scan/progress'
import { countsText, sourceName, stateText } from '@/lib/source-progress-copy'

// Live per-source progress while a scan runs: one row per source that has started, with its state and, once it has
// reported them, how many companies it found and what the checks made of them. Read from the status poll (the route's
// `progress`, lib/scan/progress.ts); a source with no row yet is simply not listed, and nothing is estimated.
export default function SourceProgressList({ progress }: { progress: SourceProgress[] | null }) {
  if (progress === null) return null
  if (progress.length === 0) return <p className="text-xs text-[var(--ink-2)]" data-testid="source-progress-empty">No source has reported yet.</p>
  return (
    <ul className="flex flex-col gap-1.5 text-xs" data-testid="source-progress" aria-label="Progress by source">
      {progress.map(p => {
        const counts = countsText(p)
        return (
          <li key={p.source} className="row-box px-3.5 py-2" data-testid="source-row" data-source={p.source} data-state={p.state}>
            <div className="flex items-center gap-2">
              <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${p.state === 'running' ? 'bg-[var(--lav)] step-live' : p.state === 'failed' ? 'bg-[var(--pink)]' : p.state === 'queued' ? 'bg-black/15' : 'bg-[var(--live)]'}`} />
              <span className="font-medium">{sourceName(p.source)}</span>
              <span className={`ml-auto ${p.state === 'failed' ? 'text-[var(--pink)] font-semibold' : 'text-[var(--ink-3)]'}`} data-testid="source-state">{stateText(p)}</span>
            </div>
            {(counts || p.note) && <div className="text-[var(--ink-2)] mt-0.5 pl-4" data-testid="source-counts">{[counts, p.note].filter(Boolean).join(' - ')}</div>}
          </li>
        )
      })}
    </ul>
  )
}
