'use client'
import { useEffect, useState } from 'react'
import { leftOutSummary, type LeftOut } from '@/lib/scan/rejected-drops'

// #754: names the companies this scan left out because you rejected them, with the reason and an Undo (resets that
// rejection, so a later scan may bring the company back). Renders nothing when none were left out.
export default function RejectedLeftOut({ jobId }: { jobId: string }) {
  const [list, setList] = useState<LeftOut[]>([])
  const [undone, setUndone] = useState<Record<string, 'busy' | 'done' | 'failed'>>({})
  useEffect(() => {
    let live = true
    fetch(`/api/scan/rejected?job_id=${encodeURIComponent(jobId)}`).then(r => r.ok ? r.json() : null).then(j => { if (live && j?.rejected) setList(j.rejected) }).catch(() => {})
    return () => { live = false }
  }, [jobId])
  if (list.length === 0) return null
  const undo = async (l: LeftOut) => {
    setUndone(u => ({ ...u, [l.feedback_id]: 'busy' }))
    const r = await fetch(`/api/leads/${l.lead_id}/feedback`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: l.feedback_id, reason: 'undone from scan results' }) }).catch(() => null)
    setUndone(u => ({ ...u, [l.feedback_id]: r?.ok ? 'done' : 'failed' }))
  }
  return (
    <div className="text-xs text-[var(--ink-2)] mb-3" data-testid="scan-rejected-left-out">
      <p>{leftOutSummary(list)}</p>
      <ul className="mt-1">
        {list.map(l => (
          <li key={l.feedback_id} className="flex items-center gap-2">
            <span>{l.company} ({l.label})</span>
            {undone[l.feedback_id] === 'done' ? <span>Undone: a later scan can bring it back.</span>
              : <button type="button" className="underline" disabled={undone[l.feedback_id] === 'busy'} onClick={() => undo(l)}>Undo</button>}
            {undone[l.feedback_id] === 'failed' && <span>Couldn&apos;t undo. Try again.</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
