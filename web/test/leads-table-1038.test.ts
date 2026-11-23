// #1038: the leads table's order and its open-lead neighbours (lib/scan/leads-view.ts). Cards stay the default view.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { leadNeighbours, leadSortOf, leadViewOf, sortLeads } from '../lib/scan/leads-view.ts'

const rows = [
  { id: 'a', fit: 3, intent: 2, event_date: '2026-11-02' },
  { id: 'b', fit: null, intent: null, event_date: null },
  { id: 'c', fit: 5, intent: 1, event_date: '2026-10-30' },
  { id: 'd', fit: 5, intent: 4, event_date: 'November 2026' },
  { id: 'e', fit: 3, intent: 2, event_date: '2026-11-20T09:00:00Z' },
  { id: 'f', fit: 0, intent: null, event_date: '2026-11-02' },
]
const ids = (l: { id: string }[]) => l.map(x => x.id).join('')

test('#1038 sorting by fit puts the highest fit first; ties go by timing grade, then arrival; no grade goes last', () => {
  assert.equal(ids(sortLeads(rows, 'fit')), 'dcaefb')
})
test('#1038 sorting by date puts the newest event day first; a lead with no full day goes last, in arrival order', () => {
  assert.equal(ids(sortLeads(rows, 'date')), 'eafcbd')
})
test('#1038 the default order is the list as it arrived, and sorting never changes the list it was given', () => {
  const before = ids(rows)
  assert.equal(sortLeads(rows, 'default'), rows)
  sortLeads(rows, 'fit'); sortLeads(rows, 'date')
  assert.equal(ids(rows), before)
})
test('#1038 a stored view or sort that is not one of ours falls back to cards and the default order', () => {
  assert.deepEqual([leadViewOf('table'), leadViewOf('cards'), leadViewOf(null), leadViewOf('grid')], ['table', 'cards', 'cards', 'cards'])
  assert.deepEqual([leadSortOf('fit'), leadSortOf('date'), leadSortOf(null), leadSortOf('score')], ['fit', 'date', 'default', 'default'])
})
test('#1038 Previous and Next step through the list as shown; a lead that left the list is not open', () => {
  assert.deepEqual(leadNeighbours(['a', 'b', 'c'], 'a'), { index: 0, prev: null, next: 'b' })
  assert.deepEqual(leadNeighbours(['a', 'b', 'c'], 'b'), { index: 1, prev: 'a', next: 'c' })
  assert.deepEqual(leadNeighbours(['a', 'b', 'c'], 'c'), { index: 2, prev: 'b', next: null })
  assert.deepEqual(leadNeighbours(['a', 'b', 'c'], 'x'), { index: -1, prev: null, next: null })
  assert.deepEqual(leadNeighbours(['a'], null), { index: -1, prev: null, next: null })
})
