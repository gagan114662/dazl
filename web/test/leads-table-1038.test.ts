import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sortLeads, readLeadsSort, writeLeadsSort } from '../app/app/leads/leads-table-sort.ts'

// #1038, PR 1 of 3: the Leads page default becomes a dense table (company / person / signal+date /
// fit / email status / approval state), sortable by fit and date with the choice surviving a reload,
// and a toggle keeps the existing card view. These pins lock the structure and the ordering; the
// rendered density proof (15+ rows at 1440x900) and the 390px check ride in test/ui/lead-cards.ui.mjs.
const table = readFileSync(new URL('../app/app/leads/leads-table.tsx', import.meta.url), 'utf8')
const client = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')

test('#1038 the table component renders the promised structure', () => {
  assert.match(table, /data-testid="leads-table"/, 'the table is identifiable')
  assert.match(table, /data-testid="leads-row"/, 'each lead is a row')
  assert.match(table, /data-testid="sort-fit"/, 'fit is a sort control')
  assert.match(table, /data-testid="sort-date"/, 'date is a sort control')
  for (const col of ['Company', 'Person', 'Signal', 'Fit', 'Email', 'Approval']) {
    assert.ok(table.includes(col), `column header: ${col}`)
  }
  assert.match(table, /ContactStatusLine/, 'email status reuses the card status line')
  assert.match(table, /leadPerson/, 'person comes from the same buyer logic as the cards')
  assert.match(table, /from '\.\/leads-table-sort\.ts'/, 'the ordering lives in a dependency-free helper the table imports')
})

test('#1038 sortLeads orders by fit and date, unknown fit last, stable on ties', () => {
  const L = (id: string, fit: number | null, date: string) => ({ lead_id: id, company: id, signal: 's', fit, event_date: date })
  const rows = [L('a', 40, '2026-10-02'), L('b', 90, '2026-09-01'), L('c', null, '2026-10-05'), L('d', 90, '2026-10-01')]
  assert.deepEqual(sortLeads(rows, 'fit', 'desc').map(l => l.lead_id), ['b', 'd', 'a', 'c'], 'fit desc: 90s first (stable), then 40, unknown last')
  assert.deepEqual(sortLeads(rows, 'fit', 'asc').map(l => l.lead_id), ['a', 'b', 'd', 'c'], 'fit asc: lowest first')
  assert.deepEqual(sortLeads(rows, 'date', 'asc').map(l => l.lead_id), ['b', 'd', 'a', 'c'], 'date asc: oldest first')
  assert.deepEqual(sortLeads(rows, 'date', 'desc').map(l => l.lead_id), ['c', 'a', 'd', 'b'], 'date desc: newest first')
})

test('#1038 the sort choice persists through the storage seam', () => {
  const mem = new Map<string, string>()
  const store = { getItem: (k: string) => mem.has(k) ? mem.get(k)! : null, setItem: (k: string, v: string) => void mem.set(k, v) }
  writeLeadsSort({ key: 'date', dir: 'asc' }, store)
  assert.deepEqual(readLeadsSort(store), { key: 'date', dir: 'asc' }, 'a written choice reads back (survives reload)')
  assert.deepEqual(readLeadsSort({ getItem: () => null, setItem: () => {} }), { key: 'fit', dir: 'desc' }, 'default: highest fit first')
  assert.deepEqual(readLeadsSort({ getItem: () => 'not-json', setItem: () => {} }), { key: 'fit', dir: 'desc' }, 'corrupt storage falls back to the default')
})

test('#1038 the Leads page offers the table as default with a cards toggle', () => {
  assert.match(client, /data-testid="leads-view-toggle"/, 'the toggle exists')
  assert.match(client, /data-testid="view-table"/, 'table option')
  assert.match(client, /data-testid="view-cards"/, 'cards option')
  assert.match(client, /useState<'table' \| 'cards'>\(\(\) =>[\s\S]{0,240}'table'/, 'the table is the default view')
  assert.match(client, /LeadsTable/, 'the table component is wired in')
  assert.match(client, /leads-view/, 'the view choice is persisted too')
})
