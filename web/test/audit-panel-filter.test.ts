import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('#1620 Settings audit filters keep every category except Autopilot', () => {
  const panel = readFileSync(new URL('../app/app/settings/audit-panel.tsx', import.meta.url), 'utf8')
  const filters = panel.match(/const FILTERS = (\[[\s\S]*?\]) as const/)?.[1]
  assert.ok(filters, 'expected the Show filter options')
  assert.deepEqual(Array.from(filters.matchAll(/\['([^']*)',\s*'([^']+)'\]/g), m => [m[1], m[2]]), [
    ['', 'Everything'], ['credential.', 'Credentials'], ['billing.', 'Billing'], ['crm.', 'CRM'],
    ['export.', 'Exports'], ['pipeline.', 'Pipeline'], ['outreach.', 'Sending'], ['sequence.', 'Sequences'],
    ['followups.', 'Follow-ups'], ['monitor.', 'Monitors'], ['settings.', 'Settings'], ['consent.', 'Consent'],
    ['connector.', 'Channels'], ['onboarding.', 'Onboarding'], ['data.', 'Deletions'],
  ])
})
