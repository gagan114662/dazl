// Qodo review of #1509 (#1122): High 1 (undated / aggregate rows as postings), High 2 (hybrid sales titles), High 3 (unbound joined dates),
// Medium 4 (a first-hire alternative in a longer OR).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileTargeting, planConditions } from '../lib/scan/targeting.ts'
import { planProofs } from '../lib/scan/targeting-proof.ts'
import { salesGateOr, salesHiringRequired } from '../lib/scan/sales-hiring-required.ts'
import { requestedHiringRoles } from '../lib/scan/hiring-role-match.ts'

const Q = 'Find B2B companies that show a dated buying signal in the last 45 days: hiring an SDR, new funding, or a new Head of Sales/VP Sales.'
const NOW = Date.parse('2026-11-21T12:00:00Z')
const ctx = { query: Q, icp: null, salesGatePassed: false, competitors: null, now: NOW }
const plan = () => compileTargeting(Q, null)
const nr = () => planConditions(plan().root).find(c => c.cond.kind === 'hire_made')!.cond.id
const lead = (o: Record<string, unknown> = {}) => ({ company: 'Uare.ai', company_domain: null, evidence_excerpt: '', signal: null, source_url: 'https://uare.ai/x', event_date: null, event_date_proof: null, ...o })
const row = (o: Record<string, unknown>) => ({ connector: 'signals:greenhouse-gtm', kind: 'hiring', value: '', source_url: 'https://boards.example/uare/1', source_date: '2026-11-10', label: null, ...o })

test('H1: an aggregate board row never dates a requested title; one dated posting record does', () => {
  const agg = row({ value: '3 open roles (generic hiring; posting date unknown - the row date is when the board was read, not a posting date)', label: 'Head of Sales; Engineer; Designer' })
  assert.notEqual(planProofs(plan(), lead(), [agg], ctx)[nr()].truth, 'pass', 'a multi-title count row')
  const many = row({ value: 'Account Executive - posted 2026-11-10', label: 'Head of Sales listed too' })
  assert.notEqual(planProofs(plan(), lead(), [many], ctx)[nr()].truth, 'pass', 'the title comes from the record, not its label')
  const old = [row({ kind: 'hiring-role', value: 'Head of Sales', source_date: '2026-11-15', label: 'Board listing audit (all listed titles): title listed on the board; its posting date was not read' }), row({ value: 'Designer - posted 2026-11-15' })]
  assert.notEqual(planProofs(plan(), lead(), old, ctx)[nr()].truth, 'pass', 'an undated listed title beside a newer unrelated posting')
  const ok = planProofs(plan(), lead(), [row({ value: 'Head of Sales - posted 2026-11-10' })], ctx)[nr()]
  assert.equal(ok.truth, 'pass'); assert.match(ok.reason, /posted 2026-11-10/)
})

test('H3: a joined quote dates the hire only with a source-bound date proof', () => {
  const q = { evidence_excerpt: 'Uare.ai hired Dana Lee as its new Head of Sales.', signal: 'Uare.ai hired a Head of Sales', event_date: '2026-11-10' }
  assert.equal(planProofs(plan(), lead({ ...q, event_date_proof: 'page_bound' }), [], ctx)[nr()].truth, 'pass')
  for (const p of [null, 'published_date', 'bogus']) assert.notEqual(planProofs(plan(), lead({ ...q, event_date_proof: p }), [], ctx)[nr()].truth, 'pass', String(p))
  assert.doesNotMatch(planProofs(plan(), lead({ ...q, event_date_proof: 'ats_structured' }), [], ctx)[nr()].reason, /joined/, 'a board posting day never dates a joined hire')
})

test('H2: a slash inside one title keeps its sales qualifier; a slash between whole titles still splits', () => {
  assert.equal(salesHiringRequired('Companies hiring a sales/marketing manager', null), true)
  assert.ok(requestedHiringRoles('Companies hiring a sales/marketing manager', null).some(r => /sales\/marketing manager/i.test(r.term)))
  const t = requestedHiringRoles('Companies hiring a new Head of Sales/VP Sales', null).map(r => r.normalized)
  assert.ok(t.some(x => /head of sales/.test(x)) && t.some(x => /vp sales/.test(x)), JSON.stringify(t))
  assert.deepEqual(requestedHiringRoles('Agencies hiring SDR/BDR reps', null).length >= 2, true)
})

test('M4: a first sales hire is the hiring branch of a longer OR', () => {
  const or = salesGateOr('Startups that raised seed funding or made their first sales hire or a new Head of Sales', null)
  assert.ok(or, 'still an any-one OR')
  assert.equal(or!.hiring.kind, 'hire_made'); assert.equal(or!.newRoles?.length, 1)
})
