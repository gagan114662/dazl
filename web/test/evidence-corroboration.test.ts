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

test('impossible days in a page never throw and never count as a stated date', () => {
  assert.deepEqual(statedDays('2026-13-01, 2026-00-10, 2026-10-00, Feb 30, 2026, 31 April 2026'), [])
  const bad = (p: SourcePage) => ({ ...p, text: p.text.replace(/November 1, 2026|2026-11-01/, '2026-13-01') })
  const r = judge(claim(), [bad(A), bad(B)]); assert.notEqual(r.status, 'pass'); assert.equal(st(r, 'event.predicate'), 'unknown')
})

// ---- Hermes-PC review of #1028 (head b9a08dbd): five leads that must not pass ----

test('review 1: same-name company at another domain on ANY page contradicts identity, and its page is never an event source', () => {
  const other = { ...B, entity_domains: ['northwind-foods.com'] }
  const r = judge(claim(), [A, other]); assert.notEqual(r.status, 'pass', JSON.stringify(r.verdicts.filter(v => v.status !== 'pass')))
  assert.equal(st(r, 'identity.entity'), 'contradicted')
  const e = collectEvidence(claim(), [A, other], OPT)
  assert.ok(!e.event!.sources.some(s => s.url === other.url), 'the other company\'s page is not a source'); assert.ok(!e.observed_domains?.includes('northwind.io'), 'the claimed domain is not offered once identity is in conflict')
})

test('review 2: identity comes from the CITED page: a cited page that never names the company cannot pass, even if other pages do', () => {
  const C: SourcePage = { url: 'https://c.example.net/c', text: 'Toronto. We are hiring a VP of Sales.', published_at: '2026-11-01' }
  const r = judge(claim({ source_url: C.url, quote: 'We are hiring a VP of Sales' }), [C, A, B])
  assert.notEqual(r.status, 'pass', JSON.stringify(r.verdicts.filter(v => v.status !== 'pass'))); assert.equal(st(r, 'identity.entity'), 'unknown')
  const e = collectEvidence(claim({ source_url: C.url, quote: 'We are hiring a VP of Sales' }), [C, A, B], OPT); assert.deepEqual(e.observed_names, []); assert.deepEqual(e.observed_domains, [])
})

test('review 3: "New York" is not "York": a longer place consumes its words before a shorter one is tried', () => {
  const o = { places: ['York'], industries: [] as string[], known_places: ['New York', 'York', 'Toronto'] }
  const pg = (u: string, x: string): SourcePage => ({ url: u, text: x, entity_domains: [] })
  const pages = [pg('https://news.example.com/a', 'New York. Northwind Labs is hiring a VP of Sales, posted November 1, 2026.'), pg('https://www.jobs-board.org/p/1', 'Northwind Labs, New York: VP of Sales. Posted 2026-11-01.')]
  const e = collectEvidence(claim(), pages, o); assert.deepEqual(e.places, ['New York'])
  const c2: Contract = { ...contract, id: 'york-hire-review3', constraints: { ...contract.constraints, places: ['York'] } }
  const r = evaluateLead(freezeContract(c2), e); assert.notEqual(r.status, 'pass'); assert.equal(r.verdicts.find(v => v.field === 'place.matches')?.status, 'fail')
  const both = collectEvidence(claim(), [pg('https://news.example.com/a', 'New York and York. Northwind Labs is hiring.')], o); assert.deepEqual(both.places, ['New York', 'York'])
})

test('review 4: written dates are whole tokens: a letter or underscore suffix is not a stated date', () => {
  assert.deepEqual(statedDays('November 1, 2026_version and 1 November 2026abc and Nov 1, 2026x'), [])
  assert.deepEqual(statedDays('posted November 1, 2026. Also 1 November 2026, and Nov 2, 2026'), ['2026-11-01', '2026-11-02'])
  const r = judge(claim(), [{ ...A, text: 'Toronto. Northwind Labs is hiring a VP of Sales, ref November 1, 2026_v2.' }, { ...B, text: 'Northwind Labs, Toronto: VP of Sales. build 1 November 2026abc.' }])
  assert.notEqual(r.status, 'pass'); assert.equal(st(r, 'event.predicate'), 'unknown')
})

test('review 5: malformed pages and options fail closed and never throw', () => {
  const bad = (pages: unknown, opt: unknown = OPT) => { let r: ReturnType<typeof judge> | undefined; assert.doesNotThrow(() => { r = evaluateLead(freezeContract(contract), collectEvidence(claim(), pages as SourcePage[], opt as typeof OPT)) }); return r! }
  for (const [name, pages] of [
    ['pages null', null], ['pages not an array', 'nope'], ['text null', [{ ...A, text: null }, B]], ['text a number', [{ ...A, text: 42 }, B]], ['url missing', [{ text: A.text }, B]],
    ['empty list', []], ['only malformed pages', [null, { url: 1 }, { text: 'x' }]],
  ] as [string, unknown][]) assert.notEqual(bad(pages).status, 'pass', name)
  // a null entry among good pages is dropped: it never throws and never counts as a source
  assert.equal(bad([null, A, B]).status, 'pass'); assert.deepEqual(collectEvidence(claim(), [null as unknown as SourcePage, A, B], OPT).event!.sources.map(s => s.url), [A.url, B.url])
  // a non-array entity_domains means "no declared domains" (the same as the field being absent): it must not throw, and it cannot confirm the company's own domain
  const e = collectEvidence(claim(), [{ ...A, entity_domains: 'northwind.io' } as unknown as SourcePage, B], OPT); assert.ok(!e.observed_domains?.includes('northwind.io'))
  assert.doesNotThrow(() => bad([A, B], { places: null, industries: 'x', known_places: undefined }))
})

// ---- Hermes-PC re-review of #1028 (head 18fc3eb7): the lead's own claim is the least trusted input ----

test('review 6: a malformed claim fails closed and never throws, one row per case', () => {
  const run = (cl: unknown) => { let r: ReturnType<typeof judge> | undefined; assert.doesNotThrow(() => { r = evaluateLead(freezeContract(contract), collectEvidence(cl as ReturnType<typeof claim>, [A, B], OPT)) }); return r! }
  const good = claim()
  for (const [name, cl] of [
    ['claim null', null], ['claim undefined', undefined], ['claim a string', 'x'], ['claim an array', []], ['claim {}', {}],
    ['company null', { ...good, company: null }], ['company a number', { ...good, company: 42 }], ['company an array', { ...good, company: ['Northwind Labs'] }], ['company missing', { ...good, company: undefined }],
    ['domain a number', { ...good, domain: 7 }], ['domain an object', { ...good, domain: { x: 1 } }],
    ['quote a number', { ...good, quote: 5 }], ['quote an object', { ...good, quote: {} }],
  ] as [string, unknown][]) assert.notEqual(run(cl).status, 'pass', name)
  // fields of the wrong type are never copied into the evidence as they are
  const e = collectEvidence({ ...good, event_kind: { x: 1 }, contact_email: 7, domain: 9, consent: 'yes' } as unknown as ReturnType<typeof claim>, [A, B], OPT)
  assert.equal(typeof e.event?.kind, 'string'); assert.equal(e.contact, null); assert.equal(e.claimed_domain, null); assert.equal(e.consent, null)
})

test('review 6b: a letter, digit or underscore of any script glued to a date is not a stated date', () => {
  assert.deepEqual(statedDays('November 1, 2026é and 2026-11-01ü and é1 November 2026 and 1 November 2026ß and ñ2026-11-01'), [])
  assert.deepEqual(statedDays('posted November 1, 2026. Also 2026-11-02, and 3 November 2026').sort(), ['2026-11-01', '2026-11-02', '2026-11-03'])
})

test('review 6c: a blank or dot-only entity domain is junk, not "another entity"', () => {
  for (const junk of ['', '.', ' ', '..']) {
    const r = judge(claim(), [A, { ...B, entity_domains: [junk] }]); assert.equal(r.status, 'pass', JSON.stringify(junk) + ' ' + JSON.stringify(r.verdicts.filter(v => v.status !== 'pass')))
  }
})

// ---- Hermes-PC re-review of #1028 (head 0b872a79): consent is the string 'allowed' | 'blocked' ----

test('review 7: consent is kept only as the string allowed or blocked, and a contract that requires it reads it', () => {
  const need: Contract = { ...contract, id: 'consent-required-review7', constraints: { ...contract.constraints, require_consent: true } }
  const at = (consent: unknown) => { const e = collectEvidence({ ...claim(), consent } as unknown as ReturnType<typeof claim>, [A, B], OPT); return { e, r: evaluateLead(freezeContract(need), e) } }
  const field = (r: ReturnType<typeof judge>) => r.verdicts.find(v => v.field === 'consent.status')!.status
  const ok = at('allowed'); assert.equal(ok.e.consent, 'allowed'); assert.equal(field(ok.r), 'pass'); assert.equal(ok.r.status, 'pass', JSON.stringify(ok.r.verdicts.filter(v => v.status !== 'pass')))
  const no = at('blocked'); assert.equal(no.e.consent, 'blocked'); assert.equal(field(no.r), 'fail'); assert.notEqual(no.r.status, 'pass')
  for (const junk of ['yes', 'ALLOWED', {}, { status: 'allowed' }, 1, true, [], null, undefined]) { const x = at(junk); assert.equal(x.e.consent, null, JSON.stringify(junk)); assert.equal(field(x.r), 'unknown', JSON.stringify(junk)); assert.notEqual(x.r.status, 'pass') }
})

test('review 7b: a combining mark glued to a date is not a stated date', () => {
  assert.deepEqual(statedDays('2026-11-01\u0301 and November 2, 2026\u0301 and 3 November 2026\u0308'), [])
  assert.deepEqual(statedDays('posted 2026-11-01. Then November 2, 2026.').sort(), ['2026-11-01', '2026-11-02'])
})
