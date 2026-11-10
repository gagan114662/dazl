// #394: the evaluation contract (lib/evals/contract.ts). Black-box tests of its rules, written from the issue's acceptance, not from the implementation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freezeContract, validateContract, evaluateLead, summarize, contractHash, type Contract, type LeadEvidence } from '../lib/evals/contract.ts'
import { contractVerdicts } from '../lib/benchmark/runner.ts'

const base = (): Contract => ({
  schema: 'dazl.evaluation-contract/1', id: 'toronto-saas-hire', version: 1, as_of: '2026-11-10',
  brief: { seller: 'Acme RevOps', offer: 'revenue operations consulting' },
  constraints: { places: ['Toronto'], industries: ['software'], event_kinds: ['hiring'], window_days: 30, min_independent_sources: 2, require_consent: true },
})
const good = (): LeadEvidence => ({
  company: 'Northwind Labs', claimed_domain: 'northwind.io', source_url: 'https://news.example.com/northwind', quote: 'Northwind Labs is hiring a VP of Sales',
  page_text: 'Toronto software firm. Northwind Labs is hiring a VP of Sales this month.', observed_names: ['Northwind Labs'], observed_domains: ['northwind.io'],
  places: ['Toronto'], industries: ['software'],
  event: { kind: 'hiring', date: '2026-11-01', sources: [{ url: 'https://news.example.com/northwind' }, { url: 'https://www.jobs-board.org/p/1' }] },
  consent: 'allowed', contact: { email: 'jane@northwind.io' },
})
const run = (e: LeadEvidence, c: Contract = base()) => evaluateLead(freezeContract(c), e)
const status = (r: ReturnType<typeof run>, f: string) => r.verdicts.find(v => v.field === f)?.status

test('a fully evidenced lead validates, with a verdict and a rationale for every field', () => {
  const r = run(good())
  assert.equal(r.status, 'pass'); assert.equal(r.tier, 'validated')
  assert.deepEqual(r.verdicts.map(v => v.field).sort(), ['consent.status', 'contact.usable', 'event.date_in_window', 'event.date_real', 'event.predicate', 'identity.entity', 'industry.matches', 'place.matches', 'source.on_page'])
  for (const v of r.verdicts) { assert.equal(v.status, 'pass'); assert.ok(v.rationale.length > 5) }
})

test('reproducible: the same frozen contract and evidence give identical output', () => {
  const c = freezeContract(base())
  assert.equal(JSON.stringify(evaluateLead(c, good())), JSON.stringify(evaluateLead(c, good())))
  assert.equal(contractHash(base()), contractHash(JSON.parse(JSON.stringify(base()))))
})

test('missing or malformed constraints make the contract invalid; nothing is inferred', () => {
  const noWindow = base() as unknown as Record<string, Record<string, unknown>>; delete noWindow.constraints.window_days
  assert.ok(validateContract(noWindow).some(p => p.path === 'constraints.window_days'))
  const noPlaces = base() as unknown as Record<string, Record<string, unknown>>; delete noPlaces.constraints.places
  assert.ok(validateContract(noPlaces).some(p => p.path === 'constraints.places'))
  assert.ok(validateContract({ ...base(), as_of: '2026-02-30' }).some(p => p.path === 'as_of'))
  assert.ok(validateContract({ ...base(), constraints: { ...base().constraints, min_independent_sources: 0 } }).some(p => p.path === 'constraints.min_independent_sources'))
  assert.ok(validateContract({ ...base(), constraints: { ...base().constraints, event_kinds: [] } }).some(p => p.path === 'constraints.event_kinds'))
  assert.ok(validateContract({ ...base(), constraints: { ...base().constraints, require_consent: undefined } }).some(p => p.path === 'constraints.require_consent'))
  assert.throws(() => freezeContract(noWindow), /invalid evaluation contract.*window_days/)
  assert.deepEqual(validateContract(base()), [])
})

test('high-intent is independent corroboration: one source, or the company\'s own site alone, is unknown and cannot validate', () => {
  const one = good(); one.event!.sources = [{ url: 'https://news.example.com/a' }]
  assert.equal(status(run(one), 'event.predicate'), 'unknown'); assert.notEqual(run(one).status, 'pass')
  const same = good(); same.event!.sources = [{ url: 'https://news.example.com/a' }, { url: 'https://www.news.example.com/b' }]
  assert.equal(status(run(same), 'event.predicate'), 'unknown', 'two pages on one domain are one source')
  const own = good(); own.event!.sources = [{ url: 'https://northwind.io/blog/1' }]
  assert.match(run(own).verdicts.find(v => v.field === 'event.predicate')!.rationale, /company's own site/)
  const two = good(); two.event!.sources = [{ url: 'https://a.co.uk/x' }, { url: 'https://b.co.uk/y' }]
  assert.equal(status(run(two), 'event.predicate'), 'pass')
  const sameUk = good(); sameUk.event!.sources = [{ url: 'https://news.a.co.uk/x' }, { url: 'https://blog.a.co.uk/y' }]
  assert.equal(status(run(sameUk), 'event.predicate'), 'unknown', 'subdomains of one registrable domain are one source')
})

test('a contradicting source makes the event contradicted, never pass', () => {
  const e = good(); e.event!.contradicted_by = [{ url: 'https://other.example.org/denial' }]
  const r = run(e); assert.equal(status(r, 'event.predicate'), 'contradicted'); assert.equal(r.status, 'fail')
})

test('unknown is never pass: absent evidence leaves every dependent field unknown', () => {
  const r = run({ company: 'Northwind Labs' })
  assert.notEqual(r.status, 'pass'); assert.equal(r.tier, null)
  for (const f of ['identity.entity', 'event.predicate', 'event.date_real', 'event.date_in_window', 'contact.usable', 'consent.status', 'place.matches', 'industry.matches']) assert.equal(status(r, f), 'unknown', f)
})

test('identity: another company on the cited page is contradicted; a same-domain page passes', () => {
  const e = good(); e.observed_names = ['Northwind Foods']; e.observed_domains = ['northwindfoods.com']
  assert.equal(status(run(e), 'identity.entity'), 'contradicted')
})

test('quote: absent from the independently fetched page fails; page not fetched is unknown', () => {
  const e = good(); e.quote = 'Northwind Labs raised a Series B'; assert.equal(status(run(e), 'source.on_page'), 'fail')
  const f = good(); f.page_text = null; assert.equal(status(run(f), 'source.on_page'), 'unknown')
  const g = good(); g.quote = null; assert.equal(status(run(g), 'source.on_page'), 'fail')
})

test('dates use whole UTC days: the as_of day passes, tomorrow is the future, the window is inclusive, a fake day fails', () => {
  const at = (d: string) => { const e = good(); e.event!.date = d; return run(e) }
  assert.equal(status(at('2026-11-10'), 'event.date_in_window'), 'pass')
  assert.equal(status(at('2026-11-11'), 'event.date_in_window'), 'fail')
  assert.equal(status(at('2026-10-11'), 'event.date_in_window'), 'pass')   // 30 days
  assert.equal(status(at('2026-10-10'), 'event.date_in_window'), 'fail')   // 31 days
  assert.equal(status(at('2026-02-30'), 'event.date_real'), 'fail')
  const none = good(); none.event!.date = null; assert.equal(status(run(none), 'event.date_real'), 'unknown')
})

test('constraints: wrong place or event kind fails; fields the contract does not constrain are not scored', () => {
  const p = good(); p.places = ['Lisbon']; assert.equal(status(run(p), 'place.matches'), 'fail')
  const k = good(); k.event!.kind = 'funding'; assert.equal(status(run(k), 'event.predicate'), 'fail')
  const open = base(); open.constraints.places = []; open.constraints.require_consent = false
  const r = run(good(), open); assert.equal(status(r, 'place.matches'), undefined); assert.equal(status(r, 'consent.status'), undefined); assert.equal(r.status, 'pass')
})

test('consent: blocked fails, unrecorded is unknown, and it blocks validation when required', () => {
  const b = good(); b.consent = 'blocked'; assert.equal(status(run(b), 'consent.status'), 'fail')
  const u = good(); u.consent = null; assert.equal(run(u).status, 'unknown')
})

test('contact: a hiring inbox or a foreign domain fails; no email or no company domain is unknown', () => {
  const j = good(); j.contact = { email: 'careers@northwind.io' }; assert.equal(status(run(j), 'contact.usable'), 'fail')
  const o = good(); o.contact = { email: 'jane@gmail.com' }; assert.equal(status(run(o), 'contact.usable'), 'fail')
  const n = good(); n.contact = { phone: '+1 416 555 0100' }; assert.equal(status(run(n), 'contact.usable'), 'unknown')
  const d = good(); d.claimed_domain = null; assert.equal(status(run(d), 'contact.usable'), 'unknown')
})

test('the evaluator cannot change targeting: a frozen contract rejects edits, and a tampered one is refused', () => {
  const f = freezeContract(base())
  assert.throws(() => { (f.contract.constraints as { places: string[] }).places.push('Berlin') }, TypeError)
  assert.throws(() => { (f.contract as { as_of: string }).as_of = '2099-01-01' }, TypeError)
  const t = { contract: structuredClone(base()), hash: f.hash }; t.contract.constraints.window_days = 3650
  assert.throws(() => evaluateLead(t as never, good()), /changed after it was frozen/)
})

test('summary: unknown and contradicted are not validated, and the unknown rate is its own number', () => {
  const unk = good(); unk.consent = null
  const con = good(); con.observed_names = ['Other Co']; con.observed_domains = []
  const failed = good(); failed.places = ['Lisbon']
  const s = summarize([run(good()), run(good()), run(unk), run(con), run(failed)])
  assert.deepEqual(s, { leads: 5, validated: 2, failed: 2, unknown: 1, contradicted: 1, validated_rate: 0.4, unknown_rate: 0.2, contradicted_rate: 0.2 })
  assert.equal(summarize([]).validated_rate, null)
})

test('the benchmark runner reads this contract as it is: a validated lead is four passes, an uncorroborated event is unknown', () => {
  const v = contractVerdicts(run(good()))
  assert.deepEqual(v, { identity: 'pass', constraints: 'pass', event_date: 'pass', contact: 'pass' })
  const one = good(); one.event!.sources = [{ url: 'https://news.example.com/a' }]
  assert.equal(contractVerdicts(run(one)).constraints, 'unknown')
  const con = good(); con.observed_names = ['Other Co']; con.observed_domains = []
  assert.equal(contractVerdicts(run(con)).identity, 'contradicted')
})
