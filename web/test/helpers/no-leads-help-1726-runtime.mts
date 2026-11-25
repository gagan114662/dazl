// #1726 (prod 77e8b23, 25 Nov): a non-SaaS scan ("residential roofing, Calgary") finished in ~50s
// at $0.23 with 0 found / 0 checked / 0 dropped and only the bare line "The scan finished with no
// leads." - no reason, no next step, though the cost panel promised a second loop under 5 leads.
// Fo's UI part: the zero-lead block shows the outcome's own plain reason and 1-2 next steps, never
// the bare line alone. Pure tests: no network, no model. Outcome literals are shape-only; the real
// labels live in lib/scan/scan-outcome.ts (read-only here). Runs under the tsx loader (the #1571
// pattern): node --test cannot strip .tsx.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NoLeadsHelp, noLeadsHelp } from '../../app/app/leads/no-leads-help.tsx'

const zeroMatch = { kind: 'zero_match' as const, label: 'Zero match', detail: undefined, next: { text: 'Widen the search', href: '/app/leads' } }
const noneExtracted = { kind: 'none_extracted' as const, label: 'No candidates were extracted', detail: 'Two sources returned items, none matched as candidates.', next: { text: 'See what the scan read', href: '/app/leads?job=x' } }

test('a zero-lead scan never shows the bare line alone: its reason and at least one action', () => {
  const out = noLeadsHelp(zeroMatch)
  assert.equal(out.reason, 'Zero match.')
  assert.ok(out.actions.length >= 1)
  assert.equal(out.actions[0].text, 'Widen the search')
})

test('the reason carries the outcome detail when there is one', () => {
  assert.equal(noLeadsHelp(noneExtracted).reason, 'No candidates were extracted. Two sources returned items, none matched as candidates.')
})

test('with the query present: the outcome next step first, then one rerun of the same query, capped at two', () => {
  const out = noLeadsHelp(zeroMatch, { query: 'roof replacement Calgary' })
  assert.deepEqual(out.actions, [
    { text: 'Widen the search', href: '/app/leads' },
    { text: 'Run this search again', href: `/app/leads?q=${encodeURIComponent('roof replacement Calgary')}` },
  ])
})

test('no next step and no query still leaves one honest action, never zero', () => {
  const out = noLeadsHelp({ kind: 'failed', label: 'Failed', detail: undefined, next: null })
  assert.deepEqual(out.actions, [{ text: 'Start a new search', href: '/app/leads' }])
})

test('a next step that already reruns this same query is not duplicated', () => {
  const q = 'roof replacement Calgary'
  const out = noLeadsHelp({ kind: 'zero_match', label: 'Zero match', detail: undefined, next: { text: 'Widen the search', href: `/app/leads?q=${encodeURIComponent(q)}` } }, { query: q })
  assert.deepEqual(out.actions, [{ text: 'Widen the search', href: `/app/leads?q=${encodeURIComponent(q)}` }])
})

test('whitespace-only query is ignored', () => {
  assert.deepEqual(noLeadsHelp(zeroMatch, { query: '   ' }).actions.map(a => a.text), ['Widen the search'])
})

test('the rendered block shows the reason and the actions (the component the page mounts)', () => {
  const html = renderToStaticMarkup(h(NoLeadsHelp, { outcome: zeroMatch, query: 'roof replacement Calgary' }))
  assert.ok(html.includes('data-testid="no-leads-help"'))
  assert.ok(html.includes('Zero match.'))
  assert.ok(html.includes('Widen the search'))
  assert.ok(html.includes(encodeURIComponent('roof replacement Calgary')))
  assert.ok(!html.includes('The scan finished with no leads.'))
})
