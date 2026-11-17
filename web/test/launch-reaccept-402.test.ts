// #402 follow-up (Hermes-PC, on #1120 merged as 36931772): GET /api/outreach/autopilot returns launch.paused_because and
// launch.reaccept_action, but nothing in the app showed them or posted that action. These tests fail without the UI half.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LaunchPause, reacceptBody, preflightLines } from '../app/app/settings/launch-pause.ts'

const WHY = 'Autopilot is paused: what dazl ships changed since you accepted your launch policy (record pt-a is now pt-b). Re-accept the current record to resume.'

test('AC-1: a launch paused by a product truth change shows the one-line reason', () => {
  const html = renderToStaticMarkup(h(LaunchPause, { launch: { paused_because: WHY, reaccept_action: 'reaccept_product_truth' }, onReaccept: () => {} }))
  assert.ok(html.includes('record pt-a is now pt-b'), html)
  assert.ok(html.includes('data-launch-paused'), html)
})

test('AC-2: a "Re-accept current record" button posts {action: launch.reaccept_action}', () => {
  const html = renderToStaticMarkup(h(LaunchPause, { launch: { paused_because: WHY, reaccept_action: 'reaccept_product_truth' }, onReaccept: () => {} }))
  assert.match(html, /<button[^>]*>Re-accept current record<\/button>/)
  assert.deepEqual(reacceptBody({ paused_because: WHY, reaccept_action: 'reaccept_product_truth' }), { action: 'reaccept_product_truth' })
})

test('AC-2: nothing renders when the launch is not paused by a record change', () => {
  assert.equal(renderToStaticMarkup(h(LaunchPause, { launch: { accepted: null }, onReaccept: () => {} })), '')
  assert.equal(renderToStaticMarkup(h(LaunchPause, { launch: undefined, onReaccept: () => {} })), '')
  assert.equal(reacceptBody({ accepted: null }), null)
})

test('AC-3: a failed re-accept shows the preflight details, not just a generic error', () => {
  // real shapes from POST /api/outreach/autopilot: a failed preflight (PreflightResult) and an incomplete policy (PolicyProblem[])
  const lines = preflightLines({ ok: false, preflight: { ok: false, failures: ['mailbox_mismatch', 'too_few_samples'], heldLeads: ['lead-1'] } })
  assert.deepEqual(lines, ['mailbox mismatch', 'too few samples', 'held leads: lead-1'])
  assert.deepEqual(preflightLines({ error: 'The launch policy is incomplete', problems: ['product_truth_not_current'] }), ['product truth not current'])
  assert.deepEqual(preflightLines({ ok: true }), [])
  const html = renderToStaticMarkup(h(LaunchPause, { launch: { paused_because: WHY, reaccept_action: 'reaccept_product_truth' }, onReaccept: () => {}, details: lines }))
  assert.ok(html.includes('mailbox mismatch'), html)
})

test('AC-4: the settings autopilot panel renders LaunchPause from the GET launch payload and reloads after', () => {
  const src = readFileSync(new URL('../app/app/settings/autopilot-panel.tsx', import.meta.url), 'utf8')
  assert.ok(src.includes("from './launch-pause'"), 'panel imports LaunchPause')
  assert.ok(src.includes('<LaunchPause launch={i.launch}'), 'panel renders it with the launch payload')
})
