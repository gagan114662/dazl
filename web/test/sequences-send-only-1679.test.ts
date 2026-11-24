// #1679 (Quest walkthrough, production, 2026-11-24): the Outreach page told a new account that cold sequences need "Reply reading must
// stay connected" and to "Enable reply reading in Settings", while Settings and Inbox say new Gmail connections are send-only (#1603).
// No new account can turn reading on, so the page pointed at a step that does not exist. It now says the one true thing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../app/app/outreach/sequences-client.tsx', import.meta.url), 'utf8')

test('#1679 Outreach never tells an account to enable reply reading, which a send-only connection cannot do', () => {
  assert.doesNotMatch(src, /Reply reading must stay connected/)
  assert.doesNotMatch(src, /Enable reply reading in Settings/)
})

test('#1679 with reply reading off, the sequences section says sequences are not available and what still works', () => {
  const m = /const SEQUENCES_NEED_READING = '([^']+)'/.exec(src)
  assert.ok(m, 'one sentence, defined once')
  assert.match(m[1], /Follow-up sequences are not available for your account/)
  assert.match(m[1], /send-only and does not read replies/)
  assert.match(m[1], /Nothing is sent automatically/)
  assert.match(m[1], /approve and send each email yourself/)
  // shown when the reading prerequisite is not met, and used for the server's refusal of an approval
  assert.match(src, /g\.id==='read_consent'&&!g\.ok\)&&<p[^>]*data-testid="sequences-need-reading"[^>]*>\{SEQUENCES_NEED_READING\}/)
  assert.match(src, /reading_not_enabled: SEQUENCES_NEED_READING/)
})
