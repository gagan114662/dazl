'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { isJobId } from '@/lib/outreach/scan-drafts'
import { leadStatus, scanMessages, type ViewLead, type ViewMsg } from '@/lib/outreach/campaign-view'
import { scanOutcome } from '@/lib/scan/scan-outcome'
import { currentQual, currentRun, runStatus } from '@/lib/run-status'

import type { CampaignDetail } from '@/lib/outreach/campaign-detail'
import type { PlayOffer } from '@/lib/scan/play-offer-text'
import { PlayOfferCard } from '../../play-offer'
import { offerFromReply } from '@/lib/play-offer-reply'

// One campaign (= one scan): its play, every lead with where it stands, and its drafts and sends. Read-only: reviewing,
// approving, drafting and sending stay on Leads and Outreach with their checks; this page only reports and links.
// Its data comes from GET /api/campaigns/<id>: plain owner-scoped reads of this scan only (never the scan status read,
// which can reap stale jobs, and never the account-wide newest-200 Outreach list), complete for an old campaign too.
export default function CampaignView({ id }: { id: string }) {
  const valid = isJobId(id)
  const [data, setData] = useState<(CampaignDetail & { offer?: PlayOffer | null }) | 'failed' | 'not_found' | null>(null)
  useEffect(() => {
    if (!valid) return
    void fetch(`/api/campaigns/${id}`).then(async r => r.status === 404 ? 'not_found' as const : r.ok ? await r.json().catch(() => 'failed' as const) : 'failed' as const)
      .catch(() => 'failed' as const).then(d => setData(d && (d === 'not_found' || d === 'failed' || Array.isArray(d.leads)) ? d : 'failed'))
  }, [id, valid])
  const job = data && typeof data === 'object' ? data.job : data
  const leads = data && typeof data === 'object' ? data.leads : data === 'failed' ? 'failed' : null
  const msgs = data && typeof data === 'object' ? data.messages : data === 'failed' ? 'failed' : null

  if (!valid || job === 'not_found') return (
    <div className="p-8 max-w-5xl"><p className="text-sm" role="alert">This campaign was not found. <Link className="underline" href="/app/campaigns">All campaigns</Link></p></div>
  )
  // The endpoint already returns only this scan's emails; scanMessages keeps that true even if a row slipped through.
  const mine = Array.isArray(leads) && Array.isArray(msgs) ? scanMessages(msgs, leads) : null
  return (
    <div className="p-8 max-w-5xl">
      <p className="text-xs mb-2"><Link className="underline" href="/app/campaigns">All campaigns</Link></p>
      <h1 className="text-2xl font-bold tracking-tight mb-1" data-testid="campaign-play">{job && typeof job === 'object' ? job.query || 'Untitled search' : job === 'failed' ? 'Campaign' : 'Loading...'}</h1>
      {job === 'failed' && <p className="text-sm mb-2" role="alert">Could not load this campaign&apos;s search. Refresh to retry.</p>}
      {/* What this play sells (lib/scan/play-offer.ts): the same offer Home and its drafts use; a contested one is chosen here. */}
      {data && typeof data === 'object' && <div className="my-3" data-testid="campaign-offer"><PlayOfferCard jobId={id} offer={offerFromReply(data)} onChange={o => setData(d => d && typeof d === 'object' ? { ...d, offer: o } : d)} /></div>}
      {job && typeof job === 'object' && (() => {
        // The same recorded outcome and next step as the Leads history (lib/scan/scan-outcome.ts), restated from the
        // leads as they stand now (the Campaigns card does the same), so a run whose leads were all rejected says none passed.
        const o = scanOutcome({ ...job, empty_reason: (job as { empty_reason?: string | null }).empty_reason ?? null, lead_count: Array.isArray(leads) ? leads.length : null })
        const recorded = runStatus(o, Array.isArray(leads) ? leads.length : null)
        const run = Array.isArray(leads) ? currentRun(recorded, currentQual(leads), job.query) : recorded
        return <><span className={`pill mb-2 ${run.group === 'technical' ? 'pill-pink' : run.group === 'results' ? 'pill-mint' : run.group === 'running' ? 'pill-peach' : ''}`} data-testid="run-tag" data-group={run.group}>{run.tag}</span>
        <p className="text-[#555] text-sm mb-1" data-testid="campaign-status" data-outcome={o.kind}>
          Scan: {run.label}{job.created_at ? ` - started ${new Date(job.created_at * 1000).toLocaleDateString()}` : ''}
          {run.next && <>. <Link className="underline" href={run.next.href} data-testid="next-step">{run.next.text}</Link></>}
          {run.detail && <span className="block text-xs mt-1" data-testid="outcome-detail">{run.detail}</span>}
        </p></>
      })()}
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
