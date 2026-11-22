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
