'use client'
import { useEffect, useState } from 'react'

interface Row { gmail_id: string; from_email: string; excerpt: string; classification: string; received_at: number; company: string | null; lead_name: string | null; followups_sent: number | null; stopped: string | null }
interface Info { available: boolean; consent_accepted: boolean; read_granted: boolean; rows: Row[] }

const BADGE: Record<string, string> = {
  positive: 'text-green-700 border-green-600/40',
  negative: 'text-red-700 border-red-600/40',
  opt_out: 'text-red-700 border-red-600/40',
  auto: 'text-gray-400 border-black/10',
  other: 'text-gray-500 border-black/10',
}
const LABEL: Record<string, string> = { positive: 'interested', negative: 'not interested', opt_out: 'opted out', auto: 'auto-reply', other: 'other' }

export default function InboxClient() {
  const [i, setI] = useState<Info | null>(null)
  useEffect(() => { fetch('/api/outreach/inbox').then(r => r.ok ? r.json() : null).then(setI).catch(() => setI(null)) }, [])
  if (!i) return <div className="p-8 text-sm text-[#555]">Loading...</div>
  return (
    <div className="p-8 max-w-4xl">
      <h1 className="text-2xl font-bold tracking-tight mb-1">Inbox</h1>
      <p className="text-[#555] text-sm mb-6">Replies to the email threads dazl started for you. Nothing else in your mailbox is read.</p>
      {(!i.consent_accepted || !i.read_granted) && (
        <div className="card p-6 text-sm text-[#555]">
          Reply reading is off. Turn it on in <a className="underline underline-offset-2" href="/app/settings">Settings</a> to see replies here.
        </div>
      )}
      {i.consent_accepted && i.read_granted && i.rows.length === 0 && (
        <div className="card p-6 text-sm text-[#555]">No replies yet. When someone answers an outreach email, it shows up here.</div>
      )}
      {i.rows.length > 0 && (
        <ul className="space-y-3">
          {i.rows.map(r => (
            <li key={r.gmail_id} className="card p-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="text-sm">
                  <span className="font-medium">{r.company || r.from_email}</span>
                  {r.company && <span className="text-[#555]"> ({r.lead_name || r.from_email})</span>}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-[11px] px-1.5 py-0.5 border ${BADGE[r.classification] ?? BADGE.other}`}>{LABEL[r.classification] ?? r.classification}</span>
                  <span className="text-xs text-[#888]">{new Date(r.received_at * 1000).toLocaleString()}</span>
                </div>
              </div>
              <p className="text-sm text-[#333] mt-2">{r.excerpt}</p>
              <div className="text-xs text-[#888] mt-2">
                {r.stopped ? `Follow-ups stopped (${r.stopped.replace(/_/g, ' ')})` : r.followups_sent ? `Follow-ups sent: ${r.followups_sent}` : 'No follow-up sent'}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
