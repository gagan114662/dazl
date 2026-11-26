// #1715, Ziggy's changes on PR #1842: the 'Saved.' confirmation must actually render. Every parent unmounts
// SenderInline the moment a save lands (the readiness card flips to ready, the checklist row closes, the
// first-review form is replaced by the saved sender), so the confirmation is a parent-rendered element
// (SenderSavedNote) — this runtime renders it, and renders the form's own states: the disabled-Save hint for
// an empty name and for a short address, and no hint (with an enabled Save) once both are valid. A stale save
// error no longer hides the hint because editing a field clears the message (pinned in app-copy-1715).
// Rendered through the real components with react-dom/server; any network call fails the test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import SenderInline, { SenderSavedNote } from '../../app/app/sender-inline.tsx'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call: ${u}`) }) as typeof fetch
const noop = () => {}

test('the save confirmation renders: Saved., announced as a status', () => {
  const html = renderToStaticMarkup(h(SenderSavedNote))
  assert.ok(html.includes('Saved.'), 'the confirmation text renders')
  assert.ok(html.includes('role="status"'), 'the confirmation is a live status region')
  assert.ok(html.includes('data-testid="sender-saved"'), 'the confirmation carries its test id')
})

test('an empty name renders the disabled-Save hint that says why', () => {
  const html = renderToStaticMarkup(h(SenderInline, { initial: null, onSaved: noop }))
  assert.ok(html.includes('Add your name to save.'), 'the missing-name hint renders')
  assert.ok(html.includes('disabled'), 'Save is disabled while the name is empty')
})

test('a short address renders its own hint', () => {
  const html = renderToStaticMarkup(h(SenderInline, { initial: { sender_name: 'Pat', postal_address: '1 Main' }, onSaved: noop }))
  assert.ok(html.includes('Your mailing address needs at least 10 characters.'), 'the address hint renders')
})

test('valid sender details render no hint and an enabled Save', () => {
  const html = renderToStaticMarkup(h(SenderInline, { initial: { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' }, onSaved: noop }))
  assert.ok(!html.includes('sender-save-hint'), 'no hint once the form can save')
  assert.ok(!html.includes('disabled'), 'Save is enabled')
})
