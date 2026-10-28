'use client'
import { useEffect, useState } from 'react'

type Row = { platform: string; query: string; total: number; buyer_yes: number; uncertain: number; not_buyer: number; ungraded: number }

// Which searches surface buyers. Thread-entity feedback: a verdict is about the thread,
// never joined to leads. Verdicts are model heuristics for review, not proof.
export default function ThreadMetrics() {
  const [rows, setRows] = useState<Row[] | null>(null)
  useEffect(() => { fetch('/api/replies/thread-metrics').then(r => r.ok ? r.json() : { rows: [] }).then(j => setRows(j.rows)).catch(() => setRows([])) }, [])
  if (!rows) return null
  return (
    <details className="text-sm text-gray-400 mb-6">
      <summary className="cursor-pointer">What surfaces buyers - verdicts per search</summary>
      <div className="mt-2 ml-4 text-xs space-y-1">
        {rows.length === 0 && <p>No collected threads yet. Verdicts appear after a refresh grades them.</p>}
        {rows.length > 0 && (
          <>
            <table className="w-full text-left">
              <thead><tr className="text-gray-500">
                <th className="pr-2 font-normal">Search</th><th className="pr-2 font-normal">Threads</th><th className="pr-2 font-normal">Buyer</th><th className="pr-2 font-normal">Uncertain</th><th className="pr-2 font-normal">Not buyer</th><th className="font-normal">Ungraded</th>
              </tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.platform + r.query} className="border-t border-white/5">
                    <td className="pr-2 py-1">{r.platform}: {r.query}</td>
                    <td className="pr-2 py-1">{r.total}</td>
                    <td className="pr-2 py-1 text-[#111]">{r.buyer_yes}</td>
                    <td className="pr-2 py-1">{r.uncertain}</td>
                    <td className="pr-2 py-1">{r.not_buyer}</td>
                    <td className="py-1">{r.ungraded}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-gray-500">Verdicts are a model heuristic for your review, never proof of buyer intent. Ungraded means keyword-matched only (no model verdict, e.g. no AI key). Not-buyer threads are hidden from the review list but counted here so you can see the filter working.</p>
          </>
        )}
      </div>
    </details>
  )
}
