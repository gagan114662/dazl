// #780: deterministic corroboration of company/domain/place/event date from independently retrieved pages (lib/evals/corroborate.ts), judged by the #394 contract.
// Seeded cases from #395's acceptance: wrong-city, same-name, old article with a fresh publication date, fabricated quote, future event. None may pass.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freezeContract, evaluateLead, type Contract } from '../lib/evals/contract.ts'
import { collectEvidence, statedDays, type Claim, type SourcePage } from '../lib/evals/corroborate.ts'

const contract: Contract = {
  schema: 'dazl.evaluation-contract/1', id: 'toronto-saas-hire', version: 1, as_of: '2026-11-10', brief: { seller: 'Acme', offer: 'revops' },
  constraints: { places: ['Toronto'], industries: [], event_kinds: ['hiring'], window_days: 30, min_independent_sources: 2, require_consent: false },
}
const OPT = { places: ['Toronto'], industries: [] as string[], known_places: ['Toronto', 'Lisbon', 'Berlin'] }
const claim = (o: Partial<Claim> = {}): Claim => ({ company: 'Northwind Labs', domain: 'northwind.io', source_url: 'https://news.example.com/a', quote: 'Northwind Labs is hiring a VP of Sales', event_kind: 'hiring', event_date: '2026-11-01', contact_email: 'jane@northwind.io', ...o })
const A: SourcePage = { url: 'https://news.example.com/a', text: 'Toronto. Northwind Labs is hiring a VP of Sales, posted November 1, 2026.', published_at: '2026-11-01', entity_domains: ['northwind.io'] }
const B: SourcePage = { url: 'https://www.jobs-board.org/p/1', text: 'Northwind Labs, Toronto: VP of Sales. Posted 2026-11-01.', published_at: '2026-11-02' }
const judge = (c: Claim, pages: SourcePage[]) => evaluateLead(freezeContract(contract), collectEvidence(c, pages, OPT))
const st = (r: ReturnType<typeof judge>, f: string) => r.verdicts.find(v => v.field === f)?.status

test('a lead corroborated by two independent pages that state its date validates', () => {
  const r = judge(claim(), [A, B]); assert.equal(r.status, 'pass', JSON.stringify(r.verdicts.filter(v => v.status !== 'pass')))
})

test('wrong city: a page naming another city fails the place, never passes', () => {
  const r = judge(claim(), [{ ...A, text: A.text.replace('Toronto', 'Lisbon') }, { ...B, text: B.text.replace('Toronto', 'Lisbon') }])
  assert.equal(st(r, 'place.matches'), 'fail'); assert.notEqual(r.status, 'pass')
})

test('same name, different company: the page is about another domain, so identity is contradicted', () => {
  const r = judge(claim(), [{ ...A, entity_domains: ['northwind-foods.com'] }, B])
  assert.equal(st(r, 'identity.entity'), 'contradicted'); assert.notEqual(r.status, 'pass')
})

test('old article with a fresh publication date: the stated date is old, so the event date is unknown and nothing passes', () => {
  const old = { ...A, text: 'Toronto. Northwind Labs is hiring a VP of Sales, posted June 1, 2026.', published_at: '2026-11-09' }
  const r = judge(claim(), [old, { ...B, text: 'Northwind Labs, Toronto: VP of Sales. Posted 2026-06-01.', published_at: '2026-11-09' }])
  assert.equal(st(r, 'event.date_real'), 'unknown'); assert.equal(st(r, 'event.predicate'), 'unknown'); assert.notEqual(r.status, 'pass')
})

test('a date that appears only as publication metadata supports nothing', () => {
  const meta = { ...A, text: 'Toronto. Northwind Labs is hiring a VP of Sales.', published_at: '2026-11-01' }
  const e = collectEvidence(claim(), [meta, { ...B, text: 'Northwind Labs, Toronto: VP of Sales.' }], OPT)
  assert.equal(e.event!.date, null); assert.deepEqual(e.event!.sources, [])
})

test('fabricated quote: not on the cited page, so source.on_page fails', () => {
  const r = judge(claim({ quote: 'Northwind Labs raised a $40M Series B' }), [A, B])
  assert.equal(st(r, 'source.on_page'), 'fail'); assert.notEqual(r.status, 'pass')
})

test('future event: the stated date is after as_of, so the window fails', () => {
  const f = (p: SourcePage) => ({ ...p, text: p.text.replace(/November 1, 2026|2026-11-01/, '2026-12-01') })
  const r = judge(claim({ event_date: '2026-12-01' }), [f(A), f(B)])
  assert.equal(st(r, 'event.date_in_window'), 'fail'); assert.notEqual(r.status, 'pass')
})

test('one page, or two pages on the same domain, is not corroboration', () => {
  assert.notEqual(judge(claim(), [A]).status, 'pass')
  assert.equal(st(judge(claim(), [A, { ...B, url: 'https://blog.news.example.com/x' }]), 'event.predicate'), 'unknown')
})

test('no pages at all: every field the evidence feeds is unknown, nothing passes', () => {
  const r = judge(claim(), []); assert.notEqual(r.status, 'pass'); assert.equal(st(r, 'identity.entity'), 'unknown')
})

test('a page that does not name the company supports nothing', () => {
  const r = judge(claim(), [{ ...A, text: 'Toronto. A software firm is hiring a VP of Sales, posted November 1, 2026.' }, { ...B, text: 'A firm in Toronto: VP of Sales. Posted 2026-11-01.' }])
  assert.notEqual(r.status, 'pass'); assert.equal(st(r, 'event.predicate'), 'unknown')
})

test('stated dates: three forms are read, whole tokens only, impossible days dropped', () => {
  assert.deepEqual(statedDays('2026-10-08 and October 9, 2026 and 10 Oct 2026').sort(), ['2026-10-08', '2026-10-09', '2026-10-10'])
  assert.deepEqual(statedDays('2026-10-080123, x2026-10-08x, 18 october 20261, 2026-02-30, Feb 30, 2026'), [])
})

test('reproducible: the same pages give the same evidence', () => {
  assert.equal(JSON.stringify(collectEvidence(claim(), [A, B], OPT)), JSON.stringify(collectEvidence(claim(), [A, B], OPT)))
})
