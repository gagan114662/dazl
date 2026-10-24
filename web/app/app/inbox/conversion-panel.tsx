'use client'
import { useEffect, useState } from 'react'

interface Row { signal_kind: string | null; source_kind: string | null; sent: number; booked: number; replied: number | null; interested: number | null; reply_rate: number | null; observed_replied: number; observed_interested: number }
interface Report { reply_reading: boolean; rows: Row[] }

export default function ConversionPanel() {
  const [rep, setRep] = useState<Report | null>(null)
  useEffect(() => { fetch('/api/outreach/conversion').then(r => r.ok ? r.json() : null).then(setRep).catch(() => setRep(null)) }, [])
  if (!rep) return null
  const unk = (r: Row, n: number | null, seen: number) => n === null ? `unknown${seen > 0 ? ` (${seen} seen earlier)` : ''}` : String(n)
  return (
    <section className="mb-8" aria-label="Reply rate by signal">
      <h2 className="text-lg font-bold tracking-tight mb-1">Reply rate by signal</h2>
      <p className="text-xs text-[#555] mb-3">Sent emails only. Replied excludes auto-replies and bounces. Interested means the reply was classified as positive by rules, not confirmed by a person. Booked counts Cal.com booking notices received after the send and matched to that lead by email. Cancellations and reschedules are not tracked and a booking is not a held meeting. Each lead gets one email, so one lead is never counted twice.</p>
      {!rep.reply_reading && rep.rows.length > 0 && (
        <p className="text-sm font-medium border border-black p-2 mb-3">Gmail reply reading is not connected, so replies cannot be detected. Reply rates are unknown, not zero, and rows are ordered by emails sent.</p>
      )}
      {rep.rows.length === 0 ? (
        <p className="text-sm text-[#555]">No emails sent yet, so there are no rates to show.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border border-black/10">
            <thead><tr className="text-left text-xs text-[#555] border-b border-black/10"><th className="p-2">Signal</th><th className="p-2">Source</th><th className="p-2">Sent</th><th className="p-2">Replied</th><th className="p-2">Reply rate</th><th className="p-2">Interested</th><th className="p-2">Booked</th></tr></thead>
            <tbody>
              {rep.rows.map((r, k) => (
                <tr key={k} className="border-b border-black/5">
                  <td className="p-2">{r.signal_kind ?? 'unknown'}</td>
                  <td className="p-2">{r.source_kind ?? 'unknown'}</td>
                  <td className="p-2">{r.sent}</td>
                  <td className="p-2">{unk(r, r.replied, r.observed_replied)}</td>
                  <td className="p-2">{r.reply_rate === null ? 'unknown' : `${Math.round(r.reply_rate * 100)}% (${r.replied} of ${r.sent})`}</td>
                  <td className="p-2">{unk(r, r.interested, r.observed_interested)}</td>
                  <td className="p-2">{r.booked}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
