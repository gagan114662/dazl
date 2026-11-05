// #568: the settings lifecycle panel renders the delete/resume controls from the server's can_delete flag, so a
// non-owner never sees a destructive control the delete route would refuse. Rendered through the real component
// with react-dom/server; any network call fails the test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeleteControls, OWNER_ONLY_DELETE_MESSAGE } from '../../app/app/settings/lifecycle-delete-controls.tsx'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call: ${u}`) }) as typeof fetch

const base = { tenant: 'tenant-a', always_retained: ['audit_events'], deletion: null }
const noop = () => {}
const props = (s: Record<string, unknown>) => ({ s, sup: 'retain' as const, setSup: noop, confirm: '', setConfirm: noop, onDelete: noop })
const deleting = { state: 'leads', requested_at: 1_700_000_000, requested_by: 'actor', policy: { suppressions: 'retain' as const }, retained: null, completed_at: null }

test('a non-owner sees no destructive control, only the owner-only note', () => {
  const html = renderToStaticMarkup(h(DeleteControls, props({ ...base, can_delete: false })))
  assert.ok(!html.includes('Delete this account</button>'), 'no delete button for a non-owner')
  assert.ok(!html.includes('Resume deletion'), 'no resume button for a non-owner')
  assert.ok(!html.includes('name="sup"'), 'no opt-out policy choice for a non-owner')
  assert.ok(html.includes(OWNER_ONLY_DELETE_MESSAGE), 'the owner-only note explains the missing control')
})

test('an owner sees the delete form', () => {
  const html = renderToStaticMarkup(h(DeleteControls, props({ ...base, can_delete: true })))
  assert.ok(html.includes('Delete this account</button>'), 'the owner gets the delete button')
  assert.ok(html.includes('Type the workspace id to confirm'), 'the owner gets the confirmation input')
})

test('a non-owner with an in-progress deletion sees its state but no resume control', () => {
  const html = renderToStaticMarkup(h(DeleteControls, props({ ...base, can_delete: false, deletion: deleting })))
  assert.ok(html.includes('Deletion requested'), 'the deletion state stays visible')
  assert.ok(!html.includes('Resume deletion'), 'the resume control is owner-only')
  assert.ok(html.includes(OWNER_ONLY_DELETE_MESSAGE), 'the owner-only note explains the missing control')
})

test('an owner with an in-progress deletion sees the resume control', () => {
  const html = renderToStaticMarkup(h(DeleteControls, props({ ...base, can_delete: true, deletion: deleting })))
  assert.ok(html.includes('Resume deletion'), 'the owner can resume a failed deletion')
  assert.ok(!html.includes(OWNER_ONLY_DELETE_MESSAGE))
})

test('can_delete absent (an older server) keeps the old behavior', () => {
  const html = renderToStaticMarkup(h(DeleteControls, props({ ...base })))
  assert.ok(html.includes('Delete this account</button>'), 'undefined can_delete does not hide the controls')
})

console.log('LIFECYCLE DELETE CONTROLS ok')
