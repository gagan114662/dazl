'use client'
// #1040: the leads Home's Ready tile judged, as a list. Every breakdown line on Home ("13 need your review (in 8 scans)") and
// the tile itself open this page with ?why=<reason> or ?why=ready, and it lists exactly the companies that number counts,
// across scans, each linking to its own scan on Leads. Same read as the tile (GET /api/home/ready), so rows = the number.
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { HomeReady, ReadyCompany } from '@/lib/outreach/home-ready'
import { holdWords } from '@/lib/outreach/hold-words'

function ReadyLeadDetails({ detail }: { detail: ReadyCompany['details'] }) {
  return <dl className="basis-full grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[var(--ink-2)]">
    <dt>Signal</dt><dd className="break-words">{detail?.signal || 'No signal recorded'}</dd>
    <dt>Date</dt><dd>{detail?.event_date ? `${detail.event_date}${detail.day_verified ? '' : ' (unconfirmed)'}` : 'No date confirmed'}</dd>
    <dt>Contact</dt><dd className="break-words">{detail?.contact_name ? [detail.contact_name, detail.contact_title].filter(Boolean).join(' · ') : 'No contact named'}</dd>
    <dt>Email</dt><dd className="break-all">{detail?.email_undeliverable ? "This address can't receive email" : detail?.email || 'No eligible work email'}</dd>
  </dl>
}

export default function CheckedClient() {
  const why = useSearchParams()?.get('why') ?? ''
  const [r, setR] = useState<HomeReady | 'failed' | null>(null)
  useEffect(() => {
    void fetch('/api/home/ready').then(x => x.ok ? x.json() : Promise.reject(new Error(String(x.status))))
      .then(j => setR(j && Array.isArray(j.companies) ? j as HomeReady : 'failed')).catch(() => setR('failed'))
  }, [])
  if (r === null) return <div className="p-4 sm:p-8 max-w-3xl"><p className="text-sm text-[var(--ink-3)]" role="status">Checking your leads from the last 30 days...</p></div>
  if (r === 'failed') return <div className="p-4 sm:p-8 max-w-3xl"><p className="text-sm" role="alert" data-testid="checked-failed">Your leads could not be checked right now. Refresh to retry.</p></div>
  const known = why === '' || why === 'ready' || r.held.some(h => h.reason === why)
  const rows = r.companies.filter(c => why === 'ready' ? c.ready : why ? !c.ready && c.reason === why : true)
  const title = why === 'ready' ? `${rows.length} ready lead${rows.length === 1 ? '' : 's'}`
    : why && known ? `${rows.length} lead${rows.length === 1 ? '' : 's'}: ${holdWords(why, rows.length)}`
    : why ? 'No leads under that heading'
    : `${rows.length} lead${rows.length === 1 ? '' : 's'} checked`
  return (
    <div className="p-4 sm:p-8 max-w-3xl">
      <p className="text-sm mb-2"><Link className="underline" href="/app">Back to Home</Link></p>
      <h1 className="text-2xl font-semibold mb-1" data-testid="checked-title">{title}</h1>
      <p className="text-sm text-[var(--ink-2)] mb-4">Companies found in the last {r.window_days} days, one row each. Open a company to see its scan.{' '}
        {r.capped && <span data-testid="checked-capped">Only the first {r.leads_checked} of your {r.leads_in_window} leads were checked, newest scans first.</span>}</p>
      {rows.length === 0 ? <p className="text-sm" data-testid="checked-empty">{why === 'ready' ? 'No lead from the last 30 days is ready yet.' : 'No leads here.'} <Link className="underline" href="/app/leads/checked">See every lead that was checked</Link>.</p>
        : <ul className="card divide-y divide-black/5" data-testid="checked-list">
          {rows.map(c => (
            <li key={c.lead_id} className="p-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm min-w-0" data-testid="checked-row">
              <Link className="underline break-words min-w-0" href={`/app/leads?job_id=${c.job_id}`}>{c.company}</Link>
              <span className="text-[var(--ink-3)]">{c.ready ? 'Ready' : holdWords(c.reason, 1).replace(/^./, x => x.toUpperCase())}</span>
              {c.ready && <ReadyLeadDetails detail={c.details} />}
            </li>))}
        </ul>}
    </div>)
}
