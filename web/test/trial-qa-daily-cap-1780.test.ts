import assert from 'node:assert/strict'
import { test } from 'node:test'
import { trialCopy, trialSummary, type TrialBlock } from '../lib/trial-copy.ts'

const qa: TrialBlock = { funded: true, remaining: 3, cap: 3, blocked: null, exempt: true, used: 5 }

test('#1780: the daily cap takes precedence over the QA account exemption', () => {
  const capped = { ...qa, funded: false, blocked: 'global_daily_cap' }
  const expected = {
    state: 'throttled',
    text: "Today's free searches are fully booked. Try again tomorrow (it resets at midnight UTC).",
  }

  assert.deepEqual(trialSummary(capped), expected)
  assert.deepEqual(trialCopy(capped), {
    ...expected,
    next: { label: 'Try again tomorrow', href: '/app/leads' },
  })
})

test('#1780: the QA usage count remains visible when searches are available', () => {
  assert.deepEqual(trialSummary(qa), {
    state: 'available',
    text: 'QA account: unlimited free searches (5 used).',
  })
})
