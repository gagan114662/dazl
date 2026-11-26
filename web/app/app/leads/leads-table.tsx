'use client'
// #1038 (PR 1 of 3): the Leads list's default dense table. Same rows as the card view (the tab filter
// is applied by the caller), one line per lead: company, person, signal with its date, fit, email
// status, approval state. Sortable by fit and date; the choice survives reloads via
// leads-table-sort.ts. The checkbox/bulk column arrives with the bulk-bar PR; row click opens the
// side panel in the next PR.
import { leadCardSummary } from '@/lib/scan/lead-card'
import { leadPerson, personBasis } from '@/lib/people/lead-person'
import { identityOf } from '@/lib/scan/opportunity'
import { ContactStatusLine } from './contact-status'
import { Pill } from '../ui/bits'
import { useState, type KeyboardEvent } from 'react'
import { type LeadsSort, type LeadsSortKey } from './leads-table-sort.ts'

type TableLead = Parameters<typeof leadCardSummary>[0] & { id: string }

// Controlled: the parent owns the sort state and the row order (sortLeads there), so the side panel's
// prev/next walks exactly the order on screen (#1038 PR 2). `leads` arrives already sorted.
export default function LeadsTable({ leads, icpWho, drafted, approved, sort, onSort, onOpen, selectedId }: {
  leads: TableLead[]
  icpWho: string
  drafted: Set<string> | null | undefined
  approved: Record<string, unknown>
  sort: LeadsSort
  onSort: (next: LeadsSort) => void
  onOpen: (id: string) => void
  selectedId: string | null
}) {
  const choose = (key: LeadsSortKey) => {
    onSort(sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' })
  }
  const rows = leads
  // Keyboard path to the panel (review of #1869): the table is one tab stop; arrows move the focused
  // row, Enter or Space opens it. Rows stay click-to-open for pointer users; no per-row tab stops, so
  // tabbing through the page is not a 16-stop walk and the phone touch-target floor stays on real controls.
  // The table itself is the focus target so it can act as the composite widget: role="grid" plus
  // aria-activedescendant on the arrow-focused row tells assistive technology which row Enter opens
  // (CodeRabbit on #1869), while the single tab stop is unchanged.
  const [focusIx, setFocusIx] = useState(-1)
  const onTableKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocusIx(i => Math.min(i + 1, rows.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocusIx(i => Math.max(i - 1, 0)) }
    else if ((e.key === 'Enter' || e.key === ' ') && focusIx >= 0 && rows[focusIx]) { e.preventDefault(); onOpen(rows[focusIx].id) }
  }
  const arrow = (key: LeadsSortKey) => sort.key === key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''
  return (
    <div className="overflow-x-auto">
      <table data-testid="leads-table" className="w-full text-sm" tabIndex={0} onKeyDown={onTableKeys} role="grid" aria-activedescendant={focusIx >= 0 && rows[focusIx] ? `leads-row-${rows[focusIx].id}` : undefined} aria-label="Leads table: arrow keys choose a row, Enter opens it">
        <thead>
          <tr className="text-left text-xs text-[var(--ink-3)] border-b border-[var(--line)]">
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
          {rows.map((l, ix) => {
            const c = leadCardSummary(l, icpWho)
            const person = leadPerson(l.enrichments, icpWho, undefined, identityOf({ id: l.id, contact: l.contact }, l.enrichments ?? []))
            return (
              <tr key={l.id} id={`leads-row-${l.id}`} data-testid="leads-row" data-lead-id={l.id} aria-selected={selectedId === l.id} onClick={() => onOpen(l.id)} className={`align-middle h-7 hover:bg-white transition-colors cursor-pointer${selectedId === l.id ? ' bg-white' : ''}${ix === focusIx ? ' outline outline-1 outline-[var(--ink-3)]' : ''}`}>
                <td className="px-3 py-1 font-medium whitespace-nowrap">{c.company}</td>
                <td className="px-3 py-1">
                  {person
                    ? <span className="block max-w-56 truncate whitespace-nowrap">{person.name}{person.title ? <span className="text-xs text-[var(--ink-3)]">{' · '}{person.title}</span> : null}<span className="text-xs text-[var(--ink-3)]" data-testid="lead-person-basis"> ({personBasis(person)})</span></span>
                    : <span className="text-[var(--ink-3)]">No buyer named yet</span>}
                </td>
                <td className="px-3 py-1 max-w-72 whitespace-nowrap truncate">
                  <span className="inline">{l.signal}</span>{' '}
                  {c.date ? <span className="text-xs text-[var(--ink-3)] whitespace-nowrap">{c.date}</span> : null}
                </td>
                <td className="px-3 py-1">{l.fit ?? '—'}</td>
                <td className="px-3 py-1 whitespace-nowrap max-w-48 truncate" onClick={e => e.stopPropagation()}>{c.contactStatus ? <ContactStatusLine status={c.contactStatus} /> : <span className="text-[var(--ink-3)]">—</span>}</td>
                <td className="px-3 py-1 whitespace-nowrap">
                  {l.quarantined_at
                    ? <Pill tone="pink">Rejected</Pill>
                    : approved[l.id] || drafted?.has(l.id)
                    ? <Pill tone="mint">Approved</Pill>
                    : drafted == null
                    ? <span className="text-xs text-[var(--ink-3)]">couldn&apos;t load</span>
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
