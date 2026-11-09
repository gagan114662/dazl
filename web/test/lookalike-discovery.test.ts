// #386: lookalike discovery from supplied customer outcomes. Fully synthetic cohort and candidates (invented businesses on
// .example hosts); the runner test goes through the real runJob with every provider, search and page fetch stubbed.
import test from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { budgetedIcp, flatProfile, normalizeIcp } from '../lib/scan/icp.ts'
import { accountKeys, compareToBaseline, deriveModel, discover, dropKnown, keyHash, knownAccount, leadLookalikeFit, lookalikeOf, MAX_EXAMPLES, normalizeLookalike, orderByIcp, orderByLookalike, parseCohort, split, validate, type Example, type LookalikeBlock } from '../lib/scan/lookalike-discovery.ts'
import { dropSupplied, type Job } from '../lib/scan/runner.ts'
import { runFixture, daysAgo } from './helpers/acceptance-harness.ts'

const cust = (i: number): Example => ({ kind: i % 7 === 0 ? 'won' : 'customer', name: `Bright Smile ${i} Dental`, domain: `brightsmile${i}.example`, industry: 'Dental clinics', size: '11-50', location: 'New York', description: 'orthodontic invisalign family practice' })
const neg = (i: number): Example => ({ kind: i % 5 === 0 ? 'competitor' : 'negative', name: `Other ${i} Works`, domain: `other${i}.example`, industry: i % 2 ? 'Manufacturing' : 'Legal services', size: i % 3 ? '1000+' : '2-10', location: i % 2 ? 'Ohio' : 'Texas', description: i % 2 ? 'industrial fabrication machining' : 'litigation counsel firm' })
const ALL = [...Array.from({ length: 24 }, (_, i) => cust(i)), ...Array.from({ length: 24 }, (_, i) => neg(i))]
const block = (): LookalikeBlock => discover(ALL).proposal!.icp.lookalike

test('import is validated whole: a bad row, an unknown kind or an oversized list refuses the import, naming why', () => {
  assert.equal(parseCohort(ALL).ok, true)
  assert.deepEqual(parseCohort([]), { ok: false, error: 'invalid_cohort', detail: 'examples must be a non-empty list' })
  const bad = parseCohort([...ALL.slice(0, 3), { kind: 'prospect', name: 'X Co' }]); assert.ok(!bad.ok && /examples\[3\]\.kind/.test(bad.detail))
  const dom = parseCohort([{ kind: 'customer', name: 'Yellow Dental', domain: 'not a host' }]); assert.ok(!dom.ok && /domain/.test(dom.detail))
  const big = parseCohort(Array.from({ length: MAX_EXAMPLES + 1 }, (_, i) => cust(i))); assert.ok(!big.ok && big.error === 'too_many_examples')
  const p = parseCohort([{ kind: 'customer', name: ' Acme  Dental ', domain: 'https://www.AcmeDental.example/about' }]); assert.ok(p.ok && p.examples[0].domain === 'acmedental.example' && p.examples[0].name === 'Acme Dental')
})

test('customers alone are not enough: negatives are required, and so is a minimum number of customers', () => {
  assert.equal(validate(ALL.filter(e => e.kind === 'customer' || e.kind === 'won')).state, 'needs_negatives')
  assert.equal(validate(ALL.slice(0, 3)).state, 'needs_positives')
  assert.equal(discover(ALL.slice(0, 3)).proposal, null)
})

test('explainable discriminating features, checked on a held-out split the features never saw', () => {
  const d = validate(ALL)
  assert.equal(d.state, 'ready', d.why); assert.ok(d.heldOut!.lift > 1 && d.heldOut!.n >= 4)
  const feats = d.model!.discriminators.map(x => `${x.feature.dimension}:${x.feature.value}`)
  assert.ok(feats.includes('industry:dental clinics') && feats.includes('keyword:orthodontic') && feats.includes('location:new york'), feats.join())
  assert.ok(!feats.some(f => /manufacturing|legal|ohio|texas/.test(f)), 'what only the negatives have is not a customer feature')
  const sp = split(ALL); assert.ok(sp.test.length > 0 && sp.train.length > sp.test.length)
  assert.deepEqual(split(ALL), sp, 'deterministic split')
  const r = discover(ALL); assert.ok(r.features.every(f => /customers, [\d.]+x vs non-customers$/.test(f.reason)))
})

test('features that do not beat chance on the held-out set claim nothing: no model, no profile', () => {
  const noise: Example[] = Array.from({ length: 40 }, (_, i) => ({ kind: i < 20 ? 'customer' : 'negative', name: `N${i} Co`, domain: `n${i}.example`, industry: 'Same', location: 'Same', description: 'identical words everywhere' }))
  const r = discover(noise)
  assert.notEqual(r.state, 'ready'); assert.equal(r.proposal, null); assert.deepEqual(r.features, [])
})

test('the profile is a normal reviewable scan profile; its block survives storage whole and never reaches a model prompt', () => {
  const p = discover(ALL).proposal!
  assert.match(p.query, /dental clinics/); assert.ok(!/manufacturing|legal/i.test(p.query))
  assert.deepEqual(p.icp.signals, [], 'a lookalike profile invents no intent signal')
  const icp = normalizeIcp(p.icp)!
  assert.deepEqual(icp.lookalike, p.icp.lookalike)
  assert.deepEqual(normalizeIcp(JSON.parse(JSON.stringify(icp))), icp, 'idempotent through JSON storage')
  const flat = flatProfile(icp) as Record<string, unknown>; assert.equal('lookalike' in flat, false)
  assert.ok(!JSON.stringify(flat).includes(icp.lookalike!.k.c))
  // a full import (MAX_EXAMPLES accounts, all with domains) still fits the stored profile budget whole
  const full = [...Array.from({ length: 50 }, (_, i) => cust(i + 100)), ...Array.from({ length: 50 }, (_, i) => neg(i + 100))]
  const fp = discover(full).proposal!; const sized = budgetedIcp(normalizeIcp(fp.icp)!)
  assert.ok(sized.ok && JSON.parse(sized.json).lookalike.k.c === fp.icp.lookalike.k.c)
})

test('a malformed block refuses the whole profile (never a profile silently without its exclusions)', () => {
  const p = discover(ALL).proposal!.icp
  for (const bad of [{ ...p.lookalike, v: 2 }, { ...p.lookalike, k: { ...p.lookalike.k, c: 'abc' } }, { ...p.lookalike, h: { p: 0.4, b: 0.5, n: 10 } }, { ...p.lookalike, f: [{ d: 'k', t: 'Not Slug', n: 3, x: 3 }] }, 'x'])
    assert.equal(normalizeIcp({ ...p, lookalike: bad }), null, JSON.stringify(bad).slice(0, 80))
  assert.equal(normalizeLookalike(undefined), undefined)
  assert.equal(lookalikeOf({ icp: JSON.stringify({ ...p, lookalike: { v: 9 } }) }), 'unreadable')
  assert.equal(lookalikeOf({ icp: JSON.stringify({ summary: 'x' }) }), null)
})

test('net-new only: supplied customers, competitors and negatives never come back; a news host is not the company', () => {
  const b = block()
  const rows = [
    { company: 'Bright Smile 3 Dental, Inc.', source_url: 'https://news.example/a' },           // customer by name
    { company: 'Other 5 Works', source_url: 'https://other5.example/news' },                    // competitor (kind competitor) by name + own domain
    { company: 'Brite Smyle Three', source_url: 'https://x.example/y', company_domain: 'brightsmile3.example' }, // customer by explicit domain
    { company: 'Other 7 Works', source_url: 'https://news.example/b' },                         // supplied negative
    { company: 'Maple Row Dental', source_url: 'https://brightsmile3.example/blog' },            // NOT the customer: the page host is not this company's domain
    { company: 'Harbor Orthodontics', source_url: 'https://harborortho.example/' },
  ]
  const r = dropKnown(b, rows)
  assert.deepEqual(r.kept.map(x => x.company), ['Maple Row Dental', 'Harbor Orthodontics'])
  assert.deepEqual(r.dropped.map(x => x.reason), ['lookalike_supplied_customer', 'lookalike_supplied_competitor', 'lookalike_supplied_customer', 'lookalike_supplied_negative'])
  assert.deepEqual(dropKnown(null, rows).kept, rows)
})

test('an unreadable block in a stored job drops every candidate (UNKNOWN is never "nothing supplied")', () => {
  const job = { id: 'j', user_id: 'A', business_name: 'x', industry: 'x', location: 'x', attempts: 1, icp: JSON.stringify({ summary: 's', lookalike: { v: 1, f: [] } }) } as Job
  const audit: { key: string; company: string; url: string; outcome: 'passed' | 'review' | 'dropped'; reason: string | null }[] = []
  const kept = dropSupplied(job, [{ name: '', company: 'Maple Row Dental', contact: null, signal: 's', source_url: 'https://m.example/', score: 50, excerpt: 'q', event_date: null } as never], audit)
  assert.deepEqual(kept, []); assert.equal(audit[0].reason, 'lookalike_unreadable')
})

test('lookalike fit is its own label from the lead\'s own evidence: no proof-backed event is never ready-to-buy', () => {
  const b = block()
  const lead = { company: 'Maple Row Dental', signal: 'opened a second clinic', evidence_excerpt: 'Maple Row Dental, an orthodontic and invisalign practice in New York, opened a second clinic' }
  const only = leadLookalikeFit(b, lead, false), withEv = leadLookalikeFit(b, lead, true)
  assert.equal(only.readiness, 'lookalike_only'); assert.match(only.label, /no verified current intent/i)
  assert.equal(withEv.readiness, 'lookalike_with_event')
  for (const x of [only, withEv]) assert.ok(!/ready.to.buy/i.test(x.label + x.reasons.join()))
  assert.ok(only.fit > 0 && only.reasons.some(r => /keyword "orthodontic"/.test(r)) && only.reasons.every(r => /own evidence$/.test(r)))
  const none = leadLookalikeFit(b, { company: 'Steel Fab', signal: 'expanded', evidence_excerpt: 'Steel Fab expanded its machining plant in Ohio' }, true)
  assert.equal(none.fit, 0); assert.deepEqual(none.reasons, [])
})

test('measured against ordinary ICP retrieval on identical labelled candidates: precision@k and lift (synthetic fixture)', () => {
  const b = block(), icp = discover(ALL).proposal!.icp
  // Ten candidates that ALL match the ordinary profile (dental, New York); only the ones that also share the customers'
  // discriminating traits are labelled good. Interleaved so input order favours neither ranking.
  const cands = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, good: i % 2 === 1, text: `Clinic ${i}, dental clinics in New York${i % 2 === 1 ? ', orthodontic invisalign family practice' : ', cosmetic whitening spa'}` }))
  const la = orderByLookalike(b, cands), base = orderByIcp(icp, cands)
  const c = compareToBaseline(cands, la, base, 5)
  assert.equal(c.lookalike, 1); assert.equal(c.icp, 0.4); assert.ok(Math.abs(c.lift! - 2.5) < 1e-9)
  assert.equal(compareToBaseline(cands, ['c1'], ['c0'], 5).lift, null)
  // the model is not a keyword echo of the ICP: it scores accounts the ICP terms cannot tell apart
  assert.ok(deriveModel(ALL.filter(e => e.kind === 'customer' || e.kind === 'won'), ALL.filter(e => e.kind === 'negative' || e.kind === 'competitor')).discriminators.some(d => d.feature.dimension === 'keyword'))
})

test('the real runner on a lookalike scan: supplied accounts are dropped before any page fetch, counted and audited; net-new leads are kept', async () => {
  const p = discover(ALL).proposal!
  const A1 = 'https://news.example/maple-row', A2 = 'https://news.example/bright-smile-3', A3 = 'https://other5.example/news'
  const page = (t: string) => ({ title: t, text: `Published ${daysAgo(5)}. ${t}. ${'More about the clinic and its patients. '.repeat(12)}` })
  const Q1 = 'Maple Row Dental opened a second orthodontic clinic in New York', Q2 = 'Bright Smile 3 Dental opened a new office in New York', Q3 = 'Other 5 Works opened a new office'
  const r = await runFixture({
    request: p.query, reviewedIcp: p.icp, icpReviewed: true, modelIcp: p.icp, modelQueries: ['dental clinics new york opens'],
    hits: [A1, A2, A3].map((u, i) => ({ url: u, title: [Q1, Q2, Q3][i], snippet: [Q1, Q2, Q3][i], date: daysAgo(5) })),
    tfPages: { [A1]: page(Q1), [A2]: page(Q2), [A3]: page(Q3) }, own: { [A1]: page(Q1), [A2]: page(Q2), [A3]: page(Q3) },
    extraction: [
      { company: 'Maple Row Dental', signal: 'opened a second clinic', source_url: A1, excerpt: Q1, event_date: daysAgo(5) },
      { company: 'Bright Smile 3 Dental', signal: 'opened a new office', source_url: A2, excerpt: Q2, event_date: daysAgo(5) },
      { company: 'Other 5 Works', signal: 'opened a new office', source_url: A3, excerpt: Q3, event_date: daysAgo(5) },
    ],
  })
  const stored = JSON.parse((r.db.prepare('SELECT icp FROM scan_jobs').get() as { icp: string }).icp)
  assert.deepEqual(stored.lookalike, p.icp.lookalike, 'the block is stored with the scan')
  assert.deepEqual(r.leads.map(l => l.company), ['Maple Row Dental'], JSON.stringify(r.leads))
  assert.ok(!r.calls.ownFetch.includes(A2) && !r.calls.ownFetch.includes(A3), 'no page fetched for a supplied account')
  const reasons = JSON.parse(String(r.job.drop_reasons ?? '{}'))
  assert.equal(reasons.lookalike_supplied_customer, 1); assert.equal(reasons.lookalike_supplied_competitor, 1)
  const fates = Object.fromEntries((r.report?.candidates ?? []).map((a: { company: string; fate: string }) => [a.company, a.fate]))
  assert.deepEqual(fates, { 'Bright Smile 3 Dental': 'dropped:lookalike_supplied_customer', 'Other 5 Works': 'dropped:lookalike_supplied_competitor', 'Maple Row Dental': 'verified' }, 'the run report explains each absent account')
  assert.ok(!r.extractionPrompt.includes(p.icp.lookalike.k.c), 'the hashed keys never reach a model prompt')
})

test('the block module icp.ts imports stays import-free (client bundles reach icp.ts; evidence.ts reads process.env)', () => {
  assert.doesNotMatch(readFileSync(new URL('../lib/scan/lookalike-block.ts', import.meta.url), 'utf8'), /^\s*import\s/m)
  assert.match(readFileSync(new URL('../lib/scan/icp.ts', import.meta.url), 'utf8'), /from '\.\/lookalike-block\.ts'/)
})


// #606 review (Instinct, 2026-11-04): domain keys were exact-host, so a supplied customer or competitor came back as "net-new" through a
// subdomain. Supplied accounts now key on the registrable domain; a candidate is checked on its registrable domain and its exact host.
const run = (accts: { name: string; domain?: string | null }[]) => [...new Set(accts.flatMap(accountKeys).map(keyHash))].sort().join('')
const probe = (over: Partial<LookalikeBlock['k']> = {}): LookalikeBlock => ({ ...block(), k: {
  c: run([{ name: 'Acme Robotics', domain: 'acme.com' }, { name: 'Bücher Haus', domain: 'bücher.de' }, { name: 'Northwind Shop', domain: 'shop.northwind.example' }, { name: 'Kiwi Store', domain: 'kiwi.myshopify.com' }]),
  x: run([{ name: 'Rivalco', domain: 'rival.io' }]), n: run([{ name: 'Gamma Freight', domain: 'gamma.co.uk' }]), ...over } })
type Cand = Parameters<typeof knownAccount>[1]
const kind = (c: Record<string, unknown>, b = probe()) => knownAccount(b, { company: 'Unrelated', ...c } as Cand)

test('#606: Instinct\'s probe - names and exact domains (already excluded) and subdomains (the bug) of supplied accounts are all excluded', () => {
  for (const company of ['Acme Robotics', 'Acme Robotics Inc.', 'ACME ROBOTICS LLC', '\uff21cme Robotics']) assert.equal(kind({ company }), 'customer', company)
  for (const company_domain of ['www.acme.com', 'acme.com.', 'jobs.acme.com']) assert.equal(kind({ company_domain }), 'customer', company_domain)
  for (const company_domain of ['https://RIVAL.io/', 'eu.rival.io']) assert.equal(kind({ company_domain }), 'competitor', company_domain)
  assert.equal(kind({ company: 'Acme Labs', source_url: 'https://careers.acme.com/job/1' }), 'customer', 'the customer\'s own careers host, under another name of the same company')
})

test('#606: the whole class - case, trailing dots, www, ports, userinfo, deep subdomains, full-width, IDN, multi-label suffixes, supplied subdomains', () => {
  for (const company_domain of ['ACME.COM', 'acme.com..', 'WWW.Acme.Com.', 'https://user:pw@Jobs.ACME.com:8443/x?y#z', 'a.b.c.jobs.acme.com', '\uff41\uff43\uff4d\uff45.com', 'http://eu.ACME.com/', ' jobs.acme.com ']) assert.equal(kind({ company_domain }), 'customer', company_domain)
  for (const company_domain of ['xn--bcher-kva.de', 'shop.BÜCHER.de', 'https://bücher.de./kontakt']) assert.equal(kind({ company_domain }), 'customer', `IDN ${company_domain}`)
  assert.equal(kind({ company_domain: 'depot.gamma.co.uk' }), 'negative', 'registrable domain under a multi-label public suffix')
  assert.equal(kind({ company_domain: 'northwind.example' }), 'customer', 'a supplied subdomain (shop.northwind.example) covers its registrable domain')
  assert.equal(kind({ company_domain: 'blog.northwind.example' }), 'customer')
  assert.equal(kind({ company_domain: 'kiwi.myshopify.com' }), 'customer')
  assert.equal(kind({ company: 'Acme', source_url: 'https://eu.careers.acme.com/' }), 'customer')
  assert.equal(kind({ company: 'Rival Co', source_url: 'https://jobs.rival.io/a' }), 'competitor', 'name tokens joining to the domain label')
  // the import itself accepts IDN and stores the punycode host, so the same account is one key either way
  const pc = parseCohort([{ kind: 'customer', name: 'Bücher Haus', domain: 'BÜCHER.de' }])
  assert.ok(pc.ok && pc.examples[0].domain === 'xn--bcher-kva.de')
  assert.deepEqual(accountKeys({ name: 'x', domain: 'bücher.de' }), accountKeys({ name: 'x', domain: 'https://www.xn--bcher-kva.de/' }))
})

test('#606: no over-exclusion - lookalike hosts, other tenants on one platform, a public suffix and pages on a supplied domain about someone else', () => {
  for (const company_domain of ['acme.com.evil.io', 'notacme.com', 'acme.co', 'acme-robotics.net', 'acmecom.io', 'rival.io.example', 'other.myshopify.com', 'myshopify.com', 'co.uk', 'com', 'example']) assert.equal(kind({ company_domain }), null, company_domain)
  assert.equal(kind({ company: 'Maple Row Dental', source_url: 'https://careers.acme.com/job/2' }), null, 'a page on the customer\'s domain about another company')
  assert.equal(kind({ company: 'Acmeville Corp', source_url: 'https://careers.acme.com/' }), null, 'a name that only starts with the label is another business')
  assert.equal(kind({ company: 'Labs Acme', source_url: 'https://jobs.acme.com/' }), null)
  assert.equal(kind({ company: 'Other Store', source_url: 'https://kiwi.myshopify.com/blog' }), null)
})

test('#606: wrong types, null, empty, huge and non-UTF8 inputs never throw and never invent a match', () => {
  for (const v of [42, {}, [], null, undefined, true, '', '   ', 'http://', '//', '[::1]', '10.0.0.1', 'a'.repeat(1_000_000) + '.acme.com', '\ud800acme.com', 'acme\u0000.com', 'ac me.com', '..', '.acme.com.', 'x'.repeat(64) + '.acme.com']) {
    assert.doesNotThrow(() => kind({ company_domain: v, source_url: v }))
    const r = kind({ company_domain: v, source_url: v })
    assert.ok(r === null || r === 'customer', String(v).slice(0, 40)) // '.acme.com.' and an over-long first label may still resolve to the customer: fail closed
  }
  for (const company of [null, undefined, 42, {}, '']) assert.doesNotThrow(() => kind({ company, company_domain: 'jobs.acme.com', source_url: 'https://careers.acme.com/' }))
  assert.equal(kind({ company: null, company_domain: 'jobs.acme.com' }), 'customer', 'a missing name still matches on the domain')
  assert.equal(kind({ company: 42, name: 'Acme Robotics' }), 'customer', 'a non-string company falls back to the name')
})

test('#606: blocks stored before registrable keys (exact supplied host) still match that exact host', () => {
  const old = probe({ c: [keyHash('n:acme robotics'), keyHash('d:jobs.acme.com')].sort().join('') })
  assert.equal(kind({ company_domain: 'jobs.acme.com' }, old), 'customer')
  assert.equal(kind({ company_domain: 'https://Jobs.Acme.com/' }, old), 'customer')
})

test('#606: through dropKnown, the run reasons name the supplied kind for each subdomain return', () => {
  const rows = [
    { company: 'Unrelated', company_domain: 'jobs.acme.com', source_url: 'https://x.example/a' },
    { company: 'Unrelated Two', company_domain: 'eu.rival.io', source_url: 'https://x.example/b' },
    { company: 'Acme Labs', source_url: 'https://careers.acme.com/job/1' },
    { company: 'Harbor Orthodontics', company_domain: 'harborortho.example', source_url: 'https://harborortho.example/' },
  ]
  const r = dropKnown(probe(), rows)
  assert.deepEqual(r.kept.map(x => x.company), ['Harbor Orthodontics'])
  assert.deepEqual(r.dropped.map(x => x.reason), ['lookalike_supplied_customer', 'lookalike_supplied_competitor', 'lookalike_supplied_customer'])
})
