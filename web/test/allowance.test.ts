// lib/billing/allowance.ts states each plan's allowance once for Settings, sign-up and the public plans section. These
// tests hold it to what the code enforces, so the copy cannot drift from the limits, and keep the pages on it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ACTIVE_SCANS, FREE_LINE, FREE_SCANS_PER_MONTH, LIMITS_LINE, PRO_LINE, SCAN_STARTS_PER_HOUR, TRIAL_SCANS, usageLine } from '../lib/billing/allowance.ts'
import { PLAN_LIMITS } from '../lib/plans.ts'
import { TRIAL_SCANS_PER_ACCOUNT } from '../lib/scan/trial.ts'

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('the stated allowance is the enforced one', () => {
  assert.equal(FREE_SCANS_PER_MONTH, PLAN_LIMITS.free.scansPerMonth)
  assert.equal(PLAN_LIMITS.pro.scansPerMonth, null, 'Pro has no monthly cap, as PRO_LINE says')
  assert.equal(TRIAL_SCANS, TRIAL_SCANS_PER_ACCOUNT)
  // the scan route: the hourly start limit and one active scan, on every plan
  const scan = src('app/api/scan/route.ts')
  assert.match(scan, new RegExp(`rateLimit\\(\`scan:\\$\\{user\\.id\\}\`, ${SCAN_STARTS_PER_HOUR}, 60 \\* 60 \\* 1000\\)`))
  assert.match(scan, new RegExp(`countActiveJobs\\(db, user\\.id\\) >= ${ACTIVE_SCANS}\\b`))
  // trial scans are not counted in the month (lib/plans.ts SCANS_THIS_MONTH_SQL), so Free still has its 50 after them
  assert.match(src('lib/plans.ts'), /funded_by != 'trial'/)
})

test('the lines say it plainly, with no "unlimited" or "fair use"', () => {
  for (const l of [FREE_LINE, PRO_LINE, LIMITS_LINE, usageLine('pro', 7, null), usageLine('free', 3, 50)]) assert.doesNotMatch(l, /unlimited|fair[- ]use/i, l)
  assert.equal(usageLine('free', 3, 50), '3 of 50 scans used this month.')
  assert.equal(usageLine('pro', 7, null), '7 scans this month. Pro has no monthly scan cap.')
  assert.match(FREE_LINE, /50 scans a month/); assert.match(FREE_LINE, /first 3 scans are free and need no AI key/)
  assert.match(LIMITS_LINE, /10 scan starts an hour, one scan running at a time/)
})

test('Settings, sign-up and the public plans section render the shared lines, not their own numbers', () => {
  const pages = { 'app/app/settings/plan-panel.tsx': ['usageLine', 'LIMITS_LINE', 'AI_COST_LINE'], 'app/sign-up/page.tsx': ['FREE_LINE'], 'app/page.tsx': ['FREE_LINE', 'PRO_LINE', 'LIMITS_LINE', 'AI_COST_LINE', 'PRO_PRICE_USD_MONTH'] }
  for (const [p, names] of Object.entries(pages)) {
    const s = src(p)
    assert.match(s, /from '@\/lib\/billing\/allowance'/, p)
    for (const n of names) assert.ok(s.includes(`{${n}`) || s.includes(`${n}(`), `${p} renders ${n}`)
    assert.doesNotMatch(s, /unlimited|fair[- ]use|50 scans a month|3 trial scans/i, `${p} states an allowance of its own`)
  }
})
