import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const smoke = readFileSync(new URL('./smoke/stall-watch.smoke.mjs', import.meta.url), 'utf8')
const settingsPlan = readFileSync(new URL('../app/app/settings/plan-panel.tsx', import.meta.url), 'utf8')

test('the download anchor is inserted after the Settings Plan panel renders on the client', () => {
  assert.match(settingsPlan, /if \(!u\) return null[\s\S]*data-testid="plan-panel"/)
  const insertion = smoke.indexOf("a.id = 'plain-download'")
  assert.ok(insertion !== -1, 'step C still exercises the download anchor')
  const beforeInsertion = smoke.slice(0, insertion)
  assert.match(beforeInsertion, /await page\.locator\('main'\)\.getByTestId\('plan-panel'\)\.waitFor\(\)/)
})

test('stall-watch fails on every write, including a hydration error report', () => {
  assert.match(smoke, /assert\.deepEqual\(writes, \[\], `nothing written/)
  assert.doesNotMatch(smoke, /STALL_WRITE_QUARANTINE|unexpectedStallWrites/)
})
