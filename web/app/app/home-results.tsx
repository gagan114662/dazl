'use client'
// #1040: "Last 30 days" on Home - what the workspace's plays produced (new leads, contacted, replied, interested), the
// latest leads and replies, and the same counts by signal type, each linking to where they live. Counts come from
// GET /api/home/results (lib/outreach/home-results.ts); a read that fails says so, never a row of zeros.
import Link from 'next/link'
import { useEffect, useState } from 'react'
import type { HomeResults } from '@/lib/outreach/home-results'
import type { HomeReady } from '@/lib/outreach/home-ready'
import { holdWords } from '@/lib/outreach/hold-words'
import { signalLabel } from '@/lib/outreach/home-results'

const REPLY_WORD: Record<string, string> = { positive: 'Interested', negative: 'Not interested', other: 'Replied', opt_out: 'Opted out', uncertain: 'Replied' }
const day = (s: number) => new Date(s * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

export default function HomeResultsPanel() {
  const [r, setR] = useState<HomeResults | 'failed' | null>(null)
  // Ready leads (#1040 acceptance 1) come from their own read: it runs the Leads page's per-lead checks, so it may answer later
  const [ready, setReady] = useState<HomeReady | 'failed' | null>(null)
  useEffect(() => {
    void fetch('/api/home/ready').then(x => x.ok ? x.json() : Promise.reject(new Error(String(x.status))))
      .then(j => setReady(j && typeof j === 'object' && typeof j.ready === 'number' ? j as HomeReady : 'failed')).catch(() => setReady('failed'))
  }, [])
  useEffect(() => {
    void fetch('/api/home/results').then(x => x.ok ? x.json() : Promise.reject(new Error(String(x.status))))
      .then(j => setR(j && typeof j === 'object' && j.tiles ? j as HomeResults : 'failed')).catch(() => setR('failed'))
  }, [])
  if (r === null) return null
  if (r === 'failed') return <p className="text-sm text-[var(--ink-3)] mb-4" role="status" data-testid="results-unread">Your last 30 days could not be loaded. Refresh to retry.</p>
  const t = r.tiles
  const readyScans = ready && ready !== 'failed' ? ready.scans ?? [] : []
  // The tile and every line open the list of checked leads (/app/leads/checked), which shows exactly the rows the number
  // counts, one company each, whether they sit in one scan or several. Each row there opens its own scan.
  const readyHref = readyScans.length > 0 ? '/app/leads/checked?why=ready' : '/app/leads/checked'
  // why the other leads the tile looked at are not ready, in the words the Leads page uses for the same holds
  const heldRows = ready && ready !== 'failed' ? ready.held ?? [] : []
  const cut = ready && ready !== 'failed' && ready.capped ? ready : null   // a limit stopped the check early
  const heldText = (h: { reason: string; count: number }) => `${h.count} ${holdWords(h.reason, h.count)}`
  // nothing at all in the window: no counts AND nothing to list (a stored reply is never hidden behind the empty state)
  const empty = t.leads === 0 && t.contacted === 0 && !t.replied && r.latest_leads.length === 0 && r.latest_replies.length === 0
  // null = unknown (reply reading is off): a dash read out as "unknown", never a 0 nobody observed
  const tile = (label: string, n: number | null, href: string, id: string) => (
    <Link href={href} className="card p-4 block hover:border-black/30" data-testid={`tile-${id}`}>
      <div className="text-2xl font-semibold tabular-nums">{n === null ? <><span aria-hidden="true">-</span><span className="sr-only">unknown</span></> : n}</div><div className="text-xs text-[var(--ink-2)]">{label}</div>
    </Link>)
  return (
    <section className="mb-6" aria-labelledby="h-results" data-testid="home-results">
      <h2 id="h-results" className="font-semibold mb-2">Last {r.window_days} days</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* The tile opens where its number is: the one scan holding every ready lead, else the list of scans (never a scan that
            shows fewer rows than the tile says). */}
        <Link href={readyHref} className="card p-4 block hover:border-black/30" data-testid="tile-ready">
          {/* Home's "Leads ready" rule, every hold clear (lib/outreach/home-ready.ts); a read that fails says so, never a 0 */}
          <div className="text-2xl font-semibold tabular-nums">{ready === null ? <><span aria-hidden="true">...</span><span className="sr-only">checking</span></> : ready === 'failed' ? <><span aria-hidden="true">-</span><span className="sr-only">could not be checked</span></> : <>{ready.ready}{/* ready only grows as more leads are checked, so under a limit it is a true "or more" */}{ready.capped && <span className="text-base font-normal"> or more</span>}</>}</div>
          <div className="text-xs text-[var(--ink-2)]">Ready leads</div>
          {ready === 'failed' && <div className="text-xs text-[var(--ink-3)] mt-1" data-testid="ready-unread">Could not check. Refresh to retry.</div>}
          {readyScans.length > 1 && <div className="text-xs text-[var(--ink-3)] mt-1" data-testid="ready-scans">In {readyScans.length} scans</div>}
          {ready && ready !== 'failed' && ready.capped && <div className="text-xs text-[var(--ink-3)] mt-1" data-testid="ready-partial">First {ready.leads_checked} of {ready.leads_in_window} leads checked, newest scans first</div>}
        </Link>
        {tile('Contacted', t.contacted, '/app/outreach', 'contacted')}
        {tile('Replied', t.replied, `/app/inbox?status=all&sent_since=${r.since}`, 'replied')}
        {tile('Interested', t.interested, `/app/inbox?status=all&class=positive&sent_since=${r.since}`, 'interested')}
      </div>
      {/* Under the tiles: the leads that are not ready, by the hold. Each opens where they are: the one scan holding them, else
          the list of scans (said in the link). The numbers add up: ready + these = the leads the tile looked at. */}
      {heldRows.length > 0 && ready && ready !== 'failed' && <p className="text-sm mt-3" data-testid="ready-held">
        {/* Under a limit the held counts are what the leads checked SO FAR say: a company held here may still turn out ready in
            a scan not reached, so they are never called "or more". */}
        <span className="text-[var(--ink-2)]">{cut ? `Not ready so far (${ready.judged - ready.ready} of the ${ready.judged} companies in the first ${cut.leads_checked} of ${cut.leads_in_window} leads checked): ` : `Not ready yet (${ready.judged - ready.ready} of ${ready.judged} companies checked): `}</span>
        {heldRows.map((h, i) => <span key={h.reason}>{i > 0 && ', '}<Link className="underline" data-testid="held-line" href={`/app/leads/checked?why=${encodeURIComponent(h.reason)}`}>{heldText(h)}{h.scans > 1 ? ` (in ${h.scans} scans)` : ''}</Link></span>)}
      </p>}
      {t.replied === null && <p className="text-sm mt-3" role="status" data-testid="reading-off">Gmail reply reading is off, so replies to these emails are unknown, not zero. <Link className="underline" href="/app/settings#gmail">Turn it on in Settings</Link>.</p>}
      {empty ? <p className="text-sm mt-3" data-testid="results-empty">Nothing yet in the last {r.window_days} days. <Link className="underline" href="/app/leads">Run your first play</Link> to find leads.</p> : <>
        <div className="grid sm:grid-cols-2 gap-3 mt-3">
          <div className="card p-4"><h3 className="text-sm font-semibold mb-2">Latest leads <span className="font-normal text-[var(--ink-3)]" data-testid="new-leads">({t.leads} new)</span></h3>
            {r.latest_leads.length === 0 ? <p className="text-sm text-[var(--ink-3)]">No new leads in this period.</p>
              : <ul className="space-y-1 text-sm" data-testid="latest-leads">{r.latest_leads.map(l => <li key={l.id} className="min-w-0"><Link className="underline break-words" href={`/app/leads?job_id=${l.job_id}`}>{l.company}</Link> <span className="text-[var(--ink-3)]">{day(l.created_at)}</span></li>)}</ul>}
          </div>
          <div className="card p-4"><h3 className="text-sm font-semibold mb-2">Latest replies</h3>
            {r.latest_replies.length === 0 ? <p className="text-sm text-[var(--ink-3)]">No replies in this period.</p>
              : <ul className="space-y-1 text-sm" data-testid="latest-replies">{r.latest_replies.map((x, i) => <li key={`${x.thread_id}-${i}`} className="min-w-0"><Link className="underline break-words" href="/app/inbox?status=all">{x.company}</Link> <span className="text-[var(--ink-3)]">{REPLY_WORD[x.classification] ?? 'Replied'}, {day(x.received_at)}</span></li>)}</ul>}
          </div>
        </div>
        {r.by_signal.length > 0 && <div className="card p-4 mt-3 overflow-x-auto"><h3 className="text-sm font-semibold mb-2">By signal or source</h3>
          <table className="w-full text-sm" data-testid="by-signal"><caption className="sr-only">Leads, contacted and replied in the last {r.window_days} days by signal type, or the source of leads with no graded type</caption><thead><tr className="text-left text-[var(--ink-3)]"><th scope="col" className="font-normal pr-3">Signal or source</th><th scope="col" className="font-normal pr-3 text-right">Leads</th><th scope="col" className="font-normal pr-3 text-right">Contacted</th><th scope="col" className="font-normal text-right">Replied</th></tr></thead>
            <tbody>{r.by_signal.map(s => <tr key={s.signal} className="border-t border-black/5"><th scope="row" className="pr-3 py-1 text-left font-normal">{signalLabel(s.signal)}</th><td className="pr-3 text-right tabular-nums">{s.leads}</td><td className="pr-3 text-right tabular-nums">{s.contacted}</td><td className="text-right tabular-nums">{s.replied === null ? <><span aria-hidden="true">-</span><span className="sr-only">unknown</span></> : s.replied}</td></tr>)}</tbody>
          </table></div>}
      </>}
    </section>)
}
