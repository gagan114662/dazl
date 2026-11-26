// #1715: internal jargon, typos and mixed signals in signed-in app copy — one pin per fixed
// string, grouped by screen. Quest found these on prod (QA account, 389px): operator and
// engineering words, doubled nouns, and concatenated card text shown to customers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

test('#1715 Outreach sequences: no operator jargon on the resume button', () => {
  const src = read('../app/app/outreach/sequences-client.tsx')
  assert.ok(!src.includes('Resume after resolving unknown sends'), 'the old jargon label is gone')
  assert.ok(src.includes('>Resume sending</button>'), 'the button says what it does in plain words')
})

test('#1715 sender form: a greyed Save says why, and a successful save confirms', () => {
  const form = read('../app/app/sender-inline.tsx')
  // Why Save is greyed, in words, next to the button (the server rule: a name, and an address of 10+ characters).
  assert.match(form, /data-testid="sender-save-hint"/, 'a hint element explains the disabled Save')
  assert.ok(form.includes('at least 10 characters'), 'the address length rule is said out loud')
  assert.ok(form.includes('Add your name'), 'the missing-name case is said out loud')
  // A successful save confirms on screen instead of silence.
  assert.ok(form.includes("setMsg('Saved.')"), 'success sets a visible confirmation')
  // The saved values travel to the parent, so the readiness status updates at once, not on a later reload.
  assert.match(form, /onSaved\(\{ sender_name: name\.trim\(\), postal_address: address\.trim\(\) \}\)/, 'onSaved receives what was saved')
})

test('#1715 sender form: editing a field clears the old save message, so the disabled-Save hint can show', () => {
  const form = read('../app/app/sender-inline.tsx')
  assert.match(form, /onChange=\{e => \{ setName\(e\.target\.value\); if \(msg\) setMsg\(''\) \}\}/, 'the name field clears the message on edit')
  assert.match(form, /onChange=\{e => \{ setAddress\(e\.target\.value\); if \(msg\) setMsg\(''\) \}\}/, 'the address field clears the message on edit')
})

test('#1715 the Saved. confirmation is rendered by the parents, which unmount the form on save', () => {
  for (const p of ['../app/app/outreach/send-readiness.tsx', '../app/app/readiness.tsx', '../app/app/onboarding/first-review.tsx']) {
    const src = read(p)
    assert.ok(src.includes('SenderSavedNote'), `${p} renders the parent-side confirmation`)
    assert.ok(src.includes('setSenderSaved(true)'), `${p} sets its saved flag in onSaved`)
  }
  const form = read('../app/app/sender-inline.tsx')
  assert.ok(form.includes('data-testid="sender-saved"'), 'the confirmation element carries its test id')
})

test('#1715 Resume sending: the unknown-send precondition is stated and its error code is mapped', () => {
  const src = read('../app/app/outreach/sequences-client.tsx')
  assert.ok(src.includes("uncertain_send:'A send with an unknown outcome is holding all sending"), 'the resume error code maps to plain words, never a raw code')
  assert.ok(src.includes('Resume sending works once all of them are resolved.'), 'the precondition is stated next to the button')
})

test('#1715 send readiness: a save updates the shown status immediately', () => {
  const src = read('../app/app/outreach/send-readiness.tsx')
  assert.match(src, /onSaved=\{\(saved\) => \{ setSenderSaved\(true\); setS\(prev => prev \? \{ \.\.\.prev, sender: \{ \.\.\.saved, booking_url: prev\.sender\?\.booking_url \?\? null \} \} : prev\); void load\(\) \}\}/, 'the saved sender is merged into the shown status at once, then re-read for truth')
})
