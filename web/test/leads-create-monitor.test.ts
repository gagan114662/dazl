// Source invariant (Refs #898): the Leads page keeps a visible "create monitor" action wired to POST /api/monitors.
// The cleanup in #898 removed addMonitor as unused because no button called it; the owner wants the action, so this
// fails if the button or its wiring disappears again. The rendered behaviour is checked in test/ui/create-monitor.ui.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app/app/leads/leads-client.tsx'), 'utf8')

test('Leads renders a create-monitor button that calls createMonitorFromSearch', () => {
  assert.match(src, /data-testid="create-monitor" onClick=\{\(\) => void createMonitorFromSearch\(\)\}/)
})
test('the button has a 44x44 hit area', () => {
  const btn = src.slice(src.indexOf('data-testid="create-monitor"'), src.indexOf('Creating monitor'))
  assert.match(btn, /min-h-11/); assert.match(btn, /min-w-11/)
})
test('addMonitor posts the search to /api/monitors and surfaces plan refusals', () => {
  const fn = src.slice(src.indexOf('const addMonitor'), src.indexOf('const toggleMonitor'))
  assert.match(fn, /fetch\('\/api\/monitors', \{ method: 'POST'/)
  assert.match(fn, /monitor_limit/)
  assert.match(fn, /interval_too_short/)
})

// Review finding on #962: "Monitoring ..." must only show on a positively confirmed create (201 with an id); a lost
// connection or a 2xx body that is not JSON / has no id explains the unknown outcome, never retries, and sends the user
// to the list instead of claiming success.
test('addMonitor requires a confirmed id and reports network loss instead of throwing', () => {
  const fn = src.slice(src.indexOf('const addMonitor'), src.indexOf('const toggleMonitor'))
  assert.match(fn, /try \{ r = await fetch\('\/api\/monitors'/)
  assert.match(fn, /catch \{ setMonError\('Connection lost/)
  assert.match(fn, /j\.id === undefined/)
  assert.match(fn, /did not confirm the monitor/)
  assert.doesNotMatch(fn, /setTimeout|retry/i)
})
