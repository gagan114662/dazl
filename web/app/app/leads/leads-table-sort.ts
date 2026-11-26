// Sort choice and ordering for the Leads table (#1038). Dependency-free on purpose: tests import this
// file directly without pulling in the component tree.

export type LeadsSortKey = 'fit' | 'date'
export type LeadsSortDir = 'asc' | 'desc'
export interface LeadsSort { key: LeadsSortKey; dir: LeadsSortDir }

export const LEADS_SORT_KEY = 'leads-table-sort'
export const DEFAULT_LEADS_SORT: LeadsSort = { key: 'fit', dir: 'desc' } // highest fit first (#1038)

export interface LeadsSortStore { getItem(k: string): string | null; setItem(k: string, v: string): void }

function defaultStore(): LeadsSortStore | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null } catch { return null }
}

// The stored choice, or the default when nothing (or junk) is stored. Never throws: a corrupt
// value falls back to the default rather than breaking the page.
export function readLeadsSort(store: LeadsSortStore | null = defaultStore()): LeadsSort {
  try {
    const raw = store?.getItem(LEADS_SORT_KEY)
    if (!raw) return DEFAULT_LEADS_SORT
    const p = JSON.parse(raw) as Partial<LeadsSort>
    return (p.key === 'fit' || p.key === 'date') && (p.dir === 'asc' || p.dir === 'desc') ? { key: p.key, dir: p.dir } : DEFAULT_LEADS_SORT
  } catch { return DEFAULT_LEADS_SORT }
}

export function writeLeadsSort(sort: LeadsSort, store: LeadsSortStore | null = defaultStore()): void {
  try { store?.setItem(LEADS_SORT_KEY, JSON.stringify(sort)) } catch { /* storage can be refused; the choice just won't persist */ }
}

type SortableLead = { fit: number | null; event_date?: string | null; published_at?: string | null }

// Orders a copy of the list. Unknown fit sorts last in BOTH directions (an ungraded lead is never "best"
// or "worst"); ties keep the list's own order.
export function sortLeads<T extends SortableLead>(leads: T[], key: LeadsSortKey, dir: LeadsSortDir): T[] {
  const s = dir === 'asc' ? 1 : -1
  const val = (l: T): number => key === 'fit'
    ? (l.fit ?? (dir === 'asc' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY))
    : (Date.parse(l.event_date ?? l.published_at ?? '') || 0)
  return leads
    .map((l, i) => [l, i] as const)
    .sort(([a, ai], [b, bi]) => { const d = s * (val(a) - val(b)); return d !== 0 ? d : ai - bi })
    .map(([l]) => l)
}
