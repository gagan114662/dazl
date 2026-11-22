// #1122 follow-up: one hiring condition that names two (or more) roles - "hiring an SDR/BDR or sales rep" - keeps EVERY role, and each
// one is judged on its own. Before: the targeting plan's condition kept only the first role ("SDR/BDR"; "sales rep" dropped), so a
// lead hiring the second role was never proven by its dated posting, and "hiring a receptionist or sales rep" was read as a non-sales
// condition (no sales-hiring proof path at all). The sales gate's own role reader lost "SDR/BDR" in the "posted an SDR/BDR ... job" form.
// Real code path: compileTargeting -> planProofs (the plan's clause proofs) and requestedHiringRoles -> matchedHiringRole (the sales gate).
import test from 'node:test'
import assert from 'node:assert/strict'
import { compileTargeting, planConditions } from '../lib/scan/targeting.ts'
import { planProofs, type ProofLead, type ProofRow } from '../lib/scan/targeting-proof.ts'
import { requestedHiringRoles, matchedHiringRole } from '../lib/scan/hiring-role-match.ts'

const hiringConds = (q: string) => planConditions(compileTargeting(q, null).root).map(x => x.cond).filter(c => c.kind === 'hiring')
// the condition's role holds its alternatives separated by '/', as the plan already writes a role's alternatives ("Head of Sales/VP Sales")
const alts = (q: string) => hiringConds(q).map(c => (c.role ?? '').split('/').map(r => r.trim().replace(/^(?:a|an|the)\s+/i, '').toLowerCase()).filter(Boolean))

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

test('#1122 a posting proves the condition only when its title is one of the roles it names', () => {
  const at = (q: string, row: ProofRow) => { const p = compileTargeting(q, null); const [c] = planConditions(p.root).map(x => x.cond); return planProofs(p, lead, [row], ctx)[c.id].truth }
  assert.notEqual(at('Dental groups hiring a receptionist or opening a sales office in the last 30 days', posting('Sales Representative')), 'pass')
  assert.notEqual(at('Companies hiring a receptionist or SDR in the last 30 days', posting('Account Executive')), 'pass')
  assert.notEqual(at('Companies hiring SDRs in the last 30 days', { ...posting('Software Engineer'), kind: 'hiring-role' }), 'pass')
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
