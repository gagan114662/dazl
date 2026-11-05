// #568: the settings lifecycle panel renders the delete/resume controls from the server's can_delete flag, so a
// non-owner never sees a destructive control the delete route would refuse. Rendered through the real component
// with react-dom/server; any network call fails the test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeleteControls, OWNER_ONLY_DELETE_MESSAGE, type LifecycleStatus } from '../../app/app/settings/lifecycle-delete-controls.tsx'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call: ${u}`) }) as typeof fetch

const base: LifecycleStatus = { tenant: 'tenant-a', tables: {}, always_retained: ['audit_events'], deletion: null }
const noop = () => {}
const props = (s: LifecycleStatus) => ({ s, sup: 'retain' as const, setSup: noop, confirm: '', setConfirm: noop, onDelete: noop })
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


const UNAVAILABLE = 'Account deletion is not available yet. Contact support to delete this account.'

test('an owner sees an unavailable note instead of the delete form when deletion is not enabled (no ledger)', () => {
  const html = renderToStaticMarkup(h(DeleteControls, props({ ...base, can_delete: true, deletion_available: false })))
  assert.ok(!html.includes('Delete this account</button>'), 'no delete button the route would only 503')
  assert.ok(!html.includes('Type the workspace id to confirm'), 'no confirmation input')
  assert.ok(!html.includes('name="sup"'), 'no opt-out policy choice')
  assert.ok(html.includes(UNAVAILABLE), 'the unavailable note matches the route 503 wording')
})

test('an owner with an in-progress deletion sees its state and the unavailable note, no resume control', () => {
  const html = renderToStaticMarkup(h(DeleteControls, props({ ...base, can_delete: true, deletion: deleting, deletion_available: false })))
  assert.ok(html.includes('Deletion requested'), 'the deletion state stays visible')
  assert.ok(!html.includes('Resume deletion'), 'a resume control that would only 503 is not shown')
  assert.ok(html.includes(UNAVAILABLE), 'the unavailable note explains the missing resume control')
})

test('an owner sees the delete form when deletion is enabled', () => {
  const html = renderToStaticMarkup(h(DeleteControls, props({ ...base, can_delete: true, deletion_available: true })))
  assert.ok(html.includes('Delete this account</button>'), 'the owner gets the delete button')
  assert.ok(!html.includes(UNAVAILABLE))
})

test('a non-owner keeps the owner-only note when deletion is unavailable (role note takes precedence)', () => {
  const html = renderToStaticMarkup(h(DeleteControls, props({ ...base, can_delete: false, deletion_available: false })))
  assert.ok(html.includes(OWNER_ONLY_DELETE_MESSAGE))
  assert.ok(!html.includes(UNAVAILABLE), 'a non-owner is told about their role, not the service configuration')
})

test('deletion_available absent (an older server) keeps the old behavior', () => {
  const html = renderToStaticMarkup(h(DeleteControls, props({ ...base, can_delete: true })))
  assert.ok(html.includes('Delete this account</button>'), 'undefined deletion_available does not hide the controls')
  assert.ok(!html.includes(UNAVAILABLE))
})

console.log('LIFECYCLE DELETE CONTROLS ok')
