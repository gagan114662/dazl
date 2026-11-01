'use client'
import { useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import GmailGate from '../gmail-gate'
import ConversionPanel from './conversion-panel'

// One row per thread (its deciding reply), paginated and filtered on the server (lib/outreach/inbox.ts).
interface Row { gmail_id: string; thread_id: string; from_email: string; excerpt: string; classification: string; received_at: number; replies: number; company: string | null; lead_name: string | null; followups_sent: number | null; stopped: string | null; unread: boolean; needs_owner: boolean }
interface Counts { threads: number; needs_owner: number; unread: number; unread_needs_owner: number }
interface Info { available: boolean; consent_accepted: boolean; read_granted: boolean; account: string | null; threads: Row[]; next_cursor: string | null; counts: Counts; booking_url: string | null }
// A page of the list, tagged with the query it answers (status and play). Only the current query's page is shown or
// changed: a response to an earlier query (a slow first filter, a load-more or a mark-read started before a switch)
// is dropped, never merged into another filter's list or counts.
type Listed = Info & { key: string }
const queryKey = (status: Status, jobId: string | null) => `${status}|${jobId ?? ''}`
const listUrl = (status: Status, jobId: string | null, cursor: string | null) => `/api/outreach/inbox?status=${status}${jobId ? `&job_id=${jobId}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
type Status = 'all' | 'needs_owner' | 'unread'
const FILTERS: [Status, string, keyof Counts][] = [['all', 'All', 'threads'], ['needs_owner', 'Needs you', 'needs_owner'], ['unread', 'Unread', 'unread']]
interface ThreadMsg { dir: 'out' | 'in'; kind: 'original' | 'followup' | 'reply'; subject: string | null; body: string; at: number; classification: string | null }

const BADGE: Record<string, string> = {
  positive: 'text-black border-black font-medium',
  negative: 'text-[#333] border-black/40',
  opt_out: 'text-[#333] border-black/40',
  uncertain: 'text-[#8a5a00] border-[#e8b04a]',
  bounce_review: 'text-[#8a5a00] border-[#e8b04a]',
  auto: 'text-gray-400 border-black/10',
  other: 'text-gray-500 border-black/10',
}
const LABEL: Record<string, string> = { positive: 'interested', negative: 'not interested', opt_out: 'opted out', auto: 'auto-reply', uncertain: 'needs your review', bounce_review: 'possible bounce - unverified', other: 'other' }

export default function InboxClient() {
  // ?status=needs_owner&job_id=<play> (the Outcomes page links here with both).
  const q = useSearchParams()
  const asked = q?.get('status') as Status | null
  const [status, setStatus] = useState<Status>(asked && FILTERS.some(f => f[0] === asked) ? asked : 'all')
  const [jobId, setJobId] = useState<string | null>(/^[a-f0-9]{24}$/.test(q?.get('job_id') ?? '') ? q!.get('job_id') : null)
  const key = queryKey(status, jobId)
  const [list, setList] = useState<Listed | null>(null) // the newest page that arrived, for whichever query it answers
  const [failedKey, setFailedKey] = useState<string | null>(null)
  const [moreKey, setMoreKey] = useState<string | null>(null) // a load-more in flight, for that query
  const moreCtl = useRef<AbortController | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [threads, setThreads] = useState<Record<string, ThreadMsg[]>>({})
  const [copied, setCopied] = useState<string | null>(null)
  // First page of the current query. A filter or play change aborts the previous query's requests (first page and
  // load-more); a response that still lands after that is dropped by the aborted signal.
  useEffect(() => {
    const c = new AbortController()
    fetch(listUrl(status, jobId, null), { signal: c.signal }).then(r => r.ok ? r.json() : Promise.reject(new Error('inbox_' + r.status)))
      .then((j: Info) => { if (!c.signal.aborted) setList({ ...j, key }) })
      .catch(() => { if (!c.signal.aborted) setFailedKey(key) })
    return () => { c.abort(); moreCtl.current?.abort() }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const current = list && list.key === key ? list : null
  function loadMore() {
    if (!current?.next_cursor || moreKey === key) return
    const k = key, c = new AbortController()
    moreCtl.current = c
    setMoreKey(k)
    fetch(listUrl(status, jobId, current.next_cursor), { signal: c.signal }).then(r => r.ok ? r.json() : null).then((j: Info | null) => {
      // Appended only to the list it was asked for. Rows already shown are kept; a thread that moved since the first
      // page is not shown twice.
      if (j && !c.signal.aborted) setList(cur => cur && cur.key === k ? { ...j, key: k, threads: [...cur.threads, ...j.threads.filter(t => !cur.threads.some(x => x.thread_id === t.thread_id))] } : cur)
    }).catch(() => {}).finally(() => setMoreKey(m => m === k ? null : m))
  }
  function toggle(threadId: string) {
    if (open === threadId) return setOpen(null)
    setOpen(threadId)
    if (!threads[threadId]) void fetch(`/api/outreach/inbox?thread_id=${encodeURIComponent(threadId)}`).then(r => r.ok ? r.json() : null).then(j => { if (j) setThreads(t => ({ ...t, [threadId]: j.messages })) }).catch(() => {})
    // Opening a thread reads it. The row and the totals of the list it was opened from update; if the filter or play
    // changed meanwhile, that other list keeps the server's own counts.
    const row = current?.threads.find(t => t.thread_id === threadId)
    const k = key
    if (row?.unread) void fetch('/api/outreach/inbox', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ thread_id: threadId, action: 'read' }) })
      .then(r => { if (r.ok) setList(cur => cur && cur.key === k && cur.threads.some(t => t.thread_id === threadId && t.unread) ? { ...cur, threads: cur.threads.map(t => t.thread_id === threadId ? { ...t, unread: false } : t), counts: { ...cur.counts, unread: Math.max(0, cur.counts.unread - 1), unread_needs_owner: Math.max(0, cur.counts.unread_needs_owner - (row.needs_owner ? 1 : 0)) } } : cur) }).catch(() => {})
  }
  const i = current ?? list // consent, account and booking link do not depend on the query
  if (!i) return failedKey === key ? <div className="p-8 text-sm" role="alert">Could not load your inbox. Reload to retry.</div> : <div className="p-8 text-sm text-[#555]">Loading...</div>
  return (
    <div className="p-8 max-w-4xl">
      <h1 className="text-2xl font-bold tracking-tight mb-1">Inbox</h1>
      <p className="text-[#555] text-sm mb-6">Replies in the email threads dazl started for you, plus delivery-failure notices checked for those sends.</p>
      <ConversionPanel />
      {i.read_granted && i.account && (
        <p className="text-xs text-[#555] mb-4">Reading replies to your outreach as <span className="font-medium">{i.account}</span>. With your consent, dazl also checks delivery-failure notices for its sends. Unmatched notices are not kept as replies.</p>
      )}
      {(!i.consent_accepted || !i.read_granted) && (
        <GmailGate intro="Connect Gmail to unlock Inbox and Follow-ups. With your consent, dazl reads replies in its outreach threads and checks delivery-failure notices for its sends." />
      )}
      {i.consent_accepted && i.read_granted && (
        <div className="flex flex-wrap items-center gap-2 mb-4" data-testid="inbox-filters">
          {FILTERS.map(([st, label, ck]) => (
            <button key={st} className={st === status ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} aria-pressed={st === status} onClick={() => { setOpen(null); setStatus(st) }} data-testid={`inbox-filter-${st}`}>
              {label} <span className="tabular-nums">{current ? current.counts[ck] : '…'}</span>
            </button>
          ))}
          {jobId && <span className="text-xs text-[#555]" data-testid="inbox-play-scope">This play only. <button className="underline" onClick={() => { setOpen(null); setJobId(null) }}>Show every play</button></span>}
        </div>
      )}
      {i.consent_accepted && i.read_granted && !current && (failedKey === key
        ? <p className="text-sm" role="alert">Could not load these conversations. Reload to retry.</p>
        : <p className="text-sm text-[#555]" data-testid="inbox-loading">Loading...</p>)}
      {current && i.consent_accepted && i.read_granted && current.threads.length === 0 && (
        <div className="card p-6 text-sm text-[#555]">{status === 'all' && !jobId ? 'No replies yet. When someone answers an outreach email, it shows up here.' : 'No conversations match this filter.'}</div>
      )}
      {current && current.threads.length > 0 && (
        <ul className="space-y-3">
          {current.threads.map(r => (
            <li key={r.thread_id} className="card p-4" data-testid="inbox-thread">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="text-sm">
                  {r.unread && <span className="inline-block w-2 h-2 rounded-full bg-black mr-2 align-middle" aria-label="Unread" />}
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
                {r.replies > 1 && <span>{r.replies} replies</span>}
                <span>{r.stopped === 'review' ? 'Follow-ups stopped: this reply needs your review' : r.stopped ? `Follow-ups stopped (${r.stopped.replace(/_/g, ' ')})` : r.followups_sent ? `Follow-ups sent: ${r.followups_sent}` : 'No follow-up sent'}</span>
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
      {current?.next_cursor && (
        <button className="btn-ghost btn-sm mt-4" onClick={loadMore} disabled={moreKey === key} data-testid="inbox-more">{moreKey === key ? 'Loading...' : 'Show older conversations'}</button>
      )}
    </div>
  )
}
