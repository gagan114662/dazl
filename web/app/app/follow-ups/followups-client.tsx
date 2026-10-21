'use client'
import { useEffect, useState } from 'react'
import GmailGate from '../gmail-gate'

interface Thread { thread_id: string; company: string; name: string; to_email: string; last_lead_reply_at: number | null; followups_sent: number; next_due_at: number | null; stopped: string | null }
interface Sent { thread_id: string; company: string; to_email: string; step: number; status: string; created_at: number }
interface Overview { enabled: boolean; account: string | null; threads: Thread[]; sent: Sent[] }

const STOPPED: Record<string, string> = { replied: 'They replied again - the sequence stops for you to handle', bounced: 'The address bounced', unsubscribed: 'They unsubscribed', manual: 'Stopped by you' }
const day = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

export default function FollowupsClient() {
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    void fetch('/api/outreach/followups').then(async r => {
      if (!r.ok) { setError(r.status === 401 ? 'Sign in first.' : 'Could not load follow-ups'); return }
      setData(await r.json())
    }).catch(() => setError('Could not load follow-ups'))
  }, [])

  const active = (data?.threads ?? []).filter(t => !t.stopped)
  const stopped = (data?.threads ?? []).filter(t => t.stopped)
  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">Follow-ups</h1>
      <p className="text-[#555] text-sm mb-6">
        Automatic follow-ups only go to people who replied with interest, at most two per thread, 3 and 5 days after the last activity. A new reply from them stops the sequence.
        {data && !data.enabled && ' They are off right now.'}
      </p>
      {data?.account && <p className="text-xs text-[#555] -mt-4 mb-6">Gmail connected as <span className="font-medium">{data.account}</span>.</p>}
      {error && <p className="text-red-600 text-sm">{error}</p>}
      {data && !data.enabled && (
        <div className="mb-6">
          <GmailGate intro="Connect Gmail to unlock Inbox and Follow-ups. Follow-ups start only after Gmail is connected and the follow-ups switch is on in Settings." />
        </div>
      )}
      {data && (
        <>
          <h2 className="text-sm font-semibold mb-2">Active sequences</h2>
          <div className="card divide-y divide-black/5 mb-8">
            {active.length === 0 ? (
              <p className="p-6 text-center text-[#777] text-sm">No active sequences. A sequence starts when someone replies with interest to an outreach email.</p>
            ) : active.map(t => (
              <div key={t.thread_id} className="p-4 text-sm flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{t.company || t.name || t.to_email}</div>
                  <div className="text-[#777] text-xs">{t.to_email}{t.last_lead_reply_at ? ` · replied ${day(t.last_lead_reply_at)}` : ''}</div>
                </div>
                <div className="text-xs text-[#555] text-right">
                  {t.followups_sent} of 2 sent
                  {t.next_due_at && <div>{t.next_due_at <= Math.floor(Date.now() / 1000) ? 'next one due now' : `next one ${day(t.next_due_at)}`}</div>}
                </div>
              </div>
            ))}
          </div>
          {data.sent.length > 0 && (
            <>
              <h2 className="text-sm font-semibold mb-2">Sent follow-ups</h2>
              <div className="card divide-y divide-black/5 mb-8">
                {data.sent.map((m, i) => (
                  <div key={`${m.thread_id}-${m.step}-${i}`} className="p-4 text-sm flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{m.company || m.to_email}</div>
                      <div className="text-[#777] text-xs">follow-up {m.step + 1} of 2 · {m.status}</div>
                    </div>
                    <div className="text-xs text-[#555]">{day(m.created_at)}</div>
                  </div>
                ))}
              </div>
            </>
          )}
          {stopped.length > 0 && (
            <>
              <h2 className="text-sm font-semibold mb-2">Stopped</h2>
              <div className="card divide-y divide-black/5">
                {stopped.map(t => (
                  <div key={t.thread_id} className="p-4 text-sm flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{t.company || t.name || t.to_email}</div>
                      <div className="text-[#777] text-xs">{STOPPED[t.stopped ?? ''] ?? `Stopped (${t.stopped})`}</div>
                    </div>
                    <div className="text-xs text-[#555]">{t.followups_sent} of 2 sent</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
