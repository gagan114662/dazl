'use client'
// #1038: Leads as a table - one row a lead across scans, sort by fit or date (kept in the address and remembered), a side
// panel with the evidence and next/previous, and a bulk bar: Approve (makes the same draft a card's Approve makes), Reject
// (the same reversible quarantine) and Download CSV. Each row shows its own result; a refusal says why, nothing is hidden.
// The cards stay at /app/leads. Push to CRM in bulk is the next change.
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { TablePage, TableRow, TableSort } from '@/lib/leads/table'

const STATE: Record<TableRow['state'], string> = { review: 'To review', needs_review: 'Needs your review', drafted: 'Approved (draft)', rejected: 'Rejected' }
const flames = (fit: number | null) => (fit == null ? 'not scored' : `fit ${fit}/5`)   // the cards' own scale
const day = (r: TableRow) => (r.event_date ? `${r.event_date.slice(0, 10)}${r.day_verified ? '' : ' (not confirmed)'}` : 'no date')
const safeHttp = (u: string) => /^https?:\/\//i.test(u)
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u } }

export default function TableClient() {
  const router = useRouter(), sp = useSearchParams()
  const sort: TableSort = sp.get('sort') === 'date' ? 'date' : sp.get('sort') === 'fit' ? 'fit' : 'fit'
  const page = Math.max(1, Number(sp.get('page')) || 1)
  const [data, setData] = useState<TablePage | null>(null)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<number | null>(null)
  const [result, setResult] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const [sortReady, setSortReady] = useState(() => !!sp.get('sort'))   // false until the remembered sort (if any) is resolved: no fetch of the wrong order first

  // the remembered sort applies when the address carries none
  useEffect(() => {
    if (sp.get('sort')) { try { localStorage.setItem('leads-table-sort', sp.get('sort') as string) } catch { /* private mode */ } queueMicrotask(() => setSortReady(true)); return }
    let s: string | null = null
    try { s = localStorage.getItem('leads-table-sort') } catch { /* private mode */ }
    if (s === 'date') router.replace(`/app/leads/table?sort=date${page > 1 ? `&page=${page}` : ''}`)   // the fetch waits for this address
    else queueMicrotask(() => setSortReady(true))
  }, [sp, router, page])

  useEffect(() => {
    if (!sortReady) return
    let live = true
    void fetch(`/api/leads/table?sort=${sort}&page=${page}`).then(async r => {
      if (!r.ok) throw new Error(String(r.status))
      const j = await r.json() as TablePage
      if (live) { setData(j); setError('') }
    }).catch(() => { if (live) setError('Could not load your leads. Refresh to retry.') })
    return () => { live = false }
  }, [sort, page, reload, sortReady])
  useEffect(() => { queueMicrotask(() => setOpen(null)) }, [sort, page])   // a panel never stays open on whichever row now sits at its index

  const rows = useMemo(() => data?.rows ?? [], [data])
  const cur = open != null ? rows[open] ?? null : null
  const panelHead = useCallback((el: HTMLElement | null) => { el?.focus() }, [])
  const go = useCallback((i: number) => setOpen(i >= 0 && i < rows.length ? i : null), [rows.length])
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null) }
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k)
  }, [])
  const href = (s: TableSort, p = 1) => `/app/leads/table?sort=${s}${p > 1 ? `&page=${p}` : ''}`
  const allOn = rows.length > 0 && rows.every(r => picked.has(r.id))
  const chosen = useMemo(() => rows.filter(r => picked.has(r.id)), [rows, picked])

  async function bulk(kind: 'approve' | 'reject') {
    if (!chosen.length || busy) return
    setBusy(true)
    for (const r of chosen) {
      let msg = ''
      // rows already in the target state are not sent again; a lead that needs your review is not approved from here
      if (kind === 'approve' && (r.state === 'drafted' || r.state === 'rejected' || r.state === 'needs_review')) { setResult(x => ({ ...x, [r.id]: r.state === 'drafted' ? 'Skipped: already approved' : r.state === 'rejected' ? 'Skipped: rejected (release it on Leads first)' : 'Skipped: needs your review first (open it on Leads)' })); continue }
      if (kind === 'reject' && r.state === 'rejected') { setResult(x => ({ ...x, [r.id]: 'Skipped: already rejected' })); continue }
      try {
        const res = kind === 'approve'
          ? await fetch('/api/outreach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lead_id: r.id }) })
          : await fetch(`/api/leads/${r.id}/quarantine`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'Rejected' }) })
        const j = await res.json().catch(() => null) as { error?: unknown } | null
        msg = res.ok ? (kind === 'approve' ? 'Approved: draft created' : 'Rejected') : `Not ${kind === 'approve' ? 'approved' : 'rejected'}: ${typeof j?.error === 'string' && j.error ? j.error : `refused (${res.status})`}`
      } catch { msg = `Not ${kind === 'approve' ? 'approved' : 'rejected'}: could not reach dazl` }
      setResult(x => ({ ...x, [r.id]: msg }))
    }
    setBusy(false); setPicked(new Set()); setReload(n => n + 1)
  }

  return (
    <div className={`p-4 sm:px-8 sm:py-4 ${cur ? 'sm:pr-[27rem]' : ''}`}>
      <div className="flex flex-wrap items-end justify-between gap-x-3 mb-1">
        <div>
          <h1 className="text-2xl font-semibold">Leads</h1>
          <p className="text-sm text-[#555]" data-testid="table-count">{data ? `${data.total} lead${data.total === 1 ? '' : 's'} across your scans, showing ${rows.length} on page ${data.page} of ${data.pages}.` : 'Loading...'}</p>
        </div>
        <nav className="flex flex-wrap items-center gap-3 text-sm" aria-label="Leads view">
          <span className="font-semibold" aria-current="page">Table</span>
          <Link className="underline inline-flex items-center min-h-11" href="/app/leads?latest=1" data-testid="to-cards">Cards</Link>
          <a className="underline inline-flex items-center min-h-11" href="/api/leads/export" data-testid="csv-all">Download CSV (all leads)</a>
        </nav>
      </div>
      {error && <p className="text-sm mb-3" role="alert" data-testid="table-error">{error}</p>}
      <div className="flex flex-wrap items-center gap-3 mb-2 text-sm" role="toolbar" aria-label="Bulk actions" data-testid="bulk-bar">
        <span data-testid="picked-count">{chosen.length} selected</span>
        <button type="button" className="btn-primary btn-sm" disabled={!chosen.length || busy} onClick={() => void bulk('approve')} data-testid="bulk-approve">Approve</button>
        <button type="button" className="btn-ghost btn-sm" disabled={!chosen.length || busy} onClick={() => void bulk('reject')} data-testid="bulk-reject">Reject</button>
        <span className="text-xs text-[#555] truncate" title="Approve makes the same draft a card's Approve makes; nothing is sent. A held lead is refused, with the reason on its row.">Approve makes a draft; nothing is sent. A held lead is refused, with the reason on its row.</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse" data-testid="leads-table">
          <thead><tr className="text-left text-xs uppercase tracking-wider text-[#555] border-b">
            <th className="p-0 w-11"><label className="inline-flex items-center justify-center min-h-11 min-w-11 sm:min-h-8"><input type="checkbox" aria-label="Select all on this page" checked={allOn} onChange={e => setPicked(e.target.checked ? new Set(rows.map(r => r.id)) : new Set())} /></label></th>
            <th className="p-2">Company</th><th className="p-2">Person</th><th className="p-2">Signal</th>
            <th className="p-2" aria-sort={sort === 'date' ? 'descending' : 'none'}><Link className="underline inline-flex items-center min-h-11" href={href('date')} data-testid="sort-date">Date{sort === 'date' ? ' ▼' : ''}</Link></th>
            <th className="p-2" aria-sort={sort === 'fit' ? 'descending' : 'none'}><Link className="underline inline-flex items-center min-h-11" href={href('fit')} data-testid="sort-fit">Fit{sort === 'fit' ? ' ▼' : ''}</Link></th>
            <th className="p-2">Email</th><th className="p-2">State</th>
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} data-testid="lead-row" className={`border-b cursor-pointer hover:bg-[#f6f6f6] ${open === i ? 'bg-[#f0f0f0]' : ''}`} onClick={() => setOpen(i)}>
                <td className="p-0" onClick={e => e.stopPropagation()}><label className="inline-flex items-center justify-center min-h-11 min-w-11 sm:min-h-8"><input type="checkbox" aria-label={`Select ${r.company}`} checked={picked.has(r.id)} onChange={e => setPicked(s => { const n = new Set(s); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n })} /></label></td>
                <td className="p-2 max-w-[14rem] truncate font-medium"><button type="button" className="text-left underline-offset-2 hover:underline" onClick={e => { e.stopPropagation(); setOpen(i) }}>{r.company}</button></td>
                <td className="p-2 max-w-[10rem] truncate">{r.person ?? '-'}</td>
                <td className="p-2 max-w-[22rem] truncate" title={r.signal}>{r.signal}</td>
                <td className="p-2 whitespace-nowrap">{day(r)}</td>
                <td className="p-2 whitespace-nowrap" data-testid="row-fit" data-fit={r.fit ?? ''}>{flames(r.fit)}</td>
                <td className="p-2 max-w-[12rem] truncate">{r.email ?? 'none found'}</td>
                <td className="p-2 whitespace-nowrap" data-testid="row-state">{result[r.id] ?? STATE[r.state]}</td>
              </tr>))}
            {data && rows.length === 0 && <tr><td colSpan={8} className="p-6 text-[#555]" data-testid="table-empty">No leads yet. Run a search on <Link className="underline" href="/app/leads">Leads</Link> and they will list here.</td></tr>}
          </tbody>
        </table>
      </div>
      {data && data.pages > 1 && (
        <div className="flex items-center gap-4 mt-3 text-sm" aria-label="Pages">
          {data.page > 1 ? <Link className="underline inline-flex items-center min-h-11" href={href(sort, data.page - 1)} data-testid="prev-page">Previous 50</Link> : <span className="text-[#999]">Previous 50</span>}
          <span>Page {data.page} of {data.pages}</span>
          {data.page < data.pages ? <Link className="underline inline-flex items-center min-h-11" href={href(sort, data.page + 1)} data-testid="next-page">Next 50</Link> : <span className="text-[#999]">Next 50</span>}
        </div>)}
      {cur && (
        <aside className="fixed inset-y-0 right-0 w-full sm:w-[26rem] bg-white border-l shadow-xl p-5 overflow-y-auto z-30" aria-label={`Lead: ${cur.company}`} data-testid="lead-panel">
          <div className="flex items-center justify-between mb-3">
            <div className="flex gap-2">
              <button type="button" className="btn-ghost btn-sm min-h-11" disabled={open === 0} onClick={() => go((open ?? 0) - 1)} data-testid="panel-prev">Previous</button>
              <button type="button" className="btn-ghost btn-sm min-h-11" disabled={open === rows.length - 1} onClick={() => go((open ?? 0) + 1)} data-testid="panel-next">Next</button>
            </div>
            <button type="button" className="btn-ghost btn-sm min-h-11" onClick={() => setOpen(null)} data-testid="panel-close">Close</button>
          </div>
          <h2 className="text-lg font-semibold outline-none" tabIndex={-1} ref={panelHead} data-testid="panel-company">{cur.company}</h2>
          <p className="text-sm text-[#555] mb-3">{cur.person ? `${cur.person} - ` : ''}{cur.email ?? 'no email found yet'}</p>
          <dl className="text-sm space-y-3">
            <div><dt className="text-xs uppercase tracking-wider text-[#555]">Signal</dt><dd>{cur.signal}</dd></div>
            <div><dt className="text-xs uppercase tracking-wider text-[#555]">Evidence</dt><dd data-testid="panel-quote">{cur.quote ? `“${cur.quote}”` : 'No quoted evidence stored for this lead.'}</dd></div>
            <div><dt className="text-xs uppercase tracking-wider text-[#555]">Source and date</dt><dd>{safeHttp(cur.source_url) ? <a className="underline break-all" href={cur.source_url} target="_blank" rel="noopener noreferrer nofollow" data-testid="panel-source">{host(cur.source_url)}</a> : <span data-testid="panel-source">no usable source link</span>}, event date {day(cur)}</dd></div>
            <div><dt className="text-xs uppercase tracking-wider text-[#555]">Fit</dt><dd>{flames(cur.fit)}{cur.why ? `: ${cur.why}` : ''}</dd></div>
            {cur.review_reason && <div><dt className="text-xs uppercase tracking-wider text-[#555]">Needs your review</dt><dd>{cur.review_reason.replace(/_/g, ' ')}</dd></div>}
            <div><dt className="text-xs uppercase tracking-wider text-[#555]">State</dt><dd>{result[cur.id] ?? STATE[cur.state]}</dd></div>
          </dl>
          <p className="mt-4 text-sm"><Link className="underline inline-flex items-center min-h-11" href={`/app/leads?job_id=${cur.job_id}`}>Open the full card, with every check, on its scan</Link></p>
        </aside>)}
    </div>)
}
