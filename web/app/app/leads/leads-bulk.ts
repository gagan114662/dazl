// #1038 (PR 3 of 3): selection and CSV for the Leads table's bulk bar. Dependency-free, like
// leads-table-sort.ts. The bulk actions themselves are the EXISTING per-lead ones (approveLead,
// quarantine, POST /api/crm push) wired by leads-client; this module owns what is shared and pure.
import type { ApproveState } from '@/lib/scan/lead-card'

// Selection is a list of lead ids in row order (a Set would lose the order the per-row results print in).
export const toggle = (sel: readonly string[], id: string): string[] =>
  sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id]

// A row that left the tab filter (approved away, rejected away) drops out of the selection with it.
export const prune = (sel: readonly string[], rows: { id: string }[]): string[] =>
  sel.filter(id => rows.some(r => r.id === id))

// Bulk Approve runs only what the card's own Approve would allow (approveState, lib/scan/lead-card.ts);
// every gated row is skipped with its reason shown, never drafted.
export function approvable<T extends { approve: ApproveState }>(rows: T[]): { run: T[]; skip: { row: T; reason: string }[] } {
  const run: T[] = [], skip: { row: T; reason: string }[] = []
  for (const row of rows) {
    if (row.approve.ok) run.push(row)
    else skip.push({ row, reason: row.approve.reason })
  }
  return { run, skip }
}

// One CSV cell: quoted when it holds a comma, quote or newline; inner quotes doubled (RFC 4180).
const cell = (v: string | number | null): string => {
  const s = v === null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const toCsv = (cols: string[], rows: (string | number | null)[][]): string =>
  [cols, ...rows].map(r => r.map(cell).join(',')).join('\n')

export interface BulkCsvRow { company: string; person: string; signal: string; date: string; fit: string; email: string; approval: string }

// The bulk bar's Download CSV: the SELECTED rows, as the table shows them (the full-job export stays
// the existing /api/leads/export link above the list).
export const leadsCsv = (rows: BulkCsvRow[]): string =>
  toCsv(['Company', 'Person', 'Signal', 'Signal date', 'Fit', 'Email', 'Approval'], rows.map(r => [r.company, r.person, r.signal, r.date, r.fit, r.email, r.approval]))
