'use client'
import { useEffect, useState } from 'react'
import GmailGate from '../gmail-gate'
import { followupAsk } from '@/lib/outreach/followups'

interface Thread { thread_id: string; company: string; name: string; to_email: string; last_lead_reply_at: number | null; followups_sent: number; next_due_at: number | null; stopped: string | null }
interface Sent { thread_id: string; company: string; to_email: string; step: number; status: string; created_at: number }
interface Overview { enabled: boolean; account: string | null; threads: Thread[]; sent: Sent[] }
interface Warm { thread_id: string; company: string; name: string; to_email: string; last_reply_at: number; reply_excerpt: string; reopen: { status: string; body: string } | null }

const STOPPED: Record<string, string> = { replied: 'They replied again - the sequence stops for you to handle', bounced: 'The address bounced', unsubscribed: 'They unsubscribed', manual: 'Stopped by you', domain_unconfirmed: 'The website is not confirmed as the right company. This thread is stopped and confirming it later does not restart it. Check the lead on the Leads page and start a new draft if you still want to write',
 evidence_withdrawn: 'Lead confirmation withdrawn - re-confirm the lead on the Leads page to contact them again' }
const day = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

export default function FollowupsClient() {
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState('')
  const [warm, setWarm] = useState<Warm[]>([])
  const [reopens, setReopens] = useState<Warm[]>([])
  const [warmMsg, setWarmMsg] = useState('')
  const loadWarm = () => fetch('/api/outreach/reopen').then(r => r.ok ? r.json() : null).then(j => { if (j) { setWarm(j.warm); setReopens(j.reopens) } }).catch(() => {})
  useEffect(() => { void loadWarm() }, [])
  async function reopenAction(action: string, threadId: string, body?: string) {
    setWarmMsg('')
    let r: Response
    try { r = await fetch('/api/outreach/reopen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, thread_id: threadId, ...(body !== undefined ? { body } : {}) }) }) } catch { setWarmMsg('Could not reach the server. Reload before trying again.'); return }
    const j = await r.json().catch(() => ({}))
    if (!r.ok) {
      const known: Record<string, string> = {
        suppressed: 'That address unsubscribed or bounced.',
        already_created: 'A re-open already exists for this thread.',
        send_uncertain: 'This send may already have gone out. Check your Gmail Sent folder before doing anything else.',
        already_sent: 'This re-open was already sent.',
        final: 'This re-open was already handled.',
        not_editable: 'This re-open can no longer be edited.',
        daily_cap: 'Daily sending limit reached. Nothing was sent; the draft is kept for later.',
        not_sales_contact: 'The published address is for recruitment, support, privacy or another restricted purpose. Saved words remain unchanged; sending is blocked.',
        lead_currentness_unconfirmed: 'Event timing is unconfirmed. This draft is preserved for inspection but cannot be sent.',
        review_unreadable: 'The website check could not be read just now. Nothing was sent and nothing was changed. Try again in a minute.',
        domain_unconfirmed: 'The website behind this draft is not confirmed as the right company. Confirm it on the Leads page ("This website is the right company"). That check is not need or consent. If the lead shows no check there, skip this draft and create a new one from the lead.',
        lead_evidence_withdrawn: 'The lead confirmation behind this draft was withdrawn. Re-confirm the lead on the Leads page - dazl has not verified it.',
        paused: 'Sending is paused. Resume it in Settings, then try again. Nothing was sent.',
        send_in_progress: 'This send is still in progress. Wait a few minutes, then check your Gmail Sent folder.',
        not_uncertain: 'This re-open is no longer waiting on a result.',
        already_uncertain: 'An earlier send has an unknown result. Check your Gmail Sent folder first.',
      }
      setWarmMsg(typeof j.error === 'string' && known[j.error] ? known[j.error] : 'Could not do that')
      void loadWarm() // the row may have changed under this page: drop stale controls
      return
    }
    setWarm(j.warm); setReopens(j.reopens)
  }
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
      {error && <p className="text-[#111] text-sm border-l-2 border-[#111] pl-3" role="status">{error}</p>}
      {data && followupAsk(data) === 'connect' && (
        <div className="mb-6">
          <GmailGate intro="Connect Gmail to unlock Inbox and Follow-ups. Follow-ups start only after Gmail is connected and the follow-ups switch is on in Settings." />
        </div>
      )}
      {data && followupAsk(data) === 'switch' && (
        <div className="mb-6 card p-6 text-sm text-[#555]">
          Gmail is connected. Turn on the follow-ups switch in <a className="underline underline-offset-2" href="/app/settings">Settings</a> to start automatic follow-ups.
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
          {(warm.length > 0 || reopens.length > 0) && (
            <>
              <h2 className="text-sm font-semibold mb-2">Warm again</h2>
              <p className="text-[#777] text-xs mb-2">They replied with interest, then went quiet 30-90 days ago. Re-opens are drafts - nothing sends unless you review it and press send. One per thread, ever.</p>
              <div className="card divide-y divide-black/5 mb-8">
                {warm.map(t => (
                  <div key={t.thread_id} className="p-4 text-sm flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{t.company || t.name || t.to_email}</div>
                      <div className="text-[#777] text-xs">{t.to_email} · last replied {day(t.last_reply_at)}</div>
                      {t.reply_excerpt && <div className="text-[#999] text-xs truncate">They wrote: &ldquo;{t.reply_excerpt}&rdquo;</div>}
                    </div>
                    <button onClick={() => void reopenAction('draft', t.thread_id)} className="font-mono text-xs uppercase border border-black px-2 py-1 hover:bg-black hover:text-white">Draft re-open</button>
                  </div>
                ))}
                {reopens.filter(r => r.reopen).map(t => (
                  <ReopenRow key={t.thread_id} t={t} onAction={reopenAction} />
                ))}
              </div>
              {warmMsg && <p className="text-[#111] text-xs mb-4 border-l-2 border-[#111] pl-3" role="status">{warmMsg}</p>}
            </>
          )}
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

function ReopenRow({ t, onAction }: { t: Warm; onAction: (action: string, threadId: string, body?: string) => void }) {
  const [body, setBody] = useState(t.reopen?.body ?? '')
  const st = t.reopen?.status ?? 'draft'
  return (
    <div className="p-4 text-sm">
      <div className="flex items-center gap-3">
        <div className="font-medium flex-1">{t.company || t.name || t.to_email} <span className="text-[#777] text-xs font-normal">{st === 'sent' ? ' - re-open sent' : st === 'skipped' ? ' - skipped' : st === 'approved' ? ' - send started, outcome not confirmed. Check your Gmail Sent folder before doing anything else' : '- draft, review before sending'}</span></div>
        {st === 'draft' && <button onClick={() => onAction('send', t.thread_id, body)} className="font-mono text-xs uppercase border border-black px-2 py-1 hover:bg-black hover:text-white">Send this</button>}
        {(st === 'draft') && <button onClick={() => onAction('skip', t.thread_id)} className="text-xs text-[#777] hover:text-black">Skip</button>}
        {st === 'approved' && <button onClick={() => onAction('mark_sent', t.thread_id)} className="font-mono text-xs uppercase border border-black px-2 py-1 hover:bg-black hover:text-white">It was sent</button>}
        {st === 'approved' && <button onClick={() => onAction('retry', t.thread_id)} className="text-xs text-[#777] hover:text-black">Not in Sent after 10+ minutes - back to draft</button>}
      </div>
      {st === 'approved' && <p className="text-[#b45309] text-xs mt-2">Only choose &ldquo;back to draft&rdquo; after you have waited at least 10 minutes and found nothing in your Gmail Sent folder. A delayed delivery can still arrive, and sending again could email them twice. &ldquo;It was sent&rdquo; sends nothing.</p>}
      {st === 'draft'
        ? <textarea className="field w-full mt-2" rows={5} value={body} onChange={e => setBody(e.target.value)} onBlur={() => { if (body !== t.reopen?.body) void onAction('edit', t.thread_id, body) }} />
        : <p className="text-[#777] text-xs mt-2 whitespace-pre-wrap">{t.reopen?.body}</p>}
    </div>
  )
}
