import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseLeads } from '../lib/discover/agent.ts'
import { checkLead, dayOnPage } from '../lib/discover/check.ts'

test('a partial update date and an unrelated year do not establish an event day', () => {
  assert.equal(dayOnPage('2026-11-24', 'Updated on Nov 24 … © 2026 … 24 items'), false)
})

test('a complete posting date in the source establishes the stated day', () => {
  assert.equal(dayOnPage('2026-11-24', 'Posted November 24, 2026'), true)
  assert.equal(dayOnPage('2026-11-24', 'Posted 11/24/2026'), true)
  assert.equal(dayOnPage('2026-11-24', 'Posted 2026-11-24'), true)
  assert.equal(dayOnPage('2026-11-24', 'Posted 24 November 2026'), true)
})

test('a complete update or copyright date does not establish an event day', () => {
  assert.equal(dayOnPage('2026-11-24', 'Last updated on November 24, 2026'), false)
  assert.equal(dayOnPage('2026-11-24', 'Modified: 2026-11-24'), false)
  assert.equal(dayOnPage('2026-11-24', '© 11/24/2026'), false)
})

test('a search claim cannot supply the event date when the cited page was not opened', async () => {
  const url = 'https://news.example/new-office'
  const [lead] = parseLeads(JSON.stringify({ leads: [{
    company: 'Example Company', signal: 'Opening a new office', signal_date: '2026-11-24', evidence_url: url,
    why: 'Proof taken from the search-result text; page not opened',
  }] }), 1).leads
  const blocked: typeof fetch = async () => new Response(null, { status: 403 })
  const result = await checkLead(lead, [{ url, title: 'Example Company to open a new office', page_age: null, text: null }], blocked)

  assert.equal(result.proof_read_by, null)
  assert.equal(result.date_on_page, false)
  assert.equal(result.date, null)
})

test('an opened page with only an update date leaves the event undated', async () => {
  const url = 'https://news.example/open-role'
  const [lead] = parseLeads(JSON.stringify({ leads: [{
    company: 'Example Company', signal: 'Hiring a designer', signal_date: '2026-11-24', evidence_url: url,
  }] }), 1).leads
  const result = await checkLead(lead, [{
    url, title: 'Example Company is hiring a designer', page_age: null,
    text: 'Example Company is hiring a designer. Updated on November 24, 2026.',
  }])

  assert.equal(result.proof_read_by, 'reader')
  assert.equal(result.date_on_page, false)
  assert.equal(result.date, null)
})
