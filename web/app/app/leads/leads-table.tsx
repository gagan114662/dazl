'use client'
// #1038 (PR 1 of 3): the Leads list's default dense table. Same rows as the card view (the tab filter
// is applied by the caller), one line per lead: company, person, signal with its date, fit, email
// status, approval state. Sortable by fit and date; the choice survives reloads via
// leads-table-sort.ts. Row click opens the side panel in PR 2.
// #1038 (PR 3 of 3): the checkbox column and the bulk bar for the selected rows - Approve, Reject,
// Push to CRM, Download CSV. The bar runs the EXISTING per-lead actions through the callbacks the
// client wires (no new endpoints), one row at a time in row order, and each row shows its own push
// result. Selection never opens the PR2 side panel (stopPropagation on the checkbox cell).
import { useState } from 'react'
import { leadCardSummary } from '@/lib/scan/lead-card'
import { leadPerson } from '@/lib/people/lead-person'
import { ContactStatusLine } from './contact-status'
import { Pill } from '../ui/bits'
import { readLeadsSort, writeLeadsSort, sortLeads, type LeadsSort, type LeadsSortKey } from './leads-table-sort.ts'
import { toggle, prune, approvable, leadsCsv, type BulkCsvRow } from './leads-bulk.ts'

type TableLead = Parameters<typeof leadCardSummary>[0] & { id: string }

type BulkRun = { kind: 'approve' | 'reject' | 'push'; done: number; total: number } | null

export default function LeadsTable({ leads, icpWho, drafted, approved, onApprove, onReject, onPush }: {
  leads: TableLead[]
  icpWho: string
  drafted: Set<string> | null | undefined
  approved: Record<string, unknown>
  onApprove: (id: string) => Promise<boolean>
  onReject: (id: string) => Promise<boolean>
  onPush: (id: string) => Promise<string>
}) {
  const [sort, setSort] = useState<LeadsSort>(() => readLeadsSort())
  const [selected, setSelected] = useState<string[]>([])
  const [run, setRun] = useState<BulkRun>(null)
  const [result, setResult] = useState('')
  const [pushResults, setPushResults] = useState<Record<string, string>>({})
  const choose = (key: LeadsSortKey) => {
    const next: LeadsSort = sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }
    setSort(next)
    writeLeadsSort(next)
  }
  const rows = sortLeads(leads, sort.key, sort.dir)
  const sel = prune(selected, rows)
  const arrow = (key: LeadsSortKey) => sort.key === key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''
  const busy = !!run

  // The selection the actions run on, with each row's own approve gate (same call the card makes).
  const chosen = rows.filter(l => sel.includes(l.id)).map(l => ({ l, c: leadCardSummary(l, icpWho) }))
  const bulk = async (kind: 'approve' | 'reject' | 'push', ids: string[], act: (id: string) => Promise<boolean | string>, line: (oks: number, errs: string[]) => string) => {
    setResult('')
    const errs: string[] = []
    let oks = 0
    for (const [i, id] of ids.entries()) {
      setRun({ kind, done: i, total: ids.length })
      try {
        const r = await act(id)
        if (r === true || typeof r === 'string') { oks++; if (kind === 'push') setPushResults(p => ({ ...p, [id]: String(r) })) }
        else errs.push(`${rows.find(l => l.id === id)?.company ?? id}: could not ${kind === 'approve' ? 'create the draft' : kind === 'reject' ? 'reject' : 'push'}`)
      } catch { errs.push(`${rows.find(l => l.id === id)?.company ?? id}: could not reach the server`) }
    }
    setRun(null)
    setResult(line(oks, errs))
  }

  const approveAll = () => {
    const part = approvable(chosen.map(({ l, c }) => ({ id: l.id, company: l.company, approve: c.approve })))
    void bulk('approve', part.run.map(r => r.id), onApprove, (oks, errs) => {
      const skipped = part.skip.map(s => `${s.row.company}: ${s.reason}`)
      return [`Approved ${oks} of ${part.run.length + part.skip.length}`, ...skipped, ...errs].join(' · ')
    })
  }
  const rejectAll = () => void bulk('reject', sel, onReject, (oks, errs) => [`Rejected ${oks} of ${sel.length}`, ...errs].join(' · '))
  const pushAll = () => void bulk('push', sel, onPush, (oks, errs) => [`Pushed ${oks} of ${sel.length} to the CRM`, ...errs].join(' · '))
  const downloadCsv = () => {
    const data: BulkCsvRow[] = chosen.map(({ l, c }) => {
      const person = leadPerson(l.enrichments, icpWho)
      return {
        company: c.company,
        person: person ? `${person.name}${person.title ? ` · ${person.title}` : ''}` : '',
        signal: l.signal, date: c.date, fit: l.fit === null || l.fit === undefined ? '' : String(l.fit),
        email: c.contactStatus?.text ?? '',
        approval: l.quarantined_at ? 'Rejected' : approved[l.id] || drafted?.has(l.id) ? 'Approved' : 'To decide',
      }
    })
    const url = URL.createObjectURL(new Blob([leadsCsv(data)], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'leads-selected.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const btn = 'btn-ghost btn-sm min-h-11'
  // A checkbox's 44px hit area is its label (the touch-target gate measures the label with the input).
  const check = 'inline-flex items-center justify-center min-w-11 min-h-11 -my-3 cursor-pointer'
  return (
    <div className="overflow-x-auto">
      {/* The bar stays while a run or its result is showing: approved/rejected rows leave the tab filter
          (and the selection) the moment their action lands, and the result line must not vanish with them. */}
      {(sel.length > 0 || run || result) && (
        <div data-testid="bulk-bar" className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-[var(--line)] text-sm" role="region" aria-label="Actions for the selected rows">
          {sel.length > 0 && <>
            <span className="font-medium" data-testid="bulk-count">{sel.length} selected</span>
            <button type="button" data-testid="bulk-approve" className={btn} disabled={busy} onClick={approveAll} title="Creates a draft for each row for you to review in Outreach. Nothing is sent.">Approve</button>
            <button type="button" data-testid="bulk-reject" className={btn} disabled={busy} onClick={rejectAll}>Reject</button>
            <button type="button" data-testid="bulk-push" className={btn} disabled={busy} onClick={pushAll}>Push to CRM</button>
            <button type="button" data-testid="bulk-csv" className={btn} disabled={busy} onClick={downloadCsv}>Download CSV</button>
            <button type="button" data-testid="bulk-clear" className={`${btn} text-[var(--ink-3)]`} disabled={busy} onClick={() => { setSelected([]); setResult('') }}>Clear</button>
          </>}
          {run && <span role="status" className="text-[var(--ink-2)]" data-testid="bulk-progress">{run.kind === 'approve' ? 'Approving' : run.kind === 'reject' ? 'Rejecting' : 'Pushing'} {run.done + 1}/{run.total}…</span>}
          {result && <span role="status" className="text-[var(--ink-2)] basis-full" data-testid="bulk-result">{result}</span>}
        </div>
      )}
      <table data-testid="leads-table" className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-[var(--ink-3)] border-b border-[var(--line)]">
            <th className="px-1 py-2 font-medium w-11">
              <label className={check} onClick={e => e.stopPropagation()}>
                <input type="checkbox" data-testid="select-all" aria-label="Select all visible rows"
                  checked={rows.length > 0 && sel.length === rows.length}
                  onChange={() => setSelected(sel.length === rows.length ? [] : rows.map(l => l.id))} />
              </label>
            </th>
            <th className="px-3 py-2 font-medium">Company</th>
            <th className="px-3 py-2 font-medium">Person</th>
            <th className="px-3 py-2 font-medium">
              Signal
              <button type="button" data-testid="sort-date" onClick={() => choose('date')} className="ml-1 font-normal underline decoration-dotted inline-flex items-center justify-center min-w-11 min-h-11 -my-3">date{arrow('date')}</button>
            </th>
            <th className="px-3 py-2 font-medium">
              <button type="button" data-testid="sort-fit" onClick={() => choose('fit')} className="inline-flex items-center justify-center min-w-11 min-h-11 -my-3 -mx-2">Fit{arrow('fit')}</button>
            </th>
            <th className="px-3 py-2 font-medium">Email</th>
            <th className="px-3 py-2 font-medium">Approval</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--line)]">
          {rows.map(l => {
            const c = leadCardSummary(l, icpWho)
            const person = leadPerson(l.enrichments, icpWho)
            return (
              <tr key={l.id} data-testid="leads-row" data-lead-id={l.id} className="align-middle h-7 hover:bg-white transition-colors">
                <td className="px-1 py-1" onClick={e => e.stopPropagation()}>
                  <label className={check} onClick={e => e.stopPropagation()}>
                    <input type="checkbox" data-testid={`select-${l.id}`} aria-label={`Select ${c.company}`}
                      checked={sel.includes(l.id)}
                      onChange={() => setSelected(toggle(sel, l.id))} />
                  </label>
                </td>
                <td className="px-3 py-1 font-medium whitespace-nowrap">{c.company}</td>
                <td className="px-3 py-1">
                  {person
                    ? <span className="block max-w-56 truncate whitespace-nowrap">{person.name}{person.title ? <span className="text-xs text-[var(--ink-3)]">{' · '}{person.title}</span> : null}</span>
                    : <span className="text-[var(--ink-3)]">No buyer named yet</span>}
                </td>
                <td className="px-3 py-1 max-w-72 whitespace-nowrap truncate">
                  <span className="inline">{l.signal}</span>{' '}
                  {c.date ? <span className="text-xs text-[var(--ink-3)] whitespace-nowrap">{c.date}</span> : null}
                </td>
                <td className="px-3 py-1">{l.fit ?? '—'}</td>
                <td className="px-3 py-1 whitespace-nowrap max-w-48 truncate">{c.contactStatus ? <ContactStatusLine status={c.contactStatus} /> : <span className="text-[var(--ink-3)]">—</span>}</td>
                <td className="px-3 py-1 whitespace-nowrap">
                  {l.quarantined_at
                    ? <Pill tone="pink">Rejected</Pill>
                    : approved[l.id] || drafted?.has(l.id)
                    ? <Pill tone="mint">Approved</Pill>
                    : <span className="text-xs text-[var(--ink-3)]">To decide</span>}
                  {pushResults[l.id] && <span className="block text-xs text-[var(--ink-2)]" data-testid="push-result">{pushResults[l.id]}</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
