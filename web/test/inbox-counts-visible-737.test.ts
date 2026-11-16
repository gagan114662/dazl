// #737: the Inbox "All / Needs you / Unread" totals come from stored rows (lib/outreach/inbox.ts), not a live Gmail
// read, so they show whenever there are stored threads, even before reply-read consent. Hermes' live check could not
// compare Inbox "Needs you N" with the Outcomes tile because the filter bar was hidden behind consent_accepted.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { showInboxList } from '../lib/outreach/inbox-view.ts'

const counts = (threads: number) => ({ threads, needs_owner: Math.ceil(threads / 2), unread: threads, unread_needs_owner: Math.ceil(threads / 2) })

test('#737 Inbox totals show for stored threads without reply-read consent (fixture tenant)', () => {
  // The fixture tenant on staging: read granted, consent not accepted, 121 stored threads.
  assert.equal(showInboxList({ consent_accepted: false, read_granted: true, counts: counts(121), threads: [] }), true)
  // No Gmail at all but stored rows (e.g. disconnected later): the stored conversations and their totals still show.
  assert.equal(showInboxList({ consent_accepted: false, read_granted: false, counts: counts(3), threads: [] }), true)
  // A page of rows with no counts object still counts as stored threads.
  assert.equal(showInboxList({ consent_accepted: false, read_granted: false, counts: null, threads: [{}] }), true)
})

test('#737 Inbox list stays hidden when there is nothing stored and no consent; consented users always see it', () => {
  assert.equal(showInboxList({ consent_accepted: false, read_granted: true, counts: counts(0), threads: [] }), false)
  assert.equal(showInboxList({ consent_accepted: false, read_granted: false, counts: undefined, threads: undefined }), false)
  assert.equal(showInboxList({ consent_accepted: true, read_granted: true, counts: counts(0), threads: [] }), true)
})

test('#737 the Inbox page gates its filter bar, loading and empty states on showInboxList, not on consent alone', () => {
  const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app/app/inbox/inbox-client.tsx'), 'utf8')
  assert.match(src, /showInboxList\(/)
  assert.doesNotMatch(src, /\{i\.consent_accepted && i\.read_granted && \(/, 'filter bar must not be gated on consent alone')
  assert.doesNotMatch(src, /&& i\.consent_accepted && i\.read_granted &&/, 'empty state must not be gated on consent alone')
  // The Connect Gmail gate itself still shows until consent is given.
  assert.match(src, /\(!i\.consent_accepted \|\| !i\.read_granted\) && \(\s*<GmailGate/)
})
