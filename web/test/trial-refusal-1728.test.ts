// #1728: a refused free-trial scan must not show money-left lines beside the refusal.
// Fo on prod: a domain_used refusal (402) rendered with "Free trial scans stop at $0.75." and
// "This run's limit: $0.75 ... $0.75 left" in the same panel — the money contradicts the block.
// The panel (estimate-confirm.tsx) already knows the verdict; when the verdict is a trial
// refusal it renders only the refusal and what to do next. The copy functions in
// price-estimate.ts are unchanged: a runnable trial estimate still shows its lines.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { customerView } from '../lib/scan/price-estimate.ts'

const panel = readFileSync(new URL('../app/app/leads/estimate-confirm.tsx', import.meta.url), 'utf8')

test('#1728 the panel derives trial refusal from the verdict', () => {
  assert.match(panel, /const trialRefused = !v\.ok && v\.reason === 'trial_unavailable'/, 'one named condition for a trial refusal, from the verdict the panel already has')
})

test('#1728 no money lines beside a trial refusal', () => {
  assert.match(panel, /\{!trialRefused && view\.trial_cap_line &&/, 'the "Free trial scans stop at $X" line hides on a refusal')
  assert.match(panel, /\{!trialRefused && est\.payer === 'trial' && est\.trial_allowance &&/, 'the "$X of your $Y free trial allowance left" line hides on a refusal')
  assert.match(panel, /\{!trialRefused && capLine\(est\.cap, view\.capped_total\) &&/, 'the "This run\'s limit ... $X left" line hides on a refusal')
})

test('#1728 the refusal itself and the way forward still render', () => {
  assert.match(panel, /<TrialRefusalNotice reason=\{v\.trial_refusal\}/, 'the plain refusal notice is untouched')
  assert.match(panel, /data-testid="estimate-change"/, 'the what-to-change list still renders for other blocks')
})

test('#1728 a runnable trial estimate still gets its cap line from customerView', () => {
  const view = customerView({ rows: [], total: { min: 0, max: 0 }, assumptions: [], payer: 'trial', trial_scan_cap_usd: 0.75 })
  assert.ok(view.trial_cap_line && view.trial_cap_line.includes('0.75'), 'the line still exists — the panel gate, not the copy, hides it on a refusal')
})
