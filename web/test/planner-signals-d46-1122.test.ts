import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileTargeting, planConditions, planView, roleAlternatives } from '../lib/scan/targeting.ts'

// #1122 follow-up, case 1: job d46c65cb asked for four signals and the plan kept two ("a new Head of Sales/VP Sales" has no verb and
// "a founder still doing sales" is a state). The exact request and profile from prod, through the real deterministic planner.
const Q = "Find B2B companies (5-200 employees) doing outbound sales that show a dated buying signal in the last 45 days: hiring their first SDR/BDR or sales rep, new funding, a new Head of Sales/VP Sales, or a founder still doing sales. Buyer: Founder, CEO or Head of Sales. seller = dazl (dazl.ai): AI that finds high-intent leads and drafts reviewed cold outreach from your own Gmail."
const ICP = JSON.stringify({ summary: 'Founders, CEOs, or Heads of Sales at B2B companies with 5-200 employees doing outbound sales who recently hired their first SDR/BDR/sales rep, received funding, hired a new Head/VP of Sales, or have a founder still doing sales in the last 45 days.', who: ['Founder', 'CEO', 'Head of Sales'], industries: [], sizes: ['5-200 employees'], where: [], signals: ['Hiring first SDR', 'Hiring first BDR', 'Hiring first sales rep', 'New funding in last 45 days', 'New Head of Sales hired in last 45 days', 'New VP Sales hired in last 45 days', 'Founder still doing sales'], exclude: ['Non-B2B companies', 'Companies not doing outbound sales'], window_days: 45 })

test('d46c65cb: every requested signal is a plan condition or listed as unproven with a reason', () => {
  const plan = compileTargeting(Q, ICP)
  const conds = planConditions(plan.root)
  assert.deepEqual(conds.map(c => [c.cond.kind, c.negated]), [['hiring', false], ['funding', false], ['hire_made', false]], 'open role, funding and the new sales leader are all conditions')
  assert.equal(plan.root?.op, 'or', 'the list "A, B, C, or D" is any one of them, not all of them')
  assert.match(conds[2].cond.text, /new Head of Sales\/VP Sales/)
  for (const c of conds) assert.equal(c.cond.within_days, 45)
  const unproven = (plan.unproven ?? []).map(u => u.text)
  assert.ok(unproven.includes('Founder still doing sales'), 'a state with no dated event stays visible as unproven')
  // #1122 follow-up: the open-role condition now names every role of "SDR/BDR or sales rep", so the saved "Hiring first sales rep"
  // signal is a real condition of the plan (each role matched on its own), not an unproven note
  assert.deepEqual(roleAlternatives(conds[0].cond.role ?? '').map(r => r.toLowerCase()), ['sdr', 'bdr', 'sales rep'])
  assert.ok(!unproven.includes('Hiring first sales rep'), 'the sales-rep signal is covered by the plan\'s open-role condition')
  for (const u of plan.unproven) assert.match(u.reason, /never counted as met/)
  for (const s of (JSON.parse(ICP).signals as string[])) {
    const kept = unproven.includes(s) || conds.some(c => compileTargeting(s).root && planConditions(compileTargeting(s).root).some(x => x.cond.kind === c.cond.kind))
    assert.ok(kept, `${s} survives into the plan or is held`)
  }
  // Internal only: the view the owner sees (and the plan card) carries no unproven list or its text.
  const view = JSON.stringify(planView(plan))
  assert.ok(!('unproven' in planView(plan)))
  for (const u of plan.unproven) { assert.ok(!view.includes(u.text)); assert.ok(!view.includes(u.reason)) }
  const card = readFileSync(new URL('../app/app/leads/plan-view.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(card, /unproven|not checked/i)
})

test('"hiring new account executives" stays an open role; a bare "a new <role>" is a completed hire', () => {
  assert.deepEqual(planConditions(compileTargeting('companies hiring new account executives').root).map(c => c.cond.kind), ['hiring'])
  assert.deepEqual(planConditions(compileTargeting('companies with a new VP of Marketing').root).map(c => c.cond.kind), ['hire_made'])
  assert.deepEqual(planConditions(compileTargeting('companies with a new office').root).map(c => c.cond.kind), [], 'no role word, no condition')
})

test('a request with no profile signals reports nothing unproven', () => {
  assert.deepEqual(compileTargeting('agencies hiring SDRs', null).unproven, [])
})

// Parent's ask (runs d46c65cb and b9a34d2d, Uare.ai): "a new Head of Sales/VP Sales" is met by a dated posting for that role OR a dated source
// saying the person joined; the reason says which. No dated source: not met.
import { planProofs } from '../lib/scan/targeting-proof.ts'
import { salesGateOr } from '../lib/scan/sales-hiring-required.ts'
import { requestedHiringRoles, matchedHiringRole } from '../lib/scan/hiring-role-match.ts'
const NOW = Date.parse('2026-11-21T12:00:00Z')
const ctx = { query: Q, icp: ICP, salesGatePassed: false, competitors: null, now: NOW }
const c3 = () => planConditions(compileTargeting(Q, ICP).root).find(c => c.cond.kind === 'hire_made')!.cond.id
const lead = (o: Partial<Parameters<typeof planProofs>[1]> = {}) => ({ company: 'Uare.ai', company_domain: null, evidence_excerpt: 'Uare.ai is hiring a Head of Sales to build the team.', signal: 'Uare.ai is hiring a Head of Sales', source_url: 'https://job-boards.greenhouse.io/uareai/jobs/4459513009', event_date: '2026-10-20', event_date_proof: 'ats_structured', ...o })

test('a dated Head of Sales posting meets "a new Head of Sales/VP Sales" and says it is a posting', () => {
  const p = planProofs(compileTargeting(Q, ICP), lead(), [], ctx)[c3()]
  assert.equal(p.truth, 'pass'); assert.match(p.reason, /^hiring a Head of Sales\/VP Sales, posted 2026-10-20/); assert.doesNotMatch(p.reason, /joined/)
  const row = planProofs(compileTargeting(Q, ICP), lead({ event_date_proof: null, event_date: null, signal: null, evidence_excerpt: '' }), [{ connector: 'signals:ashby-gtm', kind: 'hiring-role', value: 'VP Sales', source_url: 'https://jobs.ashbyhq.com/x/1', source_date: '2026-11-01', label: 'first-published date read from the posting' }], ctx)[c3()]
  assert.equal(row.truth, 'pass'); assert.match(row.reason, /posted 2026-11-01/)
})

test('a source saying the person joined meets it and says "joined"; no dated source, an undated board title or another role does not', () => {
  const j = planProofs(compileTargeting(Q, ICP), lead({ evidence_excerpt: 'Uare.ai hired Dana Lee as its new Head of Sales.', signal: 'Uare.ai hired a Head of Sales', event_date: '2026-11-10', event_date_proof: 'published_date', source_url: 'https://uare.ai/news/dana' }), [], ctx)[c3()]
  assert.equal(j.truth, 'pass'); assert.match(j.reason, /^new Head of Sales\/VP Sales joined 2026-11-10/)
  assert.notEqual(planProofs(compileTargeting(Q, ICP), lead({ event_date: null, event_date_proof: null }), [], ctx)[c3()].truth, 'pass', 'no dated source')
  assert.notEqual(planProofs(compileTargeting(Q, ICP), lead({ event_date: null, event_date_proof: null, signal: null, evidence_excerpt: '' }), [{ connector: 'signals:greenhouse', kind: 'hiring-role', value: 'Head of Sales', source_url: 'https://x/1', source_date: '2026-11-20', label: 'Board listing audit (all listed titles): title listed on the board; its posting date was not read' }], ctx)[c3()].truth, 'pass', 'a listed title without its posting date')
  assert.notEqual(planProofs(compileTargeting(Q, ICP), lead({ signal: 'Uare.ai is hiring a Sales Development Representative', evidence_excerpt: 'Uare.ai is hiring an SDR.' }), [], ctx)[c3()].truth, 'pass', 'an SDR posting is not a Head of Sales')
  assert.notEqual(planProofs(compileTargeting(Q, ICP), lead({ event_date: '2026-08-01' }), [], ctx)[c3()].truth, 'pass', 'outside the 45-day window')
})

test('the sales-hiring gate keeps the any-one OR for this request and reads Head of Sales / VP Sales as requested titles', () => {
  const or = salesGateOr(Q, ICP)
  assert.ok(or, 'the four-way list is still an OR for the gate (not both halves required)')
  assert.equal(or!.event.kind, 'funding'); assert.equal(or!.hiring.kind, 'hiring'); assert.equal(or!.newRoles?.length, 1)
  const roles = requestedHiringRoles(Q, ICP)
  assert.ok(matchedHiringRole('Head of Sales', roles)); assert.ok(matchedHiringRole('VP Sales', roles))
  assert.equal(matchedHiringRole('Head of Marketing', roles), null)
})
