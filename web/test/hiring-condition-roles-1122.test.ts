// #1122 follow-up: one hiring condition that names two (or more) roles - "hiring an SDR/BDR or sales rep" - keeps EVERY role, and each
// one is judged on its own. Before: the targeting plan's condition kept only the first role ("SDR/BDR"; "sales rep" dropped), so a
// lead hiring the second role was never proven by its dated posting, and "hiring a receptionist or sales rep" was read as a non-sales
// condition (no sales-hiring proof path at all). The sales gate's own role reader lost "SDR/BDR" in the "posted an SDR/BDR ... job" form.
// Real code path: compileTargeting -> planProofs (the plan's clause proofs) and requestedHiringRoles -> matchedHiringRole (the sales gate).
import test from 'node:test'
import assert from 'node:assert/strict'
import { compileTargeting, planConditions, conditionRoles, evaluatePlan } from '../lib/scan/targeting.ts'
import { titleIsRole } from '../lib/scan/sales-hiring-gate.ts'
import { planProofs, type ProofLead, type ProofRow } from '../lib/scan/targeting-proof.ts'
import { requestedHiringRoles, matchedHiringRole, roleNeedsSourceProof } from '../lib/scan/hiring-role-match.ts'

const hiringConds = (q: string) => planConditions(compileTargeting(q, null).root).map(x => x.cond).filter(c => c.kind === 'hiring')
// the condition's role holds its alternatives separated by '/', as the plan already writes a role's alternatives ("Head of Sales/VP Sales")
const alts = (q: string) => hiringConds(q).map(c => conditionRoles(c).map(r => r.toLowerCase()))

test('#1122 one hiring condition keeps every role it names, each as its own alternative', () => {
  // the real request wording (a B2B buyer play) and its plainer forms
  assert.deepEqual(alts('B2B SaaS companies hiring an SDR/BDR or sales rep in the last 30 days'), [['sdr', 'bdr', 'sales rep']])
  assert.deepEqual(alts('Companies hiring SDRs or AEs'), [['sdrs', 'aes']])
  assert.deepEqual(alts('Companies hiring a sales rep or SDR'), [['sales rep', 'sdr']])
  assert.deepEqual(alts('Companies that posted a job for an SDR or BDR'), [['sdr', 'bdr']])
  // the clock still binds to the one condition
  const [c] = hiringConds('B2B SaaS companies hiring an SDR/BDR or sales rep in the last 30 days')
  assert.equal(c.within_days, 30)
})

test('#1122 an "or" that starts another condition is never read as a second role', () => {
  const plan = compileTargeting('Companies hiring SDRs or raised a Series A in the last 90 days', null)
  const kinds = planConditions(plan.root).map(x => x.cond.kind).sort()
  assert.deepEqual(kinds, ['funding', 'hiring'])
  assert.deepEqual(alts('Companies hiring SDRs or raised a Series A in the last 90 days'), [['sdrs']])
  // places and times after "or" are not roles
  assert.deepEqual(alts('Companies hiring SDRs in Ohio or Texas'), [['sdrs']])
  assert.deepEqual(alts('Companies hiring SDRs or recently'), [['sdrs']])
  // council (sonnet): another condition, a company noun or a clause after "or" is never a role; kinds and the and/or root stay as on main
  const shape = (q: string) => { const p = compileTargeting(q, null); return [p.root?.op, planConditions(p.root).map(x => x.cond.kind)] }
  assert.deepEqual(shape('Companies hiring engineers or opening a new office'), ['or', ['hiring', 'event']])
  assert.deepEqual(alts('Companies hiring engineers or opening a new office'), [['engineers']])
  assert.deepEqual(shape('Companies hiring SDRs or companies that raised funding'), ['or', ['hiring', 'funding']])
  assert.deepEqual(alts('Companies hiring SDRs or companies that raised funding'), [['sdrs']])
  assert.deepEqual(alts('Companies hiring SDRs or founders who are active'), [['sdrs']])
})

const NOW = Date.parse('2026-11-20T12:00:00Z')
const lead: ProofLead = { company: 'Example Dental Group', company_domain: 'exampledental.example', evidence_excerpt: null, signal: null, source_url: 'https://exampledental.example/', event_date: null, event_date_proof: null }
const posting = (title: string): ProofRow => ({ connector: 'ats', kind: 'hiring', value: title, source_url: 'https://boards.example/exampledental/jobs/1', source_date: '2026-11-10' })
const ctx = { query: null, icp: null, salesGatePassed: false, competitors: null, now: NOW }

test('#1122 the second role is matched on its own: a dated sales posting proves "hiring a receptionist or sales rep"', () => {
  const plan = compileTargeting('Dental groups hiring a receptionist or sales rep in the last 30 days', null)
  const [c] = planConditions(plan.root).map(x => x.cond)
  assert.equal(c.kind, 'hiring')
  const p = planProofs(plan, lead, [posting('Sales Representative')], ctx)[c.id]
  assert.equal(p.truth, 'pass', JSON.stringify(p))
  assert.equal(p.date, '2026-11-10')
  // the same condition without the sales role: a sales posting is not its proof (the bar is unchanged for non-sales roles)
  const only = compileTargeting('Dental groups hiring a receptionist in the last 30 days', null)
  const [r] = planConditions(only.root).map(x => x.cond)
  assert.notEqual(planProofs(only, lead, [posting('Sales Representative')], ctx)[r.id].truth, 'pass')
  // a generic job-board row for a role the request did not name (not a sales title) proves neither role
  assert.notEqual(planProofs(plan, lead, [posting('Dental Hygienist')], ctx)[c.id].truth, 'pass')
  // and a posting older than the clock never proves it
  assert.notEqual(planProofs(plan, lead, [{ ...posting('Sales Representative'), source_date: '2026-09-01' }], ctx)[c.id].truth, 'pass')
})

test('#1122 the sales gate reads both roles of "posted an SDR/BDR or sales rep job", each matched separately', () => {
  const roles = requestedHiringRoles('Companies that posted an SDR/BDR or sales rep job in the past 30 days', null)
  assert.deepEqual(roles.map(r => r.normalized), ['sdr', 'bdr', 'salesperson'])
  assert.equal(matchedHiringRole('Sales Development Representative', roles)?.normalized, 'sdr')
  assert.equal(matchedHiringRole('Business Development Representative', roles)?.normalized, 'bdr')
  assert.equal(matchedHiringRole('Sales Representative', roles)?.normalized, 'salesperson')
  assert.equal(matchedHiringRole('Account Executive', roles), null, 'an adjacent role still does not match')
})

// Council (opus, haiku): readings that must not change, each one failed on the first version of this change.
test('#1122 a later condition after "or" keeps its own span; non-roles never become roles', () => {
  const shape = (q: string) => { const p = compileTargeting(q, null); return [p.root?.op, planConditions(p.root).map(x => x.cond.kind)] }
  for (const q of ['Companies hiring SDRs or expanding into Europe', 'Companies hiring SDRs or launching a new product', 'Companies hiring SDRs or won a contract'])
    assert.deepEqual(shape(q), ['or', ['hiring', 'event']], q)
  const fast = compileTargeting('Companies hiring SDRs or expanding fast in the last 90 days', null)
  assert.deepEqual(planConditions(fast.root).map(x => [x.cond.kind, x.cond.within_days]), [['hiring', 90], ['event', 90]])
  for (const q of ['Companies hiring an SDR or later', 'Companies hiring SDRs or New York', 'Companies hiring SDRs or going public', 'Companies hiring SDRs or channel partners',
    'Companies hiring SDRs or remote', 'Companies hiring SDRs or customers', 'Companies hiring SDRs or growing quickly', 'Companies hiring SDRs or raising money'])
    assert.equal(alts(q)[0]?.length, 1, `${q}: ${JSON.stringify(alts(q))}`)
  assert.deepEqual(alts('Companies hiring an SDR and/or AE'), [['sdr', 'ae']])
})

test('#1122 an "or" inside a later place, investor or headcount never turns a list into an OR', () => {
  for (const q of ['B2B companies hiring SDRs, a new funding round, with 10 or more employees', 'Companies hiring SDRs, a recent acquisition, based in Ohio or Texas', 'Companies hiring SDRs, new funding from Sequoia or Accel'])
    assert.equal(compileTargeting(q, null).root?.op, 'and', q)
})

test('#1122 postings: a sales posting proves a sales alternative; a non-sales reading never takes the sales path', () => {
  const at = (q: string, row: ProofRow) => { const p = compileTargeting(q, null); const [c] = planConditions(p.root).map(x => x.cond); return planProofs(p, lead, [row], ctx)[c.id].truth }
  assert.notEqual(at('Dental groups hiring a receptionist or opening a sales office in the last 30 days', posting('Sales Representative')), 'pass')
  // the posting's title must be one of the named roles (Quest: the signal must match the requested role)
  assert.notEqual(at('Companies hiring a receptionist or SDR in the last 30 days', posting('Account Executive')), 'pass')
  assert.notEqual(at('Companies hiring SDRs in the last 30 days', { ...posting('Software Engineer'), kind: 'hiring-role' }), 'pass')
  assert.notEqual(at('Companies hiring a full-stack/backend engineer in the last 30 days', { ...posting('Full-Stack Marketing Manager'), kind: 'hiring-role' }), 'pass')
  assert.notEqual(at('Companies hiring a sales rep in the last 30 days', { ...posting('2 sales/GTM roles posted, newest 2026-11-10'), label: 'Account Executive; Solutions Engineer' }), 'pass')
  assert.equal(at('Companies hiring SDRs in the last 30 days', { ...posting('Sales Development Representative'), kind: 'hiring-role' }), 'pass')
  assert.equal(at('Companies hiring a receptionist or SDR in the last 30 days', { ...posting('Front Desk Receptionist'), kind: 'hiring-role' }), 'pass')
  // a broad request names no title: any dated sales posting counts, as before this change
  assert.equal(at('Companies hiring sales staff in the last 30 days', posting('Account Executive')), 'pass')
})

test('#1122 the sales gate splits "/" only between whole titles and reads "and/or" as one separator', () => {
  assert.deepEqual(requestedHiringRoles('Companies that posted an SDR and/or AE job', null).map(r => r.normalized), ['sdr', 'ae'])
  assert.deepEqual(requestedHiringRoles('Companies that posted a Sales/Marketing coordinator job', null).map(r => r.term), ['Sales/Marketing coordinator'])
  assert.deepEqual(requestedHiringRoles('Companies that posted a full-stack/backend engineer job', null).map(r => r.term), ['full-stack/backend engineer'])
})

// Council round 2 (opus, haiku).
test('#1122 round 2: list commas never borrow an "or" from a later place, investor or headcount', () => {
  for (const q of ['Companies hiring SDRs, a recent acquisition, raised funding from Sequoia or Accel', 'Companies hiring SDRs, a recent acquisition, raised funding, 10 or more employees',
    'Companies hiring SDRs, raised seed funding, based in Ohio or Texas', 'Companies raising seed funding, hiring SDRs, based in Ohio or Texas'])
    assert.equal(compileTargeting(q, null).root?.op, 'and', q)
  // the list's own final "or" still makes it any-one
  assert.equal(compileTargeting('Companies hiring SDRs, raised seed funding, or opened a new office', null).root?.op, 'or')
})

test('#1122 round 2: "X of Y" and rank titles are roles too; a broad alternative keeps any sales posting; "leads" is no title', () => {
  const at = (q: string, row: ProofRow) => { const p = compileTargeting(q, null); const [c] = planConditions(p.root).map(x => x.cond); return planProofs(p, lead, [row], ctx)[c.id].truth }
  assert.deepEqual(alts('Companies hiring a VP of Sales or Head of Sales'), [['vp of sales', 'head of sales']])
  assert.deepEqual(alts('Companies hiring a CRO or VP Sales'), [['cro', 'vp sales']])
  assert.equal(at('Companies hiring a VP of Sales or Head of Sales in the last 30 days', posting('Head of Sales')), 'pass')
  assert.equal(at('Companies hiring a nurse or Director of Nursing in the last 30 days', { ...posting('Director of Nursing'), kind: 'hiring-role' }), 'pass')
  assert.equal(at('Companies hiring an SDR or sales staff in the last 30 days', posting('Account Executive')), 'pass')
  assert.deepEqual(alts('Companies hiring SDRs or inbound leads'), [['sdrs']])
  // round 3 (sonnet): a modifier ending in -ing/-ed opens a title, not a verb; a clause verb still does not
  assert.deepEqual(alts('Companies hiring an SDR or marketing manager'), [['sdr', 'marketing manager']])
  assert.deepEqual(alts('Companies hiring a sales rep or engineering manager'), [['sales rep', 'engineering manager']])
  // titles outside ROLE_WORD ("accounting clerk", "controller") are not further roles: fail closed until #1395's typed parse
  assert.deepEqual(alts('Companies hiring an AE or accounting clerk'), [['ae']])
  assert.deepEqual(alts('Companies hiring a CFO or controller'), [['cfo']])
  // a repeated hiring verb ("or recruiting ...", "or are hiring ...") introduces another role of the same open-role condition
  assert.deepEqual(alts('Companies hiring SDRs or recruiting account executives'), [['sdrs', 'account executives']])
  const off = compileTargeting('Companies hiring a sales rep or opening a new office', null)
  assert.deepEqual([off.root?.op, planConditions(off.root).map(x => x.cond.kind)], ['or', ['hiring', 'event']])
  // one title with a "/" inside stays one title
  assert.deepEqual(alts('Companies hiring a full-stack/backend engineer'), [['full-stack/backend engineer']])
  // "either" and a trailing "roles" are not part of a title
  assert.deepEqual(alts('Companies hiring either an SDR or a sales rep'), [['sdr', 'sales rep']])
  assert.deepEqual(alts('Companies hiring for SDR or sales rep roles'), [['sdr', 'sales rep']])
  // a summary row from a job board (count line, titles in its label) still proves a named sales role, as on main
  assert.equal(at('Companies hiring a sales rep in the last 30 days', { ...posting('2 sales/GTM roles posted, newest 2026-11-10'), label: 'Sales Representative; Account Executive' }), 'pass')
})

test('#1122 round 2: the gate reads "and/or" in the hiring form and AE as a sales title', () => {
  const roles = requestedHiringRoles('Companies hiring SDRs and/or sales reps', null).filter(roleNeedsSourceProof)
  assert.notEqual(matchedHiringRole('SDR', roles), null)
  assert.notEqual(matchedHiringRole('Sales Representative', roles), null)
  assert.deepEqual(requestedHiringRoles('Companies hiring SDRs or AEs', null).filter(roleNeedsSourceProof).map(r => r.normalized), ['sdr', 'ae'])
  // and the plan takes the sales proof path for an AE alternative
  const p = compileTargeting('Companies hiring a receptionist or AE in the last 30 days', null); const [c] = planConditions(p.root).map(x => x.cond)
  assert.equal(planProofs(p, lead, [posting('Account Executive')], ctx)[c.id].truth, 'pass')
})

// Council round 3 (opus, haiku): roles are a list, so a "/" inside one title never merges or splits roles; repeated verbs; -ed titles.
test('#1122 round 3: roles stay separate even when a title has a "/" inside', () => {
  const at = (q: string, row: ProofRow) => { const p = compileTargeting(q, null); const [c] = planConditions(p.root).map(x => x.cond); return planProofs(p, lead, [row], ctx)[c.id].truth }
  assert.deepEqual(alts('Companies hiring a full-stack/backend engineer or sales rep'), [['full-stack/backend engineer', 'sales rep']])
  assert.equal(at('Companies hiring a full-stack/backend engineer or sales rep in the last 30 days', { ...posting('Sales Representative'), kind: 'hiring-role' }), 'pass')
  assert.equal(at('Companies hiring a Sales/Marketing coordinator or SDR in the last 30 days', { ...posting('Sales Development Representative'), kind: 'hiring-role' }), 'pass')
  assert.deepEqual(requestedHiringRoles('Companies hiring a Sales/Marketing coordinator', null).map(r => r.term), ['Sales/Marketing coordinator'])
  assert.equal(at('Companies that are hiring SDRs or are hiring BDRs in the last 30 days', { ...posting('Business Development Representative'), kind: 'hiring-role' }), 'pass')
  // a title outside the compiler's role words (ROLE_WORD) is not read as a further role: fail closed, the typed parse of #1395 reads it
  assert.deepEqual(alts('Companies hiring a receptionist or registered nurse'), [['receptionist']])
  assert.deepEqual(alts('Companies hiring SDRs or head office'), [['sdrs']])
  // a summary row whose listed titles are none of the named roles proves neither
  assert.notEqual(at('Companies hiring a nurse or AE in the last 30 days', { ...posting('2 sales/GTM roles posted, newest 2026-11-10'), label: 'Customer Success Manager' }), 'pass')
  // the list's own final "or" makes "A, new B, a new C, or D" any-one
  assert.equal(compileTargeting('Raised a Series A, new funding, a new Head of Sales, or hiring SDRs', null).root?.op, 'or')
})

// Council round 4 (opus).
test('#1122 round 4: plural requests match their singular postings; undated audit rows prove nothing', () => {
  const at = (q: string, row: ProofRow) => { const p = compileTargeting(q, null); const [c] = planConditions(p.root).map(x => x.cond); return planProofs(p, lead, [row], ctx)[c.id].truth }
  assert.equal(at('Companies hiring receptionists in the last 30 days', { ...posting('Receptionist'), kind: 'hiring-role' }), 'pass')
  assert.equal(at('Companies hiring receptionists in the last 30 days', { ...posting('Front Desk Receptionist'), kind: 'hiring-role' }), 'pass')
  assert.equal(at('Companies hiring nurses in the last 30 days', { ...posting('Registered Nurse'), kind: 'hiring-role' }), 'pass')
  assert.equal(at('Companies hiring salespeople in the last 30 days', { ...posting('Sales Representative'), kind: 'hiring-role' }), 'pass')
  assert.equal(at('Companies hiring a VP of Sales in the last 30 days', posting('VP, Sales')), 'pass')
  // still bounded: a plural request never matches a different role
  assert.notEqual(at('Companies hiring receptionists in the last 30 days', { ...posting('Dental Hygienist'), kind: 'hiring-role' }), 'pass')
  // an audit row that says its posting date was not read is no dated posting
  for (const label of ['its posting date was not read', 'posting date read as older than the last 30 days'])
    assert.notEqual(at('Companies hiring SDRs in the last 30 days', { ...posting('Sales Development Representative'), kind: 'hiring-role', label }), 'pass', label)
})

test('#1122 round 4: list commas read as on main; verbs never open a role; unproven signals compared role by role', () => {
  for (const q of ['Companies hiring SDRs, a Series A, or opened an office', 'Companies raised a Series A, a recent rebrand, or hiring SDRs'])
    assert.equal(compileTargeting(q, null).root?.op, 'and', q)
  for (const q of ['Companies hiring SDRs or laid off sales reps', 'Companies hiring SDRs or added sales reps', 'Companies hiring SDRs or promoted internal sales reps', 'Companies hiring SDRs or lack a sales manager'])
    assert.deepEqual(alts(q), [['sdrs']], q)
  const plan = compileTargeting('Companies hiring an SDR or sales rep in the last 45 days', JSON.stringify({ signals: ['Hiring sales engineers', 'Hiring a sales manager', 'Hiring first sales rep'] }))
  const unproven = plan.unproven.map(u => u.text)
  assert.ok(unproven.includes('Hiring sales engineers') && unproven.includes('Hiring a sales manager'), JSON.stringify(unproven))
  assert.ok(!unproven.includes('Hiring first sales rep'), 'a role the condition names is covered')
})

// Quest: both of these are #1122 bugs, not out of scope.
test('#1122 a comma-listed "or" list of roles keeps every role ("SDRs, AEs, or sales reps")', () => {
  const at = (q: string, row: ProofRow) => { const p = compileTargeting(q, null); const [c] = planConditions(p.root).map(x => x.cond); return planProofs(p, lead, [row], ctx)[c.id].truth }
  assert.deepEqual(alts('Companies hiring SDRs, AEs, or sales reps'), [['sdrs', 'aes', 'sales reps']])
  assert.deepEqual(alts('Companies hiring SDRs, AEs or sales reps in the last 30 days'), [['sdrs', 'aes', 'sales reps']])
  assert.equal(at('Companies hiring SDRs, AEs, or sales reps in the last 30 days', { ...posting('Account Executive'), kind: 'hiring-role' }), 'pass')
  // a comma that separates conditions stays a condition separator
  const p = compileTargeting('Companies hiring SDRs, raised funding, or opened an office', null)
  assert.deepEqual(planConditions(p.root).map(x => x.cond.kind), ['hiring', 'funding', 'event'])
  assert.deepEqual(alts('Companies hiring SDRs, raised funding, or opened an office'), [['sdrs']])
})

test('#1122 a lead\'s own quote proves the condition only through a role the request names', () => {
  const quoted = (excerpt: string): ProofLead => ({ ...lead, evidence_excerpt: excerpt, signal: excerpt, event_date: '2026-11-10' })
  const truth = (q: string, l: ProofLead) => { const p = compileTargeting(q, null); const [c] = planConditions(p.root).map(x => x.cond); return planProofs(p, l, [], ctx)[c.id].truth }
  const ae = quoted('Example Dental Group is hiring an Account Executive to grow its new-patient programme.')
  const sdr = quoted('Example Dental Group is hiring a sales development rep to book new-patient consultations.')
  assert.notEqual(truth('Companies hiring SDRs in the last 30 days', ae), 'pass', 'an AE quote never proves an SDR request')
  assert.notEqual(truth('Companies hiring a receptionist or SDR in the last 30 days', ae), 'pass')
  assert.equal(truth('Companies hiring SDRs in the last 30 days', sdr), 'pass')
  assert.equal(truth('Companies hiring SDRs or AEs in the last 30 days', ae), 'pass', 'the AE alternative is named')
  // a request naming no specific title keeps main's rule: any affirmative sales-hiring quote
  assert.equal(truth('Companies hiring sales staff in the last 30 days', ae), 'pass')
})

test('#1122 a bare role list with no "or" ("SDRs, AEs") is an OR of roles too (the #1509 comma rule)', () => {
  assert.deepEqual(alts('Companies hiring SDRs, AEs'), [['sdrs', 'aes']])
  assert.deepEqual(alts('Companies hiring SDRs, AEs, sales reps in the last 30 days'), [['sdrs', 'aes', 'sales reps']])
  const p = compileTargeting('Companies hiring SDRs, AEs in the last 30 days', null)
  const [c] = planConditions(p.root).map(x => x.cond)
  assert.equal(planConditions(p.root).length, 1)
  assert.equal(planProofs(p, lead, [{ ...posting('Account Executive'), kind: 'hiring-role' }], ctx)[c.id].truth, 'pass', 'the AE alternative proves it')
  // a comma before another condition still separates conditions
  assert.deepEqual(alts('Companies hiring SDRs, raised funding'), [['sdrs']])
})

// Qodo #1534 High 1: the generic board row says its posting date is unknown (the row date is when the board was read); a title it lists
// is no dated posting, even when the request names that title.
test('Qodo #1534 H1: an aggregate board row whose posting date is unknown proves no named role', () => {
  const generic: ProofRow = { connector: 'signals:greenhouse', kind: 'hiring', value: '2 open roles (generic hiring; posting date unknown - the row date is when the board was read, not a posting date)', label: 'Receptionist; Account Executive', source_url: 'https://boards.example/exampledental', source_date: '2026-11-18' }
  for (const q of ['Companies hiring a receptionist or AE in the last 30 days', 'Companies hiring AEs in the last 30 days', 'Companies hiring sales staff in the last 30 days']) {
    const p = compileTargeting(q, null); const [c] = planConditions(p.root).map(x => x.cond)
    assert.notEqual(planProofs(p, lead, [generic], ctx)[c.id].truth, 'pass', q)
  }
})

// Qodo #1534 High 2: the gate's durable pass does not record which title it verified, so it covers a hiring condition only when every
// title the gate checked is one of that condition's own roles; separate SDR and AE conditions each need their own evidence.
test('Qodo #1534 H2: the gate pass for one role never proves a condition naming another', () => {
  // the gate checks SDR or AE (every title the request names); the plan's condition names SDRs only, so the gate's pass may be an AE posting
  const q = 'Companies hiring SDRs and posted an AE job in the last 30 days'
  assert.deepEqual(requestedHiringRoles(q, null).filter(roleNeedsSourceProof).map(r => r.normalized).sort(), ['ae', 'sdr'])
  const p = compileTargeting(q, null); const [c] = planConditions(p.root).map(x => x.cond)
  assert.deepEqual(conditionRoles(c).map(r => r.toLowerCase()), ['sdrs'])
  assert.notEqual(planProofs(p, lead, [], { ...ctx, query: q, salesGatePassed: true })[c.id].truth, 'pass', 'an AE posting the gate passed never proves the SDR condition')
  // the gate checked exactly this condition's roles: its durable pass still covers it
  const one = 'Companies hiring SDRs or AEs in the last 30 days', p1 = compileTargeting(one, null), [c1] = planConditions(p1.root).map(x => x.cond)
  assert.equal(planProofs(p1, lead, [], { ...ctx, query: one, salesGatePassed: true })[c1.id].truth, 'pass')
})

// Qodo #1534 M3: a repeated hiring verb before a further role is counted in the condition's span
test('Qodo #1534 M3: "or recruiting AEs" keeps the condition span whole; the list stays an OR', () => {
  const q = 'Companies hiring SDRs or recruiting AEs, raised funding, or opened an office'
  const p = compileTargeting(q, null); const conds = planConditions(p.root).map(x => x.cond)
  assert.equal(conds[0].text, 'hiring SDRs or recruiting AEs')
  assert.deepEqual(conds.map(c => c.kind), ['hiring', 'funding', 'event'])
  assert.equal(p.root?.op, 'or')
  // a conjunction never opens a further role
  assert.deepEqual(alts('Companies hiring SDRs, and hiring AEs').map(r => r.filter(x => /^(?:and|or)\b/.test(x))), [[]])
})

// Qodo #1534 M4 (#1122's own rule, test 16): a role proves a hiring condition only when the hiring statement itself names it. A role
// mentioned elsewhere in the quote ("its SDR team supports outbound") is no open role.
test('Qodo #1534 M4: a role proves the condition only inside the hiring statement', () => {
  const quoted = (excerpt: string): ProofLead => ({ ...lead, evidence_excerpt: excerpt, signal: excerpt, event_date: '2026-11-10' })
  const truth = (q: string, l: ProofLead) => { const p = compileTargeting(q, null); const [c] = planConditions(p.root).map(x => x.cond); return planProofs(p, l, [], ctx)[c.id].truth }
  const sdrQ = 'Companies hiring SDRs in the last 30 days'
  for (const ex of [
    'Example Dental Group is hiring an Account Executive; its SDR team supports outbound.',
    'Example Dental Group is hiring an Account Executive. Its SDR team supports outbound.',
    'Example Dental Group is hiring an Account Executive, and its SDR team supports outbound.',
    'Example Dental Group is hiring an Account Executive but its SDR team is fully staffed.',
  ]) assert.notEqual(truth(sdrQ, quoted(ex)), 'pass', ex)
  // the hiring statement names the role: still proven
  assert.equal(truth(sdrQ, quoted('Example Dental Group has a strong outbound motion. Example Dental Group is hiring SDRs to book consultations.')), 'pass')
  assert.equal(truth('Companies hiring SDRs or AEs in the last 30 days', quoted('Example Dental Group is hiring an Account Executive; its SDR team supports outbound.')), 'pass')
})

test('Qodo #1534 M4: a dot inside the company name never splits the hiring statement', () => {
  const l: ProofLead = { ...lead, company: 'Example.com', evidence_excerpt: 'Example.com is hiring SDRs to book consultations.', signal: 'Example.com is hiring SDRs to book consultations.', event_date: '2026-11-10' }
  const p = compileTargeting('Companies hiring SDRs in the last 30 days', null); const [c] = planConditions(p.root).map(x => x.cond)
  assert.equal(planProofs(p, l, [], ctx)[c.id].truth, 'pass')
})

// Quest (#1534 M5): the sales gate finds the role in a title by the planner's own normalization (one shared normalizer): plural and
// singular, and "VP of Sales" = "VP Sales". Its surrounding-title rules still apply.
test('Quest #1534 M5: the gate reads a title by the planner\'s normalization', () => {
  const rs = (q: string) => requestedHiringRoles(q, null)
  assert.ok(titleIsRole('VP Sales', rs('Companies hiring a VP of Sales')), 'VP Sales is the requested VP of Sales')
  assert.ok(titleIsRole('VP of Sales', rs('Companies hiring a VP Sales')), 'and the reverse')
  assert.ok(titleIsRole('Sales Manager', rs('Companies hiring sales managers')), 'a plural request names the singular title')
  assert.ok(titleIsRole('Sales Managers', rs('Companies hiring a sales manager')), 'and the reverse')
  // the gate's title rules still hold: another title around the role is not it
  assert.equal(titleIsRole('VP Sales Operations Analyst', rs('Companies hiring a VP of Sales')), null)
  assert.equal(titleIsRole('Sales Manager Recruiter', rs('Companies hiring sales managers')), null)
})

// Quest (#1534): a required pair. "hiring SDRs and hiring AEs" keeps both roles, AND-ed, and each is proven on its own evidence.
test('Quest #1534: "hiring SDRs and hiring AEs" is two conditions, both required', () => {
  const q = 'Companies hiring SDRs and hiring AEs in the last 30 days'
  const p = compileTargeting(q, null); const conds = planConditions(p.root).map(x => x.cond)
  assert.deepEqual(conds.map(c => [c.kind, conditionRoles(c).map(r => r.toLowerCase())]), [['hiring', ['sdrs']], ['hiring', ['aes']]])
  assert.equal(p.root?.op, 'and')
  const sdr = { ...posting('Sales Development Representative'), kind: 'hiring-role' } as ProofRow
  const ae = { ...posting('Account Executive'), kind: 'hiring-role', source_url: 'https://boards.example/exampledental/jobs/2' } as ProofRow
  const verdict = (rows: ProofRow[]) => evaluatePlan(p, planProofs(p, lead, rows, ctx)).truth
  assert.notEqual(verdict([sdr]), 'pass', 'an SDR posting alone never proves the AE half')
  assert.notEqual(verdict([ae]), 'pass')
  assert.equal(verdict([sdr, ae]), 'pass', 'each role proven by its own posting')
  // the gate never covers either half: it checked a title the other half names
  const gp = planProofs(p, lead, [], { ...ctx, query: q, salesGatePassed: true })
  assert.deepEqual(conds.map(c => gp[c.id].truth === 'pass'), [false, false])
  // the same with "are hiring" / "recruiting", and an "or" between the clauses stays an OR of roles
  for (const v of ['Companies hiring SDRs and are hiring AEs', 'Companies hiring SDRs and recruiting AEs'])
    assert.deepEqual(alts(v), [['sdrs'], ['aes']], v)
  assert.deepEqual(alts('Companies hiring SDRs or hiring AEs'), [['sdrs', 'aes']])
})
