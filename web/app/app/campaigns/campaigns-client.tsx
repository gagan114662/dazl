'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import type { Campaign } from '@/lib/outreach/campaigns'

// One view per search, from discovery to the next action. The steps themselves (review, draft, approve, send, reply)
// stay on their pages with their checks; this page only counts and links.
export default function CampaignsClient() {
  const [list, setList] = useState<Campaign[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => { void fetch('/api/campaigns').then(r => r.ok ? r.json() : null).then(j => { if (j?.campaigns) setList(j.campaigns); else setFailed(true) }).catch(() => setFailed(true)) }, [])
  const stage = (label: string, value: string, more?: string) => (
    <div className="min-w-0" data-testid={`stage-${label.toLowerCase()}`}><div className="text-[10px] uppercase tracking-wide text-[#777]">{label}</div><div className="text-sm">{value}</div>{more && <div className="text-xs text-[#555]">{more}</div>}</div>
  )
  return (
    <div className="p-8 max-w-5xl">
      <h1 className="text-2xl font-bold tracking-tight mb-1">Campaigns</h1>
      <p className="text-[#555] text-sm mb-6">Each search from finding leads to replies, with the one thing to do next. Counts are what dazl has stored; sent is not delivered.</p>
      {failed && <p className="text-sm" role="alert">Could not load your campaigns. Refresh to retry.</p>}
      {list?.length === 0 && <p className="text-sm text-[#555]">No campaigns yet. <Link className="underline" href="/app/leads">Find leads</Link> to start one.</p>}
      <div className="flex flex-col gap-3">
        {list?.map(c => (
          <article key={c.id} className="card p-4" data-testid="campaign">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div className="min-w-0">
                <div className="font-medium truncate" title={c.query}>{c.query}</div>
                <div className="text-xs text-[#777]">{new Date(c.created_at * 1000).toLocaleDateString()}</div>
              </div>
              {c.next.href
                ? <Link href={c.next.href} className="btn-primary text-xs px-3 py-1.5 shrink-0" data-testid="next-action">{c.next.label}</Link>
                : <span className="text-xs text-[#555] shrink-0" data-testid="next-action">{c.next.label}</span>}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 border-t border-black/10 pt-3">
              {stage('Discovery', `${c.discovery.leads} lead${c.discovery.leads === 1 ? '' : 's'}`, c.discovery.candidates == null ? 'candidates not recorded' : `from ${c.discovery.candidates} candidates`)}
              {stage('Qualification', `${c.qualification.sourceChecked} source-checked${c.qualification.confirmedByYou ? `, ${c.qualification.confirmedByYou} confirmed by you` : ''}, ${c.qualification.needsReview} to review`, `${c.qualification.rejected} rejected`)}
              {stage('Contact', `${c.contact.withContact} with a contact`)}
              {stage('Outreach', `${c.outreach.drafts} draft, ${c.outreach.approved} approved, ${c.outreach.sent} sent`)}
              {stage('Sequence', `${c.sequence.active} running`, `${c.sequence.stopped} finished or stopped`)}
              {stage('Replies', `${c.reply.replied} replied, ${c.reply.interested} interested`, `${c.reply.bounced} bounced, ${c.reply.optOuts} opted out`)}
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}
