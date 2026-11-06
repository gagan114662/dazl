// Independent evidence verifier, deterministic checks only (#780, part of #395). Every company, page and address below
// is SYNTHETIC and every source is a hand-built fixture: decide() is exercised directly with bounded, injected
// Snapshot[] fixtures, never a real fetch, never a model judge, never a paid call. Scope: company/domain/geography and
// event date corroboration, and cross-source date conflicts - wrong-city, same-name-different-domain, a stale
// publication date standing in for the event date, a future-dated event, and sources that disagree never pass, and
// uncertain evidence holds (unknown) rather than being accepted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { blindClaim, type LeadClaim } from '../lib/verifier/claim.ts'
import { decide, overall, type Snapshot } from '../lib/verifier/checks.ts'
import { linkedDomains, metadataDays, htmlToText } from '../lib/verifier/text.ts'

const AS_OF = '2026-11-06T12:00:00.000Z'
const WINDOW_DAYS = 90

const page = (body: string, head = '') => `<html><head><title>Synthetic</title>${head}</head><body>${body}</body></html>`
const snap = (url: string, html: string, opts: Partial<Snapshot> = {}): Snapshot => ({
  url, outcome: 'ok', final_url: url, text: htmlToText(html), truncated: false,
  meta_days: metadataDays(html), linked_domains: [...linkedDomains(html)], ...opts,
})

const OWN = 'https://harborledger.example/news/london-office'
const CLAIM: LeadClaim = {
  company: 'Harbor Ledger Analytics', domain: 'harborledger.example',
  place: { city: 'London', country: 'United Kingdom' },
  event: { date: '2026-10-20', source_url: OWN, corroborating_urls: [] },
}
const GENUINE = page('<p>Harbor Ledger Analytics opened its new London, United Kingdom office on October 20, 2026.</p>')

const run = (claim: LeadClaim, sources: Snapshot[], asOf = AS_OF) => decide({ claim, problems: [], sources, asOf, windowDays: WINDOW_DAYS })
const statusOf = (checks: ReturnType<typeof run>, check: string) => checks.filter(c => c.check === check).map(c => c.status)

test('genuine control: company, own domain, matching city and date on the cited source -> every check passes, accepted', () => {
  const checks = run(CLAIM, [snap(OWN, GENUINE)])
  assert.deepEqual(checks.filter(c => c.status !== 'pass'), [])
  assert.deepEqual(overall(checks), { verdict: 'pass', action: 'accept' })
})

test('wrong city: the source names the company and a date, but places it somewhere else -> place_on_source fails, never accepted', () => {
  const html = page('<p>Harbor Ledger Analytics opened its new Paris office on October 20, 2026.</p>')
  const checks = run(CLAIM, [snap(OWN, html)])
  assert.deepEqual(statusOf(checks, 'place_on_source'), ['fail'])
  assert.notEqual(overall(checks).action, 'accept')
  // a whole word, not a substring: Londonderry is not London
  const derryHtml = page('<p>Harbor Ledger Analytics opened its new Londonderry office on October 20, 2026.</p>')
  assert.deepEqual(statusOf(run(CLAIM, [snap(OWN, derryHtml)]), 'place_on_source'), ['fail'])
})

test('same-name company: the source names the company and city on an unrelated domain -> domain_bound is unknown, held, never accepted as a false pass', () => {
  const url = 'https://citywire.example.org/harbor-ledger-london'
  const html = page('<p>Harbor Ledger Analytics (a different firm, unrelated.example) opened its London office on October 20, 2026.</p>')
  const claim = { ...CLAIM, event: { ...CLAIM.event, source_url: url } }
  const checks = run(claim, [snap(url, html)])
  assert.deepEqual(statusOf(checks, 'domain_bound'), ['unknown'])
  assert.match(checks.find(c => c.check === 'domain_bound')!.reason, /same-name company cannot be ruled out/)
  const o = overall(checks)
  assert.notEqual(o.action, 'accept')
  assert.equal(o.verdict, 'unknown', 'uncertain evidence stays uncertain - it is never turned into a verified lead')
})

test('same-name company, ruled in: the source names the claimed domain right next to the company -> domain_bound passes', () => {
  const url = 'https://citywire.example.org/harbor-ledger-london'
  const html = page('<p>Harbor Ledger Analytics (harborledger.example) opened its London office on October 20, 2026.</p>')
  const claim = { ...CLAIM, event: { ...CLAIM.event, source_url: url } }
  assert.deepEqual(statusOf(run(claim, [snap(url, html)]), 'domain_bound'), ['pass'])
})

test('domain named only far away in an unrelated passage does not rule in a same-name company: domain_bound stays unknown', () => {
  const url = 'https://citywire.example.org/harbor-ledger-london'
  const filler = 'This masthead covers finance news across several European markets and client sectors. '.repeat(4)
  const html = page(`<p>Harbor Ledger Analytics opened its London office on October 20, 2026.</p><p>${filler}</p><p>Advertisement: visit harborledger.example for unrelated offers.</p>`)
  const claim = { ...CLAIM, event: { ...CLAIM.event, source_url: url } }
  assert.deepEqual(statusOf(run(claim, [snap(url, html)]), 'domain_bound'), ['unknown'])
})

test('stale date: an old article whose own publication/update stamp is the only place the claimed date appears -> event_date_on_source fails, never accepted', () => {
  const visible = page('<p>Updated October 28, 2026</p><p>Harbor Ledger Analytics opened its London office in March 2019.</p>')
  const claim = { ...CLAIM, event: { ...CLAIM.event, date: '2026-10-28' } }
  const checks = run(claim, [snap(OWN, visible)])
  assert.deepEqual(statusOf(checks, 'event_date_on_source'), ['fail'])
  assert.match(checks.find(c => c.check === 'event_date_on_source')!.reason, /publication\/update date/)
  assert.notEqual(overall(checks).action, 'accept')

  // Same claim, the only trace of the date is page metadata (not visible body text) - still fails, not unknown.
  const metaOnly = page('<p>Harbor Ledger Analytics opened its London office in March 2019.</p>', '<meta property="article:published_time" content="2026-10-28T09:00:00Z">')
  assert.deepEqual(statusOf(run(claim, [snap(OWN, metaOnly)]), 'event_date_on_source'), ['fail'])
})

test('future date: a claimed event date after as_of has not happened -> event_date_on_source fails, never accepted', () => {
  const html = page('<p>Harbor Ledger Analytics will open its London office on December 15, 2026.</p>')
  const claim = { ...CLAIM, event: { ...CLAIM.event, date: '2026-12-15' } }
  const checks = run(claim, [snap(OWN, html)])
  assert.deepEqual(statusOf(checks, 'event_date_on_source'), ['fail'])
  assert.match(checks.find(c => c.check === 'event_date_on_source')!.reason, /has not happened/)
  assert.notEqual(overall(checks).action, 'accept')
})

test('announced, not happened: a source that only says the event will happen on the claimed date is unknown, never a pass', () => {
  const html = page('<p>Harbor Ledger Analytics is set to open its London office on October 20, 2026.</p>')
  const checks = run(CLAIM, [snap(OWN, html)])
  assert.deepEqual(statusOf(checks, 'event_date_on_source'), ['unknown'])
  assert.notEqual(overall(checks).action, 'accept')
})

test('conflicting evidence: a second cited source dates the same event differently -> sources_agree is unknown (held), never accepted', () => {
  const other = 'https://industry-news.example/harbor-ledger'
  const otherHtml = page('<p>Harbor Ledger Analytics opened its London office on October 15, 2026.</p>')
  const claim = { ...CLAIM, event: { ...CLAIM.event, corroborating_urls: [other] } }
  const checks = run(claim, [snap(OWN, GENUINE), snap(other, otherHtml)])
  assert.deepEqual(statusOf(checks, 'sources_agree'), ['unknown'])
  assert.match(checks.find(c => c.check === 'sources_agree')!.reason, /dates the event differently/)
  const o = overall(checks)
  assert.notEqual(o.action, 'accept')
  assert.equal(o.verdict, 'unknown')
})

test('agreeing sources: a second cited source states the same date -> sources_agree passes', () => {
  const other = 'https://industry-news.example/harbor-ledger'
  const otherHtml = page('<p>Harbor Ledger Analytics opened its London office on October 20, 2026, industry sources say.</p>')
  const claim = { ...CLAIM, event: { ...CLAIM.event, corroborating_urls: [other] } }
  const checks = run(claim, [snap(OWN, GENUINE), snap(other, otherHtml)])
  assert.deepEqual(statusOf(checks, 'sources_agree'), ['pass'])
})

test('unreadable source: a fetch failure makes the checks that need it unknown, never fail - a verifier defect cannot sink a lead', () => {
  const checks = run(CLAIM, [snap(OWN, GENUINE, { outcome: 'error', text: '' })])
  for (const check of ['company_on_source', 'domain_bound', 'place_on_source', 'event_date_on_source']) {
    assert.deepEqual(statusOf(checks, check), ['unknown'], check)
  }
  assert.notEqual(overall(checks).action, 'accept')
})

// Regression cases for the independent review of this PR: each of these previously made a false pass possible.

test('private-domain tenants (github.io, vercel.app, ...) are not aliased to one another by domain normalization', () => {
  // The event source is itself hosted on a DIFFERENT tenant's github.io subdomain than the claimed domain. Without
  // allowPrivateDomains, both normalize to the bare public suffix "github.io" and would incorrectly compare equal.
  const url = 'https://otherco.github.io/news/london-office'
  const html = page('<p>Harbor Ledger Analytics opened its new London, United Kingdom office on October 20, 2026.</p>')
  const claim: LeadClaim = { ...CLAIM, domain: 'harborledger.github.io', event: { ...CLAIM.event, source_url: url } }
  const checks = run(claim, [snap(url, html)])
  assert.deepEqual(statusOf(checks, 'domain_bound'), ['unknown'])
  assert.notEqual(overall(checks).action, 'accept')
})

test('a page naming the claimed city only in an unrelated passage (a different, unchanged office) does not satisfy geography', () => {
  const url = 'https://citywire.example.org/harbor-ledger-paris'
  const filler = 'The firm continues to expand across several European markets and client sectors this year. '.repeat(4)
  const html = page(`<p>Harbor Ledger Analytics opened its new Paris office on October 20, 2026.</p>
    <p>${filler}</p><p>The firm's existing London office remains unchanged and continues normal operations.</p>`)
  const claim = { ...CLAIM, event: { ...CLAIM.event, source_url: url } }
  assert.deepEqual(statusOf(run(claim, [snap(url, html)]), 'place_on_source'), ['fail'])
})

test('a quoted HTML attribute cannot smuggle hidden text past the tag stripper (a ">" inside a quote is not a tag boundary)', () => {
  const html = page(`<div data-state="x > Harbor Ledger Analytics opened its London, United Kingdom office on October 20, 2026">unrelated visible text</div>`)
  const checks = run(CLAIM, [snap(OWN, html)])
  assert.deepEqual(statusOf(checks, 'company_on_source'), ['fail'])
  assert.deepEqual(statusOf(checks, 'place_on_source'), ['fail'])
})

test('a direct "announced" sentence is held as announced-only, same as "will"/"set to", never a pass', () => {
  const html = page('<p>Harbor Ledger Analytics announced its London office opening for October 20, 2026.</p>')
  assert.deepEqual(statusOf(run(CLAIM, [snap(OWN, html)]), 'event_date_on_source'), ['unknown'])
})

test('a bare <time datetime> with no pubdate/itemprop is read as ordinary event text (the year it alone supplies), not misclassified as a publication stamp', () => {
  const html = page('<p>Harbor Ledger Analytics opened its London, United Kingdom office on <time datetime="2026-10-20">Oct 20</time>.</p>')
  const checks = run(CLAIM, [snap(OWN, html)])
  assert.deepEqual(statusOf(checks, 'event_date_on_source'), ['pass'])
})

test('a publication-flagged <time pubdate> next to the byline is still correctly excluded as a stamp, not the event date', () => {
  const html = page('<p>By Staff Writer <time pubdate datetime="2026-10-20">Oct 20</time></p><p>Harbor Ledger Analytics opened its London office in March 2019.</p>')
  const claim = { ...CLAIM, event: { ...CLAIM.event, date: '2026-10-20' } }
  const checks = run(claim, [snap(OWN, html)])
  assert.deepEqual(statusOf(checks, 'event_date_on_source'), ['fail'])
  assert.match(checks.find(c => c.check === 'event_date_on_source')!.reason, /publication\/update date/)
})

test('malformed claim (blindClaim): missing domain or event is a problem, not silently ignored, and claim_well_formed is unknown', () => {
  const { claim, problems } = blindClaim({ company: 'Harbor Ledger Analytics', place: { city: 'London' } })
  assert.ok(problems.includes('domain is missing or malformed'))
  assert.ok(problems.includes('event is missing'))
  const checks = decide({ claim, problems, sources: [], asOf: AS_OF, windowDays: WINDOW_DAYS })
  assert.deepEqual(statusOf(checks, 'claim_well_formed'), ['unknown'])
  assert.equal(checks.length, 1, 'no company/domain/event source checks run on an incomplete claim')
})

test('blindClaim drops anything the producer sent beyond the allowlisted fields, by name only never by value', () => {
  const { claim, dropped } = blindClaim({ ...CLAIM, model: 'producer-model-x', rationale: 'trust me', verified: true, score: 97 })
  assert.deepEqual(claim, CLAIM)
  assert.deepEqual(dropped, ['model', 'rationale', 'score', 'verified'])
})
