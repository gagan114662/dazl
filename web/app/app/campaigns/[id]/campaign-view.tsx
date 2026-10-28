'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { isJobId } from '@/lib/outreach/scan-drafts'
import { leadStatus, scanMessages, type ViewLead, type ViewMsg } from '@/lib/outreach/campaign-view'

interface Job { query: string | null; status: string; created_at?: number }
type Load<T> = T | 'failed' | null

// One campaign (= one scan): its play, every lead with where it stands, and its drafts and sends. Read-only: reviewing,
// approving, drafting and sending stay on Leads and Outreach with their checks; this page only reports and links.
// The status read is passive (never starts or resumes the scan).
export default function CampaignView({ id }: { id: string }) {
  const valid = isJobId(id)
  const [job, setJob] = useState<Load<Job> | 'not_found'>(null)
  const [leads, setLeads] = useState<Load<ViewLead[]>>(null)
  const [msgs, setMsgs] = useState<Load<ViewMsg[]>>(null)
  useEffect(() => {
    if (!valid) return
    const get = (u: string) => fetch(u).then(async r => ({ status: r.status, body: r.ok ? await r.json().catch(() => null) : null })).catch(() => ({ status: 0, body: null }))
    void get(`/api/scan/status?job_id=${id}&passive=1`).then(r => setJob(r.status === 404 ? 'not_found' : r.body?.status ? r.body : 'failed'))
    void get(`/api/leads?job_id=${id}&all=1`).then(r => setLeads(Array.isArray(r.body?.leads) ? r.body.leads : 'failed'))
    void get('/api/outreach').then(r => setMsgs(Array.isArray(r.body?.messages) ? r.body.messages : 'failed'))
  }, [id, valid])

  if (!valid || job === 'not_found') return (
    <div className="p-8 max-w-5xl"><p className="text-sm" role="alert">This campaign was not found. <Link className="underline" href="/app/campaigns">All campaigns</Link></p></div>
  )
  const leadList = Array.isArray(leads) ? leads : null
  // Fail closed: without this scan's leads, no email can be attributed to it, so none is listed.
  const mine = leadList && Array.isArray(msgs) ? scanMessages(msgs, leadList) : null
  return (
    <div className="p-8 max-w-5xl">
      <p className="text-xs mb-2"><Link className="underline" href="/app/campaigns">All campaigns</Link></p>
      <h1 className="text-2xl font-bold tracking-tight mb-1" data-testid="campaign-play">{job && typeof job === 'object' ? job.query || 'Untitled search' : job === 'failed' ? 'Campaign' : 'Loading...'}</h1>
      {job === 'failed' && <p className="text-sm mb-2" role="alert">Could not load this campaign&apos;s search. Refresh to retry.</p>}
      {job && typeof job === 'object' && <p className="text-[#555] text-sm mb-1" data-testid="campaign-status">Scan {job.status === 'done' ? 'finished' : job.status === 'failed' ? 'stopped or failed' : job.status}{job.created_at ? ` - started ${new Date(job.created_at * 1000).toLocaleDateString()}` : ''}</p>}
      <p className="text-[#555] text-sm mb-6">Review, approve, draft and send on <Link className="underline" href={`/app/leads?job_id=${id}`}>Leads</Link> and <Link className="underline" href={`/app/outreach?job_id=${id}`}>Outreach</Link>; this page only shows where each lead stands. Sent is not delivered.</p>

      <h2 className="text-lg font-semibold mb-2">Leads</h2>
      {leads === null ? <p className="text-sm text-[#555] mb-6">Loading leads...</p>
        : leads === 'failed' ? <p className="text-sm mb-6" role="alert">Could not load this campaign&apos;s leads. Refresh to retry.</p>
        : leads.length === 0 ? <p className="text-sm text-[#555] mb-6">No leads in this campaign.</p>
        : <ul className="card divide-y divide-black/10 mb-8" aria-label="Campaign leads">
          {leads.map(l => {
            const s = msgs === null ? null : leadStatus(l, Array.isArray(msgs) ? msgs : [])
            return <li key={l.id} className="p-3 text-sm flex items-center justify-between gap-3" data-testid="campaign-lead">
              <span className="min-w-0 truncate">{l.company || l.name || 'Unnamed company'}</span>
              <span className="text-xs text-[#555] shrink-0" data-testid="lead-status" data-stage={s?.stage ?? ''}>{s ? s.text : 'Loading...'}{msgs === 'failed' && s && !['rejected'].includes(s.stage) ? ' (email status unavailable)' : ''}</span>
            </li>
          })}
        </ul>}

      <h2 className="text-lg font-semibold mb-2">Drafts and sends</h2>
      {msgs === 'failed' || leads === 'failed' ? <p className="text-sm" role="alert" data-testid="messages-unavailable">Could not load this campaign&apos;s emails. Refresh to retry.</p>
        : mine === null ? <p className="text-sm text-[#555]">Loading emails...</p>
        : mine.length === 0 ? <p className="text-sm text-[#555]">No drafts yet. Approve a lead on <Link className="underline" href={`/app/leads?job_id=${id}`}>Leads</Link> to draft one.</p>
        : <ul className="card divide-y divide-black/10" aria-label="Campaign emails">
          {mine.map(m => <li key={m.id} className="p-3 text-sm flex items-center justify-between gap-3" data-testid="campaign-email">
            <span className="min-w-0 truncate">{m.to_email} - {m.subject}</span>
            <span className="text-xs text-[#555] shrink-0">{m.status === 'sent' ? `sent${m.sent_at ? ` ${new Date(m.sent_at * 1000).toLocaleDateString()}` : ''}` : m.status === 'approved' ? 'approved, not sent' : m.status}</span>
          </li>)}
        </ul>}
    </div>
  )
}
