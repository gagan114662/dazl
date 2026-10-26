import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Owner direction #204: when the user's own constraint excluded results, say so and offer to widen it explicitly; never
// relax it quietly. The leads page counts outside_window leads and offers a doubled window (max 365) through the profile
// editor - the run happens only when the user presses run, and an edited profile window wins over the request text.
test('leads page states how many results the window excluded and offers an explicit, user-run widening', () => {
  const src = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  assert.match(src, /review_reason === 'outside_window'/)
  assert.match(src, /older than your \{icp\.icp\.window_days\}-day window/)
  assert.match(src, /Math\.min\(365, icp\.icp\.window_days \* 2\)/)
  assert.match(src, /setDraft\(\{ \.\.\.icp\.icp, window_days: wider \}\)/) // pre-fills the editor; does not start a scan
})

test('an edited profile window wins over the window in the request text', () => {
  const runner = readFileSync(new URL('../lib/scan/runner.ts', import.meta.url), 'utf8')
  assert.match(runner, /if \(win && !icp\.window_days\)/)
})
