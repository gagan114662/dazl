'use client'
import type { SourceProgress } from '@/lib/scan/progress'
import { countsText, sourceName, stateText } from '@/lib/scan/source-progress-copy'

// Live per-source progress while a scan runs: one row per source that has started, with its state and, once it has
// reported them, how many companies it found and what the checks made of them. Read from the status poll (the route's
// `progress`, lib/scan/progress.ts); a source with no row yet is simply not listed, and nothing is estimated.
export default function SourceProgressList({ progress }: { progress: SourceProgress[] | null }) {
  if (progress === null) return null
  if (progress.length === 0) return <p className="text-gray-400 text-xs mt-2" data-testid="source-progress-empty">No source has reported yet.</p>
  return (
    <ul className="mt-2 border border-black/10 rounded divide-y divide-black/10 text-xs" data-testid="source-progress" aria-label="Progress by source">
      {progress.map(p => {
        const counts = countsText(p)
        return (
          <li key={p.source} className="px-3 py-2" data-testid="source-row" data-source={p.source} data-state={p.state}>
            <div className="flex items-center gap-2">
              <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${p.state === 'running' ? 'bg-[#111] animate-pulse' : p.state === 'failed' ? 'border border-[#111]' : p.state === 'queued' ? 'bg-black/15' : 'bg-[#555]'}`} />
              <span className="font-medium text-[#111]">{sourceName(p.source)}</span>
              <span className={`ml-auto ${p.state === 'failed' ? 'text-[#111] font-medium' : 'text-[#555]'}`} data-testid="source-state">{stateText(p)}</span>
            </div>
            {(counts || p.note) && <div className="text-[#555] mt-0.5 pl-4" data-testid="source-counts">{[counts, p.note].filter(Boolean).join(' - ')}</div>}
          </li>
        )
      })}
    </ul>
  )
}
