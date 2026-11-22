// #1205 (Quest live check, prod 383ada0a, job 5a0d05aee78d4a66fc241f15): "independent dental practices in London, Ontario that posted a front
// desk receptionist job in the past 90 days" was not compiled as a plan hiring condition (the plan view said "no trigger or exclusion it can
// check"), so the run had no hiring condition to search or prove. "posted a job for a receptionist" was read; the role BEFORE the job word was
// not. Pure function: no HTTP, no model, no DB.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileTargeting, planConditions } from '../lib/scan/targeting.ts'

const LIVE = 'independent dental practices in London, Ontario that posted a front desk receptionist job in the past 90 days'

test('#1205 the live request compiles to an open-role condition for its role, with its own 90-day window', () => {
  const plan = compileTargeting(LIVE, null)
  assert.ok(plan.root, 'the plan has a condition')
  const conds = planConditions(plan.root).map(x => x.cond)
  assert.equal(conds.length, 1)
  assert.equal(conds[0].kind, 'hiring')
  assert.equal(conds[0].role, 'front desk receptionist')
  assert.equal(conds[0].within_days, 90)
  assert.notEqual(conds[0].window_source, 'default', 'the window is the one the request states')
})

test('#1205 other "posted a <role> job" shapes read the same; the existing "posted a job for <role>" reading is unchanged', () => {
  for (const [q, role] of [
    ['B2B SaaS startups that posted a sales development representative job in the last 30 days', 'sales development representative'],
    ['Agencies in Toronto that posted an account executive job this month', 'account executive'],
    ['Clinics advertising a dental hygienist vacancy', 'dental hygienist'],
    ['Dental practices that posted a receptionist job through Indeed', 'receptionist'],
    ['Dental clinics that posted a receptionist job posting in the last 30 days', 'receptionist'],
    ['Companies that posted a job opening for a sales rep last month', 'sales rep'],
    ['Dental practices that posted a job for a receptionist in the past 60 days', 'receptionist'],
  ] as const) {
    const conds = planConditions(compileTargeting(q, null).root).map(x => x.cond)
    assert.equal(conds.length, 1, q); assert.equal(conds[0].kind, 'hiring', q); assert.equal(conds[0].role, role, q)
  }
})

test('#1205 a post that is not a job is never read as hiring', () => {
  for (const q of [
    'Dental practices that posted a blog article in the past 90 days',
    'Law firms that posted a position paper on AI this year',
    'Startups that posted a new product video',
  ]) assert.ok(!planConditions(compileTargeting(q, null).root).some(x => x.cond.kind === 'hiring'), q)
})

// council (Sonnet R1/R2): the role is a role. "job opening for a nurse" names the nurse; a phrase with grammar words in it ("a press release
// about a new role") is not a role; a work arrangement ("remote") is an open role with no named title
test('#1205 the role read before the job word is a role, never job words, grammar words or a work arrangement', () => {
  const one = (q: string) => planConditions(compileTargeting(q, null).root).map(x => x.cond).filter(c => c.kind === 'hiring')
  const nurse = one('companies that posted a job opening for a nurse')
  assert.equal(nurse.length, 1); assert.equal(nurse[0].role, 'nurse')
  assert.equal(one('companies that posted a press release about a new role in Toronto').length, 0)
  const remote = one('Agencies that posted a remote job in the past 30 days')
  assert.equal(remote.length, 1); assert.notEqual(remote[0].role, '', 'never an any-role condition'); assert.equal(remote[0].within_days, 30)
})

// council (Opus R1/R2, Haiku R1-R3): "opening", "position" and "role" name many things besides a job, so the role-before reading takes only the
// unambiguous job words; ordinary business wording is never a hiring condition, and a negated request stays negated
test('#1205 business wording with opening / position / role is never a hiring condition; the role is never a job word', () => {
  const hiring = (q: string) => planConditions(compileTargeting(q, null).root).filter(x => x.cond.kind === 'hiring')
  for (const q of [
    'Restaurants that posted a grand opening in the past 30 days',
    'Retailers that posted a new office opening this year',
    'Companies that posted a net cash position this quarter',
    'Think tanks that posted a public position on AI',
    'Firms that posted a statement on their role in the merger',
  ]) assert.equal(hiring(q).length, 0, q)
  for (const q of ['Advertising agencies posting senior designer roles in the past 30 days', 'Dental practices advertising their job openings in London, Ontario', 'Advertising firms with an account executive opening'])
    for (const h of hiring(q)) assert.ok(!/^(?:jobs?|agencies|firms)\b/.test(h.cond.role ?? ''), `${q}: role ${h.cond.role}`)
  const neg = planConditions(compileTargeting('Dental practices that have not posted a receptionist job in the past 90 days', null).root)
  assert.equal(neg.length, 1); assert.equal(neg[0].cond.kind, 'hiring'); assert.equal(neg[0].negated, true)
})

// council (Haiku R8/R9): a title with "of" in it is a role; "advertised for a <role> job" is a job advert
test('#1205 titles with "of" and "advertised for a <role> job" are read', () => {
  const one = (q: string) => planConditions(compileTargeting(q, null).root).map(x => x.cond).filter(c => c.kind === 'hiring')
  for (const [q, role] of [
    ['Companies that posted a Director of Sales job in the past 90 days', 'Director of Sales'],
    ['Startups that posted a Head of Marketing job in the last 60 days', 'Head of Marketing'],
    ['Dental practices that advertised for a receptionist job in the past 90 days', 'receptionist'],
  ] as const) { const h = one(q); assert.equal(h.length, 1, q); assert.equal(h[0].role, role, q) }
  assert.equal(one('companies that posted a press release about a new role in the past 90 days').length, 0)
  assert.equal(one('Advertising agencies in Toronto that opened a new office').length, 0)
})

// council (Opus R6/R9): an article or "new" is never the role; "job posting / listing / ad" is a job word, and the role after "for" is read
test('#1205 a, an and new are never the role; job posting / listing / ad name the job', () => {
  const one = (q: string) => planConditions(compileTargeting(q, null).root).map(x => x.cond).filter(c => c.kind === 'hiring')
  for (const [q, role, days] of [
    ['Firms that posted a new job in the past 30 days', '', 30],
    ['Firms that posted a job posting in the last 30 days', '', 30],
    ['Firms that posted a job ad for a paralegal', 'paralegal', null],
    ['Firms that posted a new job posting for a nurse', 'nurse', null],
  ] as const) {
    const h = one(q); assert.equal(h.length, 1, q); assert.equal(h[0].role, role, q)
    if (days !== null) assert.equal(h[0].within_days, days, q)
  }
})

// council (Opus R6/R10/R11): vacancy postings name the job like job postings; a quantity before "of" ("dozens of jobs", "a list of jobs") is no
// role; "advertising for new jobs" is an open role with no title
test('#1205 vacancy listings, quantities and "advertising for new jobs" never leave a filler word as the role', () => {
  const one = (q: string) => planConditions(compileTargeting(q, null).root).map(x => x.cond).filter(c => c.kind === 'hiring')
  for (const [q, role, days] of [
    ['Firms that posted a vacancy listing for a nurse', 'nurse', null],
    ['Firms that posted a new vacancy ad in the past 30 days', '', 30],
    ['Firms advertising for new jobs', '', null],
  ] as const) {
    const h = one(q); assert.equal(h.length, 1, q); assert.equal(h[0].role, role, q)
    if (days !== null) assert.equal(h[0].within_days, days, q)
  }
})

// council (Haiku R11): in a compound request "new" is never read as a role
test('#1205 "advertised new vacancies" in a compound request reads no role "new"', () => {
  const conds = planConditions(compileTargeting('Companies that posted a job opening for a sales rep and advertised new vacancies in the past 30 days', null).root).map(x => x.cond)
  assert.ok(conds.some(c => c.kind === 'hiring' && c.role === 'sales rep'))
  assert.ok(!conds.some(c => c.role === 'new'), JSON.stringify(conds.map(c => c.role)))
})

// council (Haiku R13/R14): a "for <role>" clause never swallows a second posting; a container before "of" is not the title
test('#1205 a second posting after "and" is its own condition', () => {
  const conds = planConditions(compileTargeting('Companies that posted a job opening for a sales rep and advertised new vacancies in the past 30 days', null).root).map(x => x.cond).filter(c => c.kind === 'hiring')
  assert.equal(conds.length, 2, JSON.stringify(conds.map(c => c.role)))
  assert.equal(conds[0].role, 'sales rep'); assert.equal(conds[1].role, ''); assert.equal(conds[1].within_days, 30)
})

// Watcher (#1205, stricter + simpler, no growing word lists): a posting condition whose role cannot be read fails closed. It is held with a
// plain named reason and never becomes an any-role condition, which would search and prove more broadly than the request asked.
import { planProofs } from '../lib/scan/targeting-proof.ts'
test('#1205 a role that cannot be read is held with a plain reason, never searched or proven as any role', () => {
  for (const q of [
    'Companies that posted a range of job openings for a sales rep in the past 90 days',
    'Companies that posted a series of jobs for a dentist in London, Ontario',
    'Firms that posted dozens of jobs',
    'Firms that posted a list of jobs in Toronto',
  ]) {
    const plan = compileTargeting(q, null)
    const conds = planConditions(plan.root).map(x => x.cond).filter(c => c.kind === 'hiring')
    assert.equal(conds.length, 1, q)
    assert.ok(conds[0].role_unreadable, `${q}: held`)
    assert.match(conds[0].role_unreadable!, /^The role in ".+" could not be read\. Name the role before "job", e\.g\. "posted a sales rep job"\.$/, q)
    assert.notEqual(conds[0].role, '', `${q}: never an any-role condition`)
    assert.ok(plan.ambiguities.some(a => a.chosen.startsWith('held')), `${q}: the plan says it is held`)
    // a dated posting row on the company's board would prove an any-role condition; a held one stays unproven with its reason
    const proofs = planProofs(plan, { company: 'Acme', signal: 'hiring', evidence_excerpt: '', source_url: 'https://acme.example/jobs', event_date: '2026-11-20', event_date_proof: 'page_bound' } as never,
      [{ kind: 'hiring', source_date: '2026-11-20', source_url: 'https://acme.example/jobs/1', value: 'Sales Representative' }] as never, { now: Date.parse('2026-11-22T00:00:00Z') } as never)
    assert.equal(proofs[conds[0].id].truth, 'unknown', q); assert.equal(proofs[conds[0].id].reason, conds[0].role_unreadable, q)
  }
})

// council (Opus R13): a phrase that is not a role at all ("a press release about a job") is no condition; only a role the request names but
// this reader cannot read is held (it ends in "of", joins titles with and/or, or has a job word in it)
test('#1205 a non-hiring phrase before "job" is no condition; an unreadable named role is held', () => {
  const hiring = (q: string) => planConditions(compileTargeting(q, null).root).map(x => x.cond).filter(c => c.kind === 'hiring')
  for (const q of ['Firms that posted a press release about a job in Toronto', 'Firms that posted a story about the jobs in Toronto', 'Firms that posted an article on jobs and the economy'])
    assert.equal(hiring(q).length, 0, q)
  const held = hiring('Companies that posted a sales and marketing job in the past 90 days')
  assert.equal(held.length, 1); assert.ok(held[0].role_unreadable)
})

// council (Opus R14): a hyphen is not a word gap. "in-house", "on-call", "in-store" and "on-site" are parts of a role, so a role with one is
// read as that role; the request never silently loses its posting condition
test('#1205 a hyphenated role is read as the role, never dropped', () => {
  const hiring = (q: string) => planConditions(compileTargeting(q, null).root).map(x => x.cond).filter(c => c.kind === 'hiring')
  for (const [q, role] of [
    ['Law firms that posted an in-house counsel job in the past 90 days', 'in-house counsel'],
    ['Hospitals that posted an on-call nurse job in the past 30 days', 'on-call nurse'],
    ['Retailers that posted an in-store associate job in the last 30 days', 'in-store associate'],
    ['Companies that posted an on-site technician job', 'on-site technician'],
  ] as const) {
    const h = hiring(q); assert.equal(h.length, 1, q); assert.equal(h[0].role, role, q); assert.ok(!h[0].role_unreadable, q)
  }
})

// council (Sonnet R1 on 080e58a): "a", "an" and "new" inside the words before "job" ("a brand new sales job") do not make the words a
// non-hiring phrase; the request names a posting, so it is held, never silently dropped
test('#1205 an article or "new" inside the role words holds the condition, never drops it', () => {
  for (const q of ['Firms that posted a brand new sales job in the past 90 days', 'Firms that posted a very new sales job']) {
    const h = planConditions(compileTargeting(q, null).root).map(x => x.cond).filter(c => c.kind === 'hiring')
    assert.equal(h.length, 1, q); assert.ok(h[0].role_unreadable, q)
  }
})

// council (Haiku R1-R3 on 080e58a): a named role with a grammar word in it is held, never dropped. Dropping it on a grammar word would
// search more broadly than asked (Watcher: fail closed, no word lists that decide a request means nothing)
test('#1205 a role with a grammar word or a slash in it is held, never dropped', () => {
  for (const q of ['Companies that posted a sales rep for enterprise job', 'Companies that posted a senior new business manager job', 'Companies that posted an A/B tester job', 'Companies that posted a sales rep at Acme job']) {
    const h = planConditions(compileTargeting(q, null).root).map(x => x.cond).filter(c => c.kind === 'hiring')
    assert.equal(h.length, 1, q); assert.ok(h[0].role_unreadable, q)
  }
})
