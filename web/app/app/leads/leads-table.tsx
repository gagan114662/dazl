'use client'
// #1038 (PR 1 of 3): the Leads list's default dense table. Same rows as the card view (the tab filter
// is applied by the caller), one line per lead: company, person, signal with its date, fit, email
// status, approval state. Sortable by fit and date; the choice survives reloads via
// leads-table-sort.ts. The checkbox/bulk column arrives with the bulk-bar PR; row click opens the
// side panel in the next PR.
import { useState } from 'react'
import { leadCardSummary } from '@/lib/scan/lead-card'
import { leadPerson } from '@/lib/people/lead-person'
import { ContactStatusLine } from './contact-status'
import { Pill } from '../ui/bits'
import { readLeadsSort, writeLeadsSort, sortLeads, type LeadsSort, type LeadsSortKey } from './leads-table-sort.ts'

type TableLead = Parameters<typeof leadCardSummary>[0] & { id: string }

export default function LeadsTable({ leads, icpWho, drafted, approved }: {
  leads: TableLead[]
  icpWho: string
  drafted: Set<string> | null | undefined
  approved: Record<string, unknown>
}) {
  const [sort, setSort] = useState<LeadsSort>(() => readLeadsSort())
  const choose = (key: LeadsSortKey) => {
    const next: LeadsSort = sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }
    setSort(next)
    writeLeadsSort(next)
  }
  const rows = sortLeads(leads, sort.key, sort.dir)
  const arrow = (key: LeadsSortKey) => sort.key === key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''
  return (
    <div className="overflow-x-auto">
      <table data-testid="leads-table" className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-[var(--ink-3)] border-b border-[var(--line)]">
            <th className="px-3 py-2 font-medium">Company</th>
            <th className="px-3 py-2 font-medium">Person</th>
            <th className="px-3 py-2 font-medium">
              Signal
              <button type="button" data-testid="sort-date" onClick={() => choose('date')} className="ml-1 font-normal underline decoration-dotted">date{arrow('date')}</button>
            </th>
            <th className="px-3 py-2 font-medium">
              <button type="button" data-testid="sort-fit" onClick={() => choose('fit')}>Fit{arrow('fit')}</button>
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
              <tr key={l.id} data-testid="leads-row" data-lead-id={l.id} className="align-top hover:bg-white transition-colors">
                <td className="px-3 py-1 font-medium whitespace-nowrap">{c.company}</td>
                <td className="px-3 py-1">
                  {person
                    ? <><span>{person.name}</span>{person.title ? <span className="block text-xs text-[var(--ink-3)]">{person.title}</span> : null}</>
                    : <span className="text-[var(--ink-3)]">No buyer named yet</span>}
                </td>
                <td className="px-3 py-1 max-w-72">
                  <span className="line-clamp-2 inline">{l.signal}</span>{' '}
                  {c.date ? <span className="text-xs text-[var(--ink-3)] whitespace-nowrap">{c.date}</span> : null}
                </td>
                <td className="px-3 py-1">{l.fit ?? '—'}</td>
                <td className="px-3 py-1">{c.contactStatus ? <ContactStatusLine status={c.contactStatus} /> : <span className="text-[var(--ink-3)]">—</span>}</td>
                <td className="px-3 py-1 whitespace-nowrap">
                  {l.quarantined_at
                    ? <Pill tone="pink">Rejected</Pill>
                    : approved[l.id] || drafted?.has(l.id)
                    ? <Pill tone="mint">Approved</Pill>
                    : <span className="text-xs text-[var(--ink-3)]">To decide</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
