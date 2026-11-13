// #879 "each clause lists its proof source", and the audit counterexample on the issue (2026-11-06): a hiring condition passed on ANY
// stored job-board row whose row date was inside its clock, and called it "a dated posting on this company's job board".
// The rows below are stored rows, exactly as written by the scan: staging's own test accounts (ops read, 2026-11-13: Flexport,
// Qualtrics, Justworks: public job-board postings), and the open-role-count shape all 28 hiring rows on production have (backup
// 2026-11-13; the company and board address are made up, the value / label / date shape is the stored one). Pure proof tests: no
// network, no model, no provider.
import test from 'node:test'
import assert from 'node:assert/strict'
import { compileTargeting, evaluatePlan, planConditions, type Condition } from '../lib/scan/targeting.ts'
import { conditionProof, planProofs, type ProofContext, type ProofLead, type ProofRow } from '../lib/scan/targeting-proof.ts'
import { matchedHiringRole, requestedHiringRoles } from '../lib/scan/hiring-role-match.ts'

const NOW = Date.parse('2026-11-13T12:00:00Z')
const hiring = (q: string): Condition => planConditions(compileTargeting(q).root).map(x => x.cond).find(c => c.kind === 'hiring')!
const ask = (what: string) => `Software companies hiring ${what}, excluding recruiting agencies`
const ctx = (q: string, o: Partial<ProofContext> = {}): ProofContext => ({ query: q, icp: null, salesGatePassed: false, competitors: null, now: NOW, ...o })
const lead = (company: string, domain: string | null = null): ProofLead => ({ company, company_domain: domain, evidence_excerpt: null, signal: null, source_url: 'https://news.example/unrelated', event_date: null })
const prove = (q: string, l: ProofLead, rows: ProofRow[], o: Partial<ProofContext> = {}) => conditionProof(hiring(q), l, rows, ctx(q, o))

// --- stored rows ---------------------------------------------------------------------------------------------------
// Flexport (staging): the dated summary, one dated posting, and listing-audit rows whose row date is the day the board was read.
const FLEX_SUMMARY: ProofRow = { connector: 'signals:greenhouse-gtm', kind: 'hiring', value: '1+ sales/GTM roles posted, newest 2026-09-21', label: 'Account Executive  (1 of 1+ dated shown; 8 listed titles)', source_url: 'https://job-boards.greenhouse.io/flexport/jobs/8192411', source_date: '2026-09-21' }
const FLEX_POSTING: ProofRow = { connector: 'signals:greenhouse-gtm', kind: 'hiring', value: 'Account Executive  - posted 2026-09-21', label: 'Requested role: account executives; San Diego, California, United States; Greenhouse; board updated 2026-11-04', source_url: 'https://job-boards.greenhouse.io/flexport/jobs/8192411', source_date: '2026-09-21' }
const FLEX_AUDIT: ProofRow[] = ['Account Executive, Enterprise', 'Account Executive, Flexport Capital'].map(t => ({ connector: 'signals:greenhouse-gtm', kind: 'hiring-role', value: t, label: 'Board listing audit (requested-role matches only): title listed on the board; its posting date was not read', source_url: 'https://boards.greenhouse.io/flexport', source_date: '2026-11-13' }))
const FLEXPORT = [FLEX_SUMMARY, FLEX_POSTING, ...FLEX_AUDIT]
// Qualtrics (staging): a posting from last week.
const QUAL_SUMMARY: ProofRow = { connector: 'signals:greenhouse-gtm', kind: 'hiring', value: '3+ sales/GTM roles posted, newest 2026-11-06', label: 'Account Executive - Benelux; Account Executive - Account Management Organization ; Account Executive - Account Management Organization  (3 of 3+ dated shown; 31 listed titles)', source_url: 'https://boards.greenhouse.io/qualtrics', source_date: '2026-11-06' }
const QUAL_POSTING: ProofRow = { connector: 'signals:greenhouse-gtm', kind: 'hiring', value: 'Account Executive - Benelux - posted 2026-11-06', label: 'Requested role: account executives; Dublin, Ireland; Greenhouse; board updated 2026-11-13', source_url: 'https://www.qualtrics.com/careers/us/en/job/8355416?gh_jid=8355416', source_date: '2026-11-06' }
// Justworks (staging): every row is marked unconfirmed - the board was found by company name only.
const UNCONFIRMED_NOTE = 'board found under a domain matched by company name; the company-to-board relationship is not established'
const JUSTWORKS: ProofRow[] = [
  ...['Account Executive - In-Territory  (Austin, TX)', 'Account Executive - In-Territory (Chicago)'].map(t => ({ connector: 'signals:greenhouse-gtm', kind: 'hiring-role', value: `Unconfirmed: ${t}`, label: `${UNCONFIRMED_NOTE}; Board listing audit (sales/GTM titles only): posting date read as older than the last 90 days `, source_url: 'https://boards.greenhouse.io/justworks', source_date: '2026-11-13' })),
  // the dated shape an unconfirmed board gets (staging holds 7 of these, e.g. "Unconfirmed: Account Executive, Commercial - posted 2026-10-22")
  { connector: 'signals:greenhouse-gtm', kind: 'hiring', value: 'Unconfirmed: Account Executive, Commercial - posted 2026-10-22', label: `${UNCONFIRMED_NOTE}; Remote - Germany; Greenhouse`, source_url: 'https://job-boards.greenhouse.io/justworks/jobs/6231864004', source_date: '2026-10-22' },
]
// Production's shape (all 28 of its hiring rows): a count of open roles of ANY kind; the row date is the day the board was read.
const COUNT_ROW: ProofRow = { connector: 'signals:lever', kind: 'hiring', value: '139 open roles', label: 'AI Deployment Strategist; AI Deployment Strategist; AI Deployment Strategist', source_url: 'https://jobs.lever.co/northpeak/15e7b82c-ebf3-477c-96b5-96a3b25e0663', source_date: '2026-10-22' }

test('#879 the audit counterexample: an unconfirmed "Software Engineer" listing-audit row does not prove "hiring a CRM administrator within 30 days"', () => {
  // the row of the audit comment, as described there, checked on the day it was checked there
  const row: ProofRow = { connector: 'signals:greenhouse-gtm', kind: 'hiring-role', value: 'Unconfirmed: Software Engineer', label: 'Board listing audit: date was not read', source_url: 'https://boards.greenhouse.io/buyer', source_date: '2026-11-01' }
  const q = ask('a CRM administrator in the last 30 days')
  const p = conditionProof(hiring(q), lead('Buyer', 'buyer.test'), [row], ctx(q, { now: Date.parse('2026-11-06T12:00:00Z') }))
  assert.equal(p.truth, 'unknown', p.reason)
  assert.doesNotMatch(p.reason, /a dated posting on this company's job board/)
})

test('#879 a role the board does not post is not proven by the roles it does post (Flexport: account executives, never a CRM administrator)', () => {
  const p = prove(ask('a CRM administrator in the last 30 days'), lead('Flexport', 'flexport.com'), FLEXPORT)
  assert.equal(p.truth, 'unknown', p.reason)
  assert.match(p.reason, /no dated posting shows this company hiring a CRM administrator/)
  assert.match(p.reason, /other roles \(Account Executive\)/)
  assert.equal(p.source_url, FLEX_POSTING.source_url, 'the unknown names the row it read')
})

test('#879 the row date of a listing-audit row is the day the board was read, never a posting date (Flexport: posted 2026-09-21, read 2026-11-13)', () => {
  const l = lead('Flexport', 'flexport.com')
  // inside 60 days: proven by the posting itself, on its own URL and its own date
  const wide = prove(ask('account executives in the last 60 days'), l, FLEXPORT)
  assert.deepEqual([wide.truth, wide.source_url, wide.date], ['pass', FLEX_POSTING.source_url, '2026-09-21'])
  assert.match(wide.reason, /Account Executive {2}- posted 2026-09-21/)
  // inside 30 days: the posting is 53 days old. main passed this on the audit rows dated 2026-11-13 (the read day)
  const narrow = prove(ask('account executives in the last 30 days'), l, FLEXPORT)
  assert.equal(narrow.truth, 'unknown', narrow.reason)
  assert.match(narrow.reason, /outside this condition's 30-day window/)
  assert.equal(narrow.source_url, FLEX_POSTING.source_url)
  // the audit rows alone, in any order, prove nothing, and the reason says why
  for (const rows of [FLEX_AUDIT, [...FLEX_AUDIT].reverse()]) {
    const p = prove(ask('account executives in the last 30 days'), l, rows)
    assert.equal(p.truth, 'unknown', p.reason)
    assert.match(p.reason, /the board lists Account Executive, (?:Enterprise|Flexport Capital), but its posting date was not read/)
    assert.equal(p.source_url, 'https://boards.greenhouse.io/flexport')
  }
})

test('#879 a board that is not established as the company\'s proves nothing, dated or not (Justworks: every row "Unconfirmed: ")', () => {
  for (const what of ['account executives in the last 60 days', 'sales in the last 60 days', 'a CRM administrator in the last 30 days']) {
    const p = prove(ask(what), lead('Justworks'), JUSTWORKS)
    assert.equal(p.truth, 'unknown', `${what}: ${p.reason}`)
  }
  const p = prove(ask('account executives in the last 60 days'), lead('Justworks'), JUSTWORKS)
  assert.match(p.reason, /that board is not established as this company's/)
  assert.match(p.source_url ?? '', /greenhouse\.io\/justworks/)
})

test('#879 a count of open roles read on some day is not a dated sales posting (production\'s shape: "139 open roles", no sales title among them)', () => {
  const at = { now: Date.parse('2026-10-28T12:00:00Z') }
  for (const what of ['sales in the last 30 days', 'account executives in the last 60 days']) {
    const p = prove(ask(what), lead('Northpeak', 'northpeak.example'), [COUNT_ROW], at)
    assert.equal(p.truth, 'unknown', `${what}: ${p.reason}`)
    assert.match(p.reason, /its board was read \(139 open roles\), but no posting for this role with its own posting date is stored/)
    assert.equal(p.source_url, COUNT_ROW.source_url)
  }
})

test('#879 what still passes names its source: the posting\'s own URL, title and date; the dated summary only for a request that names no title', () => {
  const l = lead('Qualtrics', 'qualtrics.com')
  const named = prove(ask('account executives in the last 30 days'), l, [QUAL_SUMMARY, QUAL_POSTING])
  assert.deepEqual([named.truth, named.source_url, named.date], ['pass', QUAL_POSTING.source_url, '2026-11-06'])
  assert.match(named.reason, /Account Executive - Benelux - posted 2026-11-06/)
  // "hiring sales": any sales / GTM posting, or the dated sales/GTM summary
  const generic = prove(ask('sales in the last 30 days'), l, [QUAL_SUMMARY])
  assert.deepEqual([generic.truth, generic.source_url, generic.date], ['pass', QUAL_SUMMARY.source_url, '2026-11-06'])
  // a named title is never proven by the summary alone (it names no single posting)
  const summaryOnly = prove(ask('account executives in the last 30 days'), l, [QUAL_SUMMARY])
  assert.equal(summaryOnly.truth, 'unknown', summaryOnly.reason)
  // a row whose text says one date and whose row date says another is not a dated posting
  const drift = prove(ask('account executives in the last 30 days'), l, [{ ...QUAL_POSTING, source_date: '2026-11-12' }])
  assert.equal(drift.truth, 'unknown', drift.reason)
  // the careers check's own row shape, with and without a posting date
  const careers = (value: string, date: string): ProofRow => ({ connector: 'signals:careers-gtm', kind: 'hiring', value, label: 'Requested role: account executives; Greenhouse first-published date read from the linked posting; "Join us as an Account Executive"', source_url: 'https://www.qualtrics.com/careers/ae', source_date: date })
  assert.equal(prove(ask('account executives in the last 30 days'), l, [careers('Open role on its careers page: Account Executive - posted 2026-11-02', '2026-11-02')]).truth, 'pass')
  const undated = prove(ask('account executives in the last 30 days'), l, [careers('Open role on its careers page: Account Executive', '2026-11-13')])
  assert.equal(undated.truth, 'unknown', 'a vacancy with no posting date has no date to put on a 30-day clock')
})

test('#879 the role is the one asked for: production wording "their first SDR" is a Sales Development Representative posting, not any sales title', () => {
  // production: the play "B2B SaaS founders ... hiring their first SDR or salesperson", leads stored as "Hiring a Sales Development Representative"
  const roles = requestedHiringRoles('companies hiring SDRs')
  assert.ok(matchedHiringRole('Sales Development Representative', roles))
  assert.ok(matchedHiringRole('Founding Sales Development Representative (SDR)', roles))
  assert.equal(matchedHiringRole('Account Executive, Enterprise', roles), null)
  assert.equal(matchedHiringRole('Business Development Representative, New York', roles), null)
  assert.ok(matchedHiringRole('Business Development Representative, New York', requestedHiringRoles('hiring BDRs')))
  assert.ok(matchedHiringRole('Enterprise Account Executive', requestedHiringRoles('hiring AEs')))
  const row = (title: string): ProofRow => ({ connector: 'signals:ashby-gtm', kind: 'hiring', value: `${title} - posted 2026-11-05`, label: 'Remote; Ashby', source_url: 'https://jobs.ashbyhq.com/northpeak/1', source_date: '2026-11-05' })
  const l = lead('Northpeak', 'northpeak.example')
  assert.equal(prove(ask('SDRs in the last 30 days'), l, [row('Sales Development Representative')]).truth, 'pass')
  const other = prove(ask('SDRs in the last 30 days'), l, [row('Account Executive, Enterprise')])
  assert.equal(other.truth, 'unknown', other.reason)
  assert.match(other.reason, /other roles \(Account Executive, Enterprise\), not SDRs/)
})

test('#879 through a whole plan: a lead whose only hiring rows are audit rows is held on that condition; with the posting it passes and both clauses name a source', () => {
  const q = 'B2B software companies that raised funding in the last 90 days and are hiring account executives in the last 60 days'
  const plan = compileTargeting(q)
  assert.deepEqual(planConditions(plan.root).map(x => [x.cond.id, x.cond.kind]), [['C1', 'funding'], ['C2', 'hiring']])
  const l: ProofLead = { company: 'Flexport', company_domain: 'flexport.com', evidence_excerpt: 'Flexport raised a 40m Series C round led by Example Ventures.', signal: null, source_url: 'https://news.example/flexport-series-c', event_date: '2026-10-20' }
  const held = planProofs(plan, l, FLEX_AUDIT, ctx(q))
  assert.equal(held.C1.truth, 'pass', held.C1.reason)
  assert.equal(held.C2.truth, 'unknown', held.C2.reason)
  assert.equal(evaluatePlan(plan, held).truth, 'unknown')
  const ok = planProofs(plan, l, FLEXPORT, ctx(q))
  assert.equal(evaluatePlan(plan, ok).truth, 'pass')
  for (const id of ['C1', 'C2']) assert.match(ok[id].source_url ?? '', /^https:\/\//, `${id} names its source`)
  assert.deepEqual([ok.C1.source_url, ok.C2.source_url, ok.C2.date], ['https://news.example/flexport-series-c', FLEX_POSTING.source_url, '2026-09-21'])
})

test('#879 a pass that rests on the sales-hiring gate\'s record names the page that record rests on, when the scan stored one', () => {
  const q = 'startups that raised a seed round and are hiring sales'
  const c = hiring(q)
  const l: ProofLead = { company: 'Northpeak', company_domain: 'northpeak.example', evidence_excerpt: 'Northpeak raised a 4m seed round led by Example Ventures.', signal: null, source_url: 'https://news.example/northpeak-seed', event_date: '2026-10-30' }
  const gate = ctx(q, { salesGatePassed: true })
  // the careers check's vacancy row with no posting date (the gate passes on it; it carries no date for a clock of its own)
  const careers: ProofRow = { connector: 'signals:careers-gtm', kind: 'hiring', value: 'Open sales role on its careers page: Account Executive', label: '"We are hiring an Account Executive to join our sales team"', source_url: 'https://northpeak.example/careers', source_date: '2026-11-13' }
  const withPage = conditionProof(c, l, [careers, COUNT_ROW], gate)
  assert.equal(withPage.truth, 'pass', withPage.reason)
  assert.equal(withPage.source_url, 'https://northpeak.example/careers')
  assert.match(withPage.reason, /sales-hiring gate verified an open sales role.*read on https:\/\/northpeak\.example\/careers/)
  assert.equal(withPage.date, undefined, 'the read day is never passed off as a posting date')
  // an open-role count or an unconfirmed board is not that page
  const bare = conditionProof(c, l, [COUNT_ROW, ...JUSTWORKS], gate)
  assert.equal(bare.truth, 'pass')
  assert.equal(bare.source_url, undefined)
  // a posting far outside the gate's own window is not a page the gate can have passed on (it passed on the lead's quote): never cited
  const stale: ProofRow = { connector: 'signals:greenhouse-gtm', kind: 'hiring', value: 'Account Executive - posted 2025-12-01', label: 'Remote; Greenhouse', source_url: 'https://job-boards.greenhouse.io/northpeak/jobs/1', source_date: '2025-12-01' }
  const old = conditionProof(c, l, [stale], gate)
  assert.deepEqual([old.truth, old.source_url], ['pass', undefined], old.reason)
  assert.doesNotMatch(old.reason, /read on/)
  // one inside it is
  const recent: ProofRow = { ...stale, value: 'Account Executive - posted 2026-10-30', source_date: '2026-10-30', source_url: 'https://job-boards.greenhouse.io/northpeak/jobs/2' }
  assert.equal(conditionProof(c, l, [stale, recent], gate).source_url, 'https://job-boards.greenhouse.io/northpeak/jobs/2')
  // without the gate's record the same rows prove nothing
  assert.equal(conditionProof(c, l, [careers, COUNT_ROW], ctx(q)).truth, 'unknown')
})

test('#879 the role matcher: abbreviations a request uses are read as the title; a title\'s stray "AE" / "SDR" is never the sales role', () => {
  const m = (title: string, request: string) => !!matchedHiringRole(title, requestedHiringRoles(`hiring ${request}`))
  // requests abbreviate, boards spell out (and the reverse for SDR / BDR)
  assert.ok(m('Sales Development Representative', 'SDRs'))
  assert.ok(m('SDR - Outbound', 'sales development representatives'))
  assert.ok(m('Senior BDR', 'BDRs'))
  assert.ok(m('Account Executive, Enterprise', 'AEs'))
  assert.ok(m('Sales Representative', 'sales reps'))
  assert.ok(m('Inside Sales Rep', 'sales representatives'))
  assert.ok(m('VP, Sales', 'their first VP of Sales'))
  assert.ok(m('Vice President, Sales', 'a VP of Sales'))
  assert.ok(m('VP of Sales, EMEA', 'a Vice President of Sales'))
  // a title that uses the same letters the request used still matches, as before
  assert.ok(m('Senior AE', 'an AE'))
  assert.ok(m('AE, Enterprise', 'an AE or SDR'))
  assert.ok(m('Sales Engineer / SDR', 'an SDR'))
  assert.ok(m('AES Encryption Engineer', 'AES Encryption Engineers'), 'a title the request names word for word')
  assert.ok(m('Enterprise AE', 'an AE'))
  assert.ok(m('Senior AE - EMEA', 'an AE or SDR'))
  assert.ok(m('SDR - Developer Platform', 'an SDR'), 'a sales title that names what it sells to')
  assert.ok(m('BDR - Technician Services', 'a BDR'))
  assert.ok(m('Developer Platform SDR', 'an SDR'))
  assert.ok(m('Solutions Engineer / BDR', 'a BDR'))
  assert.ok(m('Developer Tools AE', 'an AE'))
  assert.ok(m('Senior AE', 'AE or Account Executive'), 'the abbreviation keeps its own letters when the same request also spells the title out')
  assert.ok(m('Senior AE', 'Account Executive or AE'))
  // a bare "reps" is not "sales reps": it stays as written and matches no "... Representative" title
  assert.equal(m('Customer Service Representative', 'reps'), false)
  assert.equal(m('Patient Representative', 'a rep'), false)
  // another trade's title that happens to carry the letters (reviewers' inputs)
  assert.equal(m('Motion Designer (After Effects / AE)', 'account executives'), false)
  assert.equal(m('Customer Success Manager - Dubai, AE', 'account executives'), false)
  assert.equal(m('AES Encryption Engineer', 'AE'), false)
  assert.equal(m('RF Engineer, SDR (Software Defined Radio)', 'SDRs'), false)
  assert.equal(m('RF Engineer, SDR (Software Defined Radio)', 'an SDR'), false)
  assert.equal(m('Motion Designer (After Effects / AE)', 'an AE'), false)
  // unchanged: one sales title is not another
  assert.equal(m('Account Executive, Enterprise', 'SDRs'), false)
  assert.equal(m('Associate Business Systems Administrator', 'a CRM administrator'), false)
  assert.equal(m('VP, Marketing', 'a VP of Sales'), false)
  // and through the proof: the stray letters do not prove the clause, the spelled-out title does
  const row = (title: string): ProofRow => ({ connector: 'signals:ashby-gtm', kind: 'hiring', value: `${title} - posted 2026-11-05`, label: 'Remote; Ashby', source_url: 'https://jobs.ashbyhq.com/northpeak/2', source_date: '2026-11-05' })
  const l = lead('Northpeak', 'northpeak.example')
  assert.equal(prove(ask('account executives in the last 30 days'), l, [row('Motion Designer (After Effects / AE)')]).truth, 'unknown')
  assert.equal(prove(ask('sales reps in the last 30 days'), l, [row('Sales Representative')]).truth, 'pass')
  // a title that itself contains " - posted " keeps its own date; a named title with only the dated summary says so
  assert.equal(prove(ask('account executives in the last 30 days'), l, [row('Account Executive - posted roles team')]).truth, 'pass')
  const summaryOnly = prove(ask('account executives in the last 30 days'), lead('Qualtrics', 'qualtrics.com'), [QUAL_SUMMARY])
  assert.match(summaryOnly.reason, /only a dated summary of its sales \/ GTM postings is stored .* names no single posting for account executives/)
})
