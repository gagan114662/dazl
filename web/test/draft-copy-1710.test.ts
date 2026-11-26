// #1710: drafts read like a system log. The new composer (lib/outreach/draft-copy.ts) must produce a short
// personal note: the lead's own saved words referenced in prose, the seller's offer as a sentence, no raw
// URLs, no system wording. This file fails on main (the composer does not exist there) and pins the
// acceptance strings from the issue: no 'Saved excerpt', no 'contact address published', no 'About <name>:',
// no http(s) URL anywhere in the draft.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeDraftCopy, DraftCopyError } from '../lib/outreach/draft-copy.ts'

// The prod repro shape (Quest, MadeThis draft): address page differs from the source page, excerpt present,
// offer is the raw stored profile line.
const lead = (over: Record<string, unknown> = {}) => ({
  name: 'Alex Chen', company: 'MadeThis', confidence: 90, signal: 'MadeThis is hiring SDRs',
  evidence_excerpt: 'MadeThis is hiring two SDRs to sell its AI design tool',
  source_url: 'https://madethis.example/about', ...over,
})
const OFFER = 'a B2B sales-automation SaaS to small marketing agencies'
const BANNED = /Saved excerpt|contact address published|About \S+:|https?:\/\//

test('the composed draft contains none of the system-log strings and no URL', () => {
  const d = composeDraftCopy(lead(), 'dazl', OFFER)
  assert.doesNotMatch(d.subject + '\n' + d.body, BANNED)
})

test('it is a short personal note: first name, the signal in words, the offer as a sentence, one ask', () => {
  const d = composeDraftCopy(lead(), 'dazl', OFFER)
  assert.match(d.body, /^Hi Alex,/)
  assert.match(d.body, /I saw MadeThis is hiring two SDRs/, 'the saved signal is referenced in plain words')
  assert.doesNotMatch(d.body, /"/, 'the source sentence is not quoted word for word in quotation marks')
  assert.match(d.body, /we offer a B2B sales-automation SaaS/, 'the profile line becomes a sentence, not a paste')
  assert.match(d.body, /Open to a quick chat\?/, 'one short ask')
  assert.ok(d.body.trimEnd().endsWith('Thanks,'), 'signs off like the template contract (the footer adds the sender name)')
  assert.match(d.subject, /MadeThis/)
  const words = d.body.split(/\s+/).filter(Boolean).length
  assert.ok(words <= 120, `body is ${words} words, over the 120 cap`)
})

test('no excerpt and no signal: still a complete note, and nothing is invented to fill the gap', () => {
  const d = composeDraftCopy(lead({ evidence_excerpt: null, signal: null }), 'dazl', OFFER)
  assert.doesNotMatch(d.body, BANNED)
  assert.doesNotMatch(d.body, /hiring|SDR/, 'no signal is fabricated')
  assert.match(d.body, /^Hi Alex,/)
  assert.match(d.body, /we offer a B2B sales-automation SaaS/)
})

test('a verb-led offer reads as a sentence too, and a long offer is trimmed at a word boundary', () => {
  const d = composeDraftCopy(lead(), 'dazl', 'Find leads from public signals, with source links and quotes, for small sales teams everywhere in the world today')
  assert.match(d.body, /At dazl, we find leads from public signals/)
  const words = d.body.split(/\s+/).filter(Boolean).length
  assert.ok(words <= 120, `body is ${words} words, over the 120 cap`)
})

test('a bare noun-phrase offer is framed with we offer, never as a broken verb sentence', () => {
  const a = composeDraftCopy(lead(), 'dazl', 'Public-source lead finding software.')
  assert.match(a.body, /At dazl, we offer public-source lead finding software\./)
  const b = composeDraftCopy(lead(), 'dazl', 'Sales prospecting software for B2B sales teams')
  assert.match(b.body, /At dazl, we offer sales prospecting software for B2B sales teams\./)
  assert.doesNotMatch(b.body, /we sales prospecting/)
})

test('missing seller name or offer refuses with the same codes the template uses', () => {
  assert.throws(() => composeDraftCopy(lead(), '', OFFER), (e: unknown) => e instanceof DraftCopyError && e.code === 'seller_context_required')
  assert.throws(() => composeDraftCopy(lead(), 'dazl', ''), (e: unknown) => e instanceof DraftCopyError && e.code === 'seller_offer_required')
  assert.throws(() => composeDraftCopy(lead(), 'dazl', '   '), (e: unknown) => e instanceof DraftCopyError && e.code === 'seller_offer_required')
})

test('(Qodo) a third-person offer opener is converted to its base verb after "we"', () => {
  const d = composeDraftCopy(lead(), 'dazl', 'Helps sales teams close deals')
  assert.match(d.body, /At dazl, we help sales teams close deals\./)
  assert.doesNotMatch(d.body, /we helps/)
})

test('(Qodo) URLs embedded in the excerpt or the offer never reach the draft', () => {
  const d = composeDraftCopy(lead({ evidence_excerpt: 'MadeThis is hiring: https://madethis.example/jobs two SDRs' }), 'dazl', 'Find leads at https://dazl.example/pricing for sales teams')
  assert.doesNotMatch(d.subject + '\n' + d.body, /https?:\/\/|www\./)
  assert.match(d.body, /I saw MadeThis is hiring/)
})

test('(Qodo) the 120-word cap holds even when every field is many short words', () => {
  const many = (n: number) => Array.from({ length: n }, () => 'a').join(' ')
  const d = composeDraftCopy(lead({ evidence_excerpt: `MadeThis ${many(300)}` }), 'dazl', many(300))
  const words = d.body.split(/\s+/).filter(Boolean).length
  assert.ok(words <= 120, `body is ${words} words`)
})

test('unverified and human-only excerpts never produce an I saw opener', () => {
  for (const unverified of [
    { ...lead(), confidence: null, human_confirmed_at: null },
    { ...lead(), confidence: null, human_confirmed_at: 1 },
    { ...lead(), evidence_excerpt: null },
  ]) {
    const draft = composeDraftCopy(unverified, 'dazl', OFFER)
    assert.doesNotMatch(draft.body, /\bI saw\b|hiring|SDRs/i)
  }
})

test('a capitalized article is lowered in the offer while B2B and SaaS keep their casing', () => {
  for (const offer of [OFFER, 'A' + OFFER.slice(1)]) {
    assert.match(composeDraftCopy(lead(), 'dazl', offer).body, /At dazl, we offer a B2B sales-automation SaaS to small marketing agencies\./)
  }
  assert.match(composeDraftCopy(lead(), 'dazl', 'B2B sales-automation SaaS').body, /At dazl, we offer B2B sales-automation SaaS\./)
})

test('a held signal with a stored excerpt still gets a neutral opener', () => {
  const held = { ...lead(), review_reason: 'quote_unconfirmed' }
  assert.doesNotMatch(composeDraftCopy(held, 'dazl', OFFER).body, /\bI saw\b|hiring|SDRs/i)
})

test('a verified signal day is included in the opener, with one short ask', () => {
  const dated = { ...lead(), event_date: '2025-11-12', event_date_proof: 'page_bound' }
  const { body } = composeDraftCopy(dated, 'dazl', OFFER)
  assert.match(body, /November 12, 2025.*MadeThis is hiring two SDRs/i)
  assert.match(body, /Open to a quick chat\?/)
  assert.equal((body.match(/\?/g) ?? []).length, 1)
})

test('unverified, future and held signal days stay out of the draft', () => {
  for (const fields of [
    { event_date: '2025-11-12', event_date_proof: null },
    { event_date: '2999-11-12', event_date_proof: 'page_bound' },
    { event_date: '2025-11-12', event_date_proof: 'page_bound', review_reason: 'needs_review' },
  ]) {
    assert.doesNotMatch(composeDraftCopy({ ...lead(), ...fields }, 'dazl', OFFER).body, /November 12/)
  }
})
