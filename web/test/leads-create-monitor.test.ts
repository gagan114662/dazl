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
