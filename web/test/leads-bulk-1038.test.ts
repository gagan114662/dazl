import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { toggle, prune, approvable, toCsv, leadsCsv, type BulkCsvRow } from '../app/app/leads/leads-bulk.ts'

// #1038, PR 3 of 3: the table's bulk bar (Approve, Reject, Push to CRM, Download CSV) for the selected rows.
// Bulk reuses the EXISTING per-lead actions (no new endpoints): these pin the selection, the approve partition
// (gated rows are skipped with their reason, never drafted), the CSV shape, and the rendered structure.
const table = readFileSync(new URL('../app/app/leads/leads-table.tsx', import.meta.url), 'utf8')
const client = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')

test('#1038 selection toggles, selects all, and prunes rows that left the filter', () => {
  assert.deepEqual(toggle([], 'a'), ['a'])
  assert.deepEqual(toggle(['a', 'b'], 'a'), ['b'], 'toggling a selected row clears it')
  assert.deepEqual(toggle(['a'], 'b'), ['a', 'b'], 'row order is kept')
  assert.deepEqual(prune(['a', 'b', 'c'], [{ id: 'b' }, { id: 'c' }]), ['b', 'c'], 'a row that left the tab filter drops out of the selection')
})

test('#1038 the approve partition runs only what the card would allow, with the skip reasons kept', () => {
  const rows = [
    { id: 'a', approve: { ok: true } as const },
    { id: 'b', approve: { ok: false, reason: 'No published email address to draft to yet. See Details to look for one.' } as const },
    { id: 'c', approve: { ok: false, reason: 'Rejected. Undo to use it again.' } as const },
  ]
  const p = approvable(rows)
  assert.deepEqual(p.run.map(r => r.id), ['a'], 'only approvable rows are drafted')
  assert.deepEqual(p.skip.map(s => [s.row.id, s.reason]), [['b', rows[1].approve.reason], ['c', rows[2].approve.reason]], 'each skipped row keeps its own reason')
})

test('#1038 CSV escaping holds on commas, quotes and newlines', () => {
  const csv = toCsv(['Company', 'Signal'], [['Dent, Inc.', 'said "yes"\nnow'], ['Plain', 'x']])
  assert.equal(csv, 'Company,Signal\n"Dent, Inc.","said ""yes""\nnow"\nPlain,x')
})

test('#1038 the selected-rows CSV carries the table columns, one line per selected row', () => {
  const row: BulkCsvRow = { company: 'Bright Dental', person: 'Dana Smith · Practice owner', signal: 'opened a second office', date: '1 Oct 2026', fit: '4', email: 'Confirmed: address printed on the cited page.', approval: 'To decide' }
  const csv = leadsCsv([row, { ...row, company: 'Lakeside Smiles', approval: 'Approved' }])
  const lines = csv.split('\n')
  assert.equal(lines[0], 'Company,Person,Signal,Signal date,Fit,Email,Approval')
  assert.equal(lines.length, 3, 'header plus one line per selected row')
  assert.match(lines[1], /^Bright Dental,/)
  assert.match(lines[2], /,Approved$/)
})

test('#1038 the table renders the checkbox column and the bulk bar with the promised actions', () => {
  assert.match(table, /data-testid="select-all"/, 'the header selects the visible rows')
  assert.match(table, /data-testid=\{`select-\$\{l\.id\}`\}/, 'each row has its own checkbox')
  assert.match(table, /data-testid="bulk-bar"/, 'the bar exists')
  for (const a of ['bulk-approve', 'bulk-reject', 'bulk-push', 'bulk-csv']) assert.match(table, new RegExp(`data-testid="${a}"`), `action: ${a}`)
  assert.match(table, /stopPropagation/, 'selecting a row never opens the PR2 side panel')
  assert.match(table, /data-testid="push-result"/, 'each row shows its own push result')
  assert.match(table, /from '\.\/leads-bulk\.ts'/, 'the logic lives in a dependency-free helper the table imports')
  assert.ok(!table.includes("fetch('/api/"), 'the table itself calls no endpoints - the client wires the existing per-lead actions')
  assert.ok(!/fetch\(`\/api\//.test(table), 'the table itself calls no endpoints - the client wires the existing per-lead actions')
})

test('#1038 the client wires bulk to the existing per-lead actions, no new endpoints', () => {
  assert.match(client, /onApprove=\{/, 'bulk approve callback')
  assert.match(client, /onReject=\{/, 'bulk reject callback')
  assert.match(client, /onPush=\{/, 'bulk push callback')
  assert.match(client, /approveLead\(id, true\)/, 'bulk approve reuses approveLead in its quiet form')
})
