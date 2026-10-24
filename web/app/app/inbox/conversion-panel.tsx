'use client'
import { useEffect, useState } from 'react'

interface Row { signal_kind: string | null; source_kind: string | null; sent: number; replied: number; interested: number; booked: number; reply_rate: number }

export default function ConversionPanel({ readGranted }: { readGranted: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  useEffect(() => { fetch('/api/outreach/conversion').then(r => r.ok ? r.json() : null).then(j => setRows(j ? j.rows : null)).catch(() => setRows(null)) }, [])
  if (!rows) return null
  return (
    <section className="mb-8" aria-label="Reply rate by signal">
      <h2 className="text-lg font-bold tracking-tight mb-1">Reply rate by signal</h2>
      <p className="text-xs text-[#555] mb-3">Sent emails only. Replied excludes auto-replies and bounces. Interested means the reply was classified as positive by rules, not confirmed by a person. Booked means a Cal.com booking matched to that lead by email and recorded after the send. It is a booking, not a held meeting. Each lead gets one email, so one lead is never counted twice.</p>
      {!readGranted && rows.length > 0 && (
        <p className="text-sm font-medium border border-black p-2 mb-3">Gmail reply reading is not connected, so replies cannot be detected. Replied, Interested and the rates below are unknown, not zero.</p>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-[#555]">No emails sent yet, so there are no rates to show.</p>
      ) : (
        <table className="w-full text-sm border border-black/10">
          <thead><tr className="text-left text-xs text-[#555] border-b border-black/10"><th className="p-2">Signal</th><th className="p-2">Source</th><th className="p-2">Sent</th><th className="p-2">Replied</th><th className="p-2">Reply rate</th><th className="p-2">Interested</th><th className="p-2">Booked</th></tr></thead>
          <tbody>
            {rows.map((r, k) => (
              <tr key={k} className="border-b border-black/5">
                <td className="p-2">{r.signal_kind ?? 'unknown'}</td>
                <td className="p-2">{r.source_kind ?? 'unknown'}</td>
                <td className="p-2">{r.sent}</td>
                <td className="p-2">{r.replied}</td>
                <td className="p-2">{Math.round(r.reply_rate * 100)}% ({r.replied} of {r.sent})</td>
                <td className="p-2">{r.interested}</td>
                <td className="p-2">{r.booked}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
