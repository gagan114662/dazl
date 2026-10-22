'use client'
import { useEffect, useState } from 'react'

interface Row { collector: string; jobs: number; candidates: number | null; verified: number | null; inserted: number; leads: number; icp_graded: number; strong_fit: number; outreach_started: number; replied: number; recent_leads: number }
interface Metrics { rows: Row[]; reply_window_days: number; strong_fit_threshold: number }

// Which discovery sources actually produce leads that survive, carry an ICP grade, and
// draw replies. Counts only, from recorded provenance; unknowns render as "-".
export default function SourceMetrics() {
  const [m, setM] = useState<Metrics | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    fetch('/api/leads/source-metrics').then(r => r.ok ? r.json() : Promise.reject(new Error('load failed'))).then(setM).catch(e => setErr((e as Error).message))
  }, [])
  if (err) return null
  if (!m) return null
  const num = (v: number | null) => v === null ? '-' : String(v)
  return (
    <details className="mb-4 text-xs">
      <summary className="cursor-pointer text-gray-400">Source quality - which sources produce leads that survive, grade well, and draw replies</summary>
      {m.rows.length === 0 ? (
        <p className="text-gray-500 mt-2">No source runs recorded yet. Source provenance starts with your next scan.</p>
      ) : (
        <>
          <table className="mt-2 border-collapse">
            <thead>
              <tr className="text-gray-500 text-left">
                <th className="pr-4 font-normal">Source</th>
                <th className="pr-4 font-normal" title="Scan jobs this source ran in">Jobs</th>
                <th className="pr-4 font-normal" title="Candidates the source produced (recorded runs)">Cands</th>
                <th className="pr-4 font-normal" title="Candidates that passed evidence verification">Verified</th>
                <th className="pr-4 font-normal" title="Surviving leads credited to this source">Leads</th>
                <th className="pr-4 font-normal" title="Credited leads with an ICP grade">Graded</th>
                <th className="pr-4 font-normal" title={`Credited leads with ICP fit ${m.strong_fit_threshold}-5 (chosen threshold)`}>Fit {m.strong_fit_threshold}+</th>
                <th className="pr-4 font-normal" title="Credited leads with an outreach sequence">Outreach</th>
                <th className="pr-4 font-normal" title="Credited leads whose sequence drew a reply">Replies</th>
              </tr>
            </thead>
            <tbody>
              {m.rows.map(r => (
                <tr key={r.collector} className="text-gray-300 border-t border-white/5">
                  <td className="pr-4 py-0.5 text-[#111]">{r.collector}</td>
                  <td className="pr-4 py-0.5">{r.jobs}</td>
                  <td className="pr-4 py-0.5">{num(r.candidates)}</td>
                  <td className="pr-4 py-0.5">{num(r.verified)}</td>
                  <td className="pr-4 py-0.5">{r.leads}</td>
                  <td className="pr-4 py-0.5">{r.icp_graded}</td>
                  <td className="pr-4 py-0.5">{r.strong_fit}</td>
                  <td className="pr-4 py-0.5">{r.outreach_started}</td>
                  <td className="pr-4 py-0.5">{r.replied}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-gray-500 mt-2">A lead found by several sources counts toward each - columns do not add up. Unknown is -, never zero. Replies are association, not proof the source caused them; leads found in the last {m.reply_window_days} days have not had a fair reply window.</p>
        </>
      )}
    </details>
  )
}
