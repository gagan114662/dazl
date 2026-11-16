// Refs #694: the backup targets in docs/RECOVERY.md are recorded as owner-approved
// (Gagan delegated the decision to Hermes; Hermes confirmed on #694, 2026-11-12).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const doc = readFileSync(new URL('../../docs/RECOVERY.md', import.meta.url), 'utf8')
const targets = doc.slice(doc.indexOf('## Targets'), doc.indexOf('## Key recovery'))

test('#694 targets are labelled owner-approved, not a Hermes-only decision', () => {
  assert.match(targets, /Owner-approved \(delegated to Hermes, 2026-11-12[;)]/)
  assert.doesNotMatch(targets, /under delegation/)
  assert.doesNotMatch(doc, /set \(Hermes decision under delegation\)/)
})

test('#694 recorded RPO/RTO/retention values and drill flags agree', () => {
  assert.match(targets, /RPO, data loss on host or disk loss \| \*\*1 hour\*\*/)
  assert.match(targets, /RTO, database corrupted[^|]*\| \*\*30 minutes\*\*/)
  assert.match(targets, /RTO, host lost \| \*\*4 hours\*\*/)
  assert.match(targets, /Retention, local \| 48 hourly/)
  assert.match(targets, /Retention, off-host \| 14 daily plus 8 weekly/)
  assert.match(targets, /--rpo-target-s 3600 --rto-target-s 14400/)
})
