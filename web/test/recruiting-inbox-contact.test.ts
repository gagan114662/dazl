// #461: a recruiting inbox (careers@, jobs@, talent@ ...) is never kept as a verified lead's sales contact. The event can
// still be verified on its evidence; the inbox is not its contact and earns no confidence. Buyer-facing mailboxes and
// look-alike personal addresses are unchanged. Synthetic pages only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyEvidence, isRecruitingInbox, type Candidate } from '../lib/scan/evidence.ts'
import type { Page } from '../lib/scan/fetch-page.ts'

const NOW = new Date('2026-10-20T12:00:00Z')
const cand = (contact: string): Candidate => ({ name: '', company: 'Harbourfront Studio', contact, signal: 'Opened a new office', source_url: 'https://news.example/harbourfront', score: 70, excerpt: 'Harbourfront Studio, a Toronto marketing agency, opened a new office in Liberty Village', event_date: '2026-10-12' })
const page = (contact: string): Page => ({ title: 'Harbourfront Studio', retrievedAt: NOW.getTime(), text: `2026-10-12. Harbourfront Studio, a Toronto marketing agency, opened a new office in Liberty Village this month. Contact: ${contact}. The studio works with consumer brands in Canada.` })

test('#461: a recruiting inbox on the page is not kept as the contact, and earns no confidence; the event still verifies', () => {
  for (const inbox of ['careers@harbourfront.example', 'jobs@harbourfront.example', 'talent@harbourfront.example', 'recruiting@harbourfront.example', 'hr@harbourfront.example', 'apply@harbourfront.example', 'join-us@harbourfront.example', 'careers+toronto@harbourfront.example', 'Talent.Acquisition@harbourfront.example']) {
    const v = verifyEvidence(cand(inbox), page(inbox), NOW)
    assert.ok(v.ok, inbox)
    if (!v.ok) continue
    assert.equal(v.contact, null, inbox)          // before the fix: the inbox, kept as the verified lead's contact
    assert.equal(v.confidence, 55, inbox)         // 70 - 15 (date not bound): no +10 for a contact
  }
})

test('#461 controls: buyer-facing mailboxes and look-alike personal addresses are kept as before', () => {
  for (const ok of ['hello@harbourfront.example', 'sales@harbourfront.example', 'hrishi@harbourfront.example', 'jobsworth@harbourfront.example', 'sales+careers@harbourfront.example', 'jane.doe@harbourfront.example']) {
    const v = verifyEvidence(cand(ok), page(ok), NOW)
    assert.ok(v.ok && v.contact === ok && v.confidence === 65, ok)
  }
  // a contact not on the page is still dropped, as before
  const v = verifyEvidence(cand('sales@harbourfront.example'), page('hello@harbourfront.example'), NOW)
  assert.ok(v.ok && v.contact === null)
  // phones are not mailboxes
  assert.equal(isRecruitingInbox('+1 416 555 0100'), false)
})
