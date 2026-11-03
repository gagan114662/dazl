'use client'
import { useEffect, useState } from 'react'

interface Row { signal_kind: string | null; source_kind: string | null; sent: number; booked: number; held: number; no_show: number; cancelled: number; replied: number | null; interested: number | null; reply_rate: number | null; observed_replied: number; observed_interested: number }
interface Report { reply_reading: boolean; rows: Row[] }

export default function ConversionPanel() {
  const [rep, setRep] = useState<Report | null>(null)
  useEffect(() => { fetch('/api/outreach/conversion').then(r => r.ok ? r.json() : null).then(setRep).catch(() => setRep(null)) }, [])
  if (!rep) return null
  const unk = (r: Row, n: number | null, seen: number) => n === null ? `unknown${seen > 0 ? ` (${seen} seen earlier)` : ''}` : String(n)
  return (
    <section className="mb-8" aria-label="Reply rate by signal">
      <h2 className="text-lg font-bold tracking-tight mb-1">Reply rate by signal</h2>
      <p className="text-xs text-[#555] mb-3">Sent emails only. Rates are observed among the replies dazl recorded: periods when reply reading was off or interrupted are not known, so this is not complete conversion data. Replied excludes auto-replies and bounces. Interested means the reply was classified as positive by rules, not confirmed by a person. Booked counts leads with a Cal.com booking received after the send, matched to that lead by email, that still stands: cancelled bookings drop out and a rescheduled one counts once. Held counts only meetings a person marked held in Settings (Cal.com does not confirm that a meeting happened). Cancelled counts leads whose bookings were all cancelled. Each lead gets one email, so one lead is never counted twice.</p>
      {!rep.reply_reading && rep.rows.length > 0 && (
        <p className="text-sm font-medium border border-black p-2 mb-3">Gmail reply reading is not connected, so replies cannot be detected. Reply rates are unknown, not zero, and rows are ordered by emails sent.</p>
      )}
      {rep.rows.length === 0 ? (
        <p className="text-sm text-[#555]">No emails sent yet, so there are no rates to show.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border border-black/10">
            <thead><tr className="text-left text-xs text-[#555] border-b border-black/10"><th className="p-2">Signal</th><th className="p-2">Source</th><th className="p-2">Sent</th><th className="p-2">Replied</th><th className="p-2">Reply rate</th><th className="p-2">Interested</th><th className="p-2">Booked</th><th className="p-2">Held</th><th className="p-2">No-show</th><th className="p-2">Cancelled</th></tr></thead>
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
                  <td className="p-2">{r.held}</td>
                  <td className="p-2">{r.no_show}</td>
                  <td className="p-2">{r.cancelled}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
