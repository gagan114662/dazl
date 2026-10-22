'use client'
import { useEffect, useState } from 'react'
import GmailGate from '../gmail-gate'

interface Row { gmail_id: string; thread_id: string; from_email: string; excerpt: string; classification: string; received_at: number; company: string | null; lead_name: string | null; followups_sent: number | null; stopped: string | null }
interface Info { available: boolean; consent_accepted: boolean; read_granted: boolean; account: string | null; rows: Row[]; booking_url: string | null }
interface ThreadMsg { dir: 'out' | 'in'; kind: 'original' | 'followup' | 'reply'; subject: string | null; body: string; at: number; classification: string | null }

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
  const [open, setOpen] = useState<string | null>(null)
  const [threads, setThreads] = useState<Record<string, ThreadMsg[]>>({})
  const [copied, setCopied] = useState<string | null>(null)
  useEffect(() => { fetch('/api/outreach/inbox').then(r => r.ok ? r.json() : null).then(setI).catch(() => setI(null)) }, [])
  function toggle(threadId: string) {
    if (open === threadId) return setOpen(null)
    setOpen(threadId)
    if (!threads[threadId]) void fetch(`/api/outreach/inbox?thread_id=${encodeURIComponent(threadId)}`).then(r => r.ok ? r.json() : null).then(j => { if (j) setThreads(t => ({ ...t, [threadId]: j.messages })) }).catch(() => {})
  }
  if (!i) return <div className="p-8 text-sm text-[#555]">Loading...</div>
  return (
    <div className="p-8 max-w-4xl">
      <h1 className="text-2xl font-bold tracking-tight mb-1">Inbox</h1>
      <p className="text-[#555] text-sm mb-6">Replies to the email threads dazl started for you. Nothing else in your mailbox is read.</p>
      {i.read_granted && i.account && (
        <p className="text-xs text-[#555] mb-4">Reading replies to your outreach as <span className="font-medium">{i.account}</span>. Nothing else in the mailbox is read.</p>
      )}
      {(!i.consent_accepted || !i.read_granted) && (
        <GmailGate intro="Connect Gmail to unlock Inbox and Follow-ups. Only replies to outreach threads dazl started are read - nothing else in your mailbox." />
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
              <div className="text-xs text-[#888] mt-2 flex items-center gap-3">
                <span>{r.stopped ? `Follow-ups stopped (${r.stopped.replace(/_/g, ' ')})` : r.followups_sent ? `Follow-ups sent: ${r.followups_sent}` : 'No follow-up sent'}</span>
                <button className="underline underline-offset-2" onClick={() => toggle(r.thread_id)}>{open === r.thread_id ? 'Hide thread' : 'View thread'}</button>
              </div>
              {r.classification === 'positive' && (
                <div className="mt-2 text-xs border border-black/10 p-2 space-y-1">
                  <p className="text-[#555]">Marked interested by keyword match only - read the reply yourself before acting. dazl sends nothing for you here.</p>
                  {i.booking_url ? (
                    <p className="text-[#333]">If you want to offer a time, paste your own booking link into your reply:{' '}
                      <span className="font-mono break-all">{i.booking_url}</span>{' '}
                      <button className="underline" onClick={() => { void navigator.clipboard?.writeText(i.booking_url ?? ''); setCopied(r.gmail_id); setTimeout(() => setCopied(null), 1500) }}>{copied === r.gmail_id ? 'Copied' : 'Copy link'}</button>
                      <span className="block text-[#888] mt-0.5">This is your saved link only - showing it does not check availability, reserve a time, or book anything.</span>
                    </p>
                  ) : (
                    <p className="text-[#555]">Add a booking link in <a className="underline" href="/app/settings">Settings</a> and it shows here for the next step.</p>
                  )}
                </div>
              )}
              {open === r.thread_id && (
                <div className="mt-3 border-l-2 border-black/10 pl-3 space-y-2">
                  {(threads[r.thread_id] ?? []).length === 0 && <p className="text-xs text-[#888]">Loading...</p>}
                  {(threads[r.thread_id] ?? []).map((m, idx) => (
                    <div key={idx} className="text-xs">
                      <div className="text-[#888]">{m.dir === 'out' ? (m.kind === 'followup' ? 'You (automatic follow-up)' : 'You') : 'Them'} · {new Date(m.at * 1000).toLocaleString()}{m.subject ? ` · ${m.subject}` : ''}</div>
                      {m.body && <p className="text-[#333] whitespace-pre-wrap mt-0.5">{m.body}</p>}
                    </div>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
