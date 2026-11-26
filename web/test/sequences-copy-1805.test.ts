import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// #1805: the Sequences panel described the shared send limit as 'in 24 hours', which reads like a rolling
// window. Settings describes the same limit as a per-day count that starts again at midnight; the two
// surfaces must keep saying the same thing.
const sequences = readFileSync(new URL('../app/app/outreach/sequences-client.tsx', import.meta.url), 'utf8')
const settings = readFileSync(new URL('../app/app/settings/gmail-panel.tsx', import.meta.url), 'utf8')

test('#1805: the sequences limit line matches Settings - per day, resetting at midnight', () => {
  assert.ok(sequences.includes('One shared limit of 20 emails per account per day, resetting at midnight your time.'),
    'the sequences panel states the shared limit as a per-day count that resets at midnight')
  assert.ok(!sequences.includes('in 24 hours'), 'no rolling-window wording remains on the sequences panel')
  assert.ok(settings.includes('The count starts again at midnight'), 'Settings still states the midnight reset this line matches')
})
