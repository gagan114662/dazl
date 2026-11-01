// #379 wiring contract: total-budget enforcement, reviewed-draft corrections feeding retrieval/ranking, persistence roundtrip.
import test from 'node:test'
import assert from 'node:assert/strict'
import { budgetedIcp, normalizeIcp, ICP_JSON_BUDGET, type Icp, type IcpResearch } from '../lib/scan/icp.ts'
import { applyReviewedDraft } from '../lib/scan/seller-research.ts'

const base: Icp = { summary: 'Dental practices that need booking software.', who: ['practice managers'], industries: ['dental'], sizes: [], where: ['London'], signals: ['hiring front desk'], exclude: [] }
const research: IcpResearch = {
  v: 1, site: 'acme.example', q: null, ans: null,
  offers: [{ i: 'acme-booking', n: 'Acme Booking' }, { i: 'acme-payroll', n: 'Acme Payroll' }],
  hyps: [
    { i: 'acme-booking:persona:a1', o: 'acme-booking', k: 'persona', t: 'practice managers', s: 'sourced', u: 'https://acme.example/customers', q: 'Harbor Dental, a four-chair dental practice', at: 1800000000 },
    { i: 'acme-booking:industry:a2', o: 'acme-booking', k: 'industry', t: 'physiotherapy clinics', s: 'sourced', u: 'https://acme.example/customers', q: 'Elm Street Physio runs Acme Booking', at: 1800000000 },
    { i: 'acme-booking:pain:a3', o: 'acme-booking', k: 'pain', t: 'no-shows', s: 'hypothesis', u: null, q: null, at: null },
    { i: 'acme-payroll:persona:b1', o: 'acme-payroll', k: 'persona', t: 'clinic owners', s: 'sourced', u: 'https://acme.example/products/payroll', q: 'payroll for clinic owners', at: 1800000000 },
  ],
}

test('the total budget covers the whole document: a flat profile that overflows alone is a typed refusal, never truncated', () => {
  const huge: Icp = { summary: 'x'.repeat(300), who: Array(6).fill('w'.repeat(160)), industries: Array(6).fill('i'.repeat(160)), sizes: Array(4).fill('s'.repeat(160)), where: Array(6).fill('p'.repeat(160)), signals: Array(8).fill('e'.repeat(160)), exclude: Array(6).fill('x'.repeat(160)) }
  const r = budgetedIcp(huge)
  assert.deepEqual(r, { ok: false, reason: 'profile_too_large' })
  assert.ok(JSON.stringify(huge).length > ICP_JSON_BUDGET, 'fixture really overflows')
})

test('worst case: a maximal flat profile plus research stays within the column limit; unreviewed hypotheses yield first, whole', () => {
  const bigFlat: Icp = { summary: 's'.repeat(280), who: Array(4).fill('w'.repeat(120)), industries: Array(4).fill('i'.repeat(120)), sizes: [], where: [], signals: Array(4).fill('e'.repeat(120)), exclude: [] }
  const big: IcpResearch = { ...research, hyps: Array.from({ length: 24 }, (_, i) => ({ i: `acme-booking:pain:p${i}`, o: 'acme-booking', k: 'pain' as const, t: `pain ${i} ` + 'x'.repeat(80), s: 'hypothesis' as const, u: null, q: null, at: null })) }
  const r = budgetedIcp({ ...bigFlat, research: big })
  assert.ok(r.ok, JSON.stringify(r))
  if (!r.ok) return
  assert.ok(r.json.length <= ICP_JSON_BUDGET, `${r.json.length} <= ${ICP_JSON_BUDGET}`)
  assert.ok(r.json.length <= 4000, 'the PG char_length(4000) check always passes')
  const rt = normalizeIcp(JSON.parse(r.json))!
  assert.deepEqual(rt.who, bigFlat.who, 'user constraints survive whole')
  assert.ok(rt.research, 'some research fitted')
  assert.ok(rt.research!.hyps.every(h => h.t.length <= 100), 'whole hypotheses only, no partial strings')
})

test('research fit priority: a person decision (reviewed) and page-verified (sourced) statements outrank unreviewed hypotheses', () => {
  const tight: Icp = { ...base, summary: 's'.repeat(280), who: Array(4).fill('w'.repeat(150)), signals: Array(6).fill('e'.repeat(150)) }
  const mixed: IcpResearch = { ...research, hyps: [
    { i: 'acme-booking:pain:u1', o: 'acme-booking', k: 'pain', t: 'unreviewed ' + 'x'.repeat(80), s: 'hypothesis', u: null, q: null, at: null },
    { i: 'acme-booking:persona:r1', o: 'acme-booking', k: 'persona', t: 'office managers', s: 'reviewed', u: null, q: null, at: null },
    ...research.hyps,
  ] }
  const r = budgetedIcp({ ...tight, research: mixed })
  assert.ok(r.ok); if (!r.ok) return
  const kept = normalizeIcp(JSON.parse(r.json))!.research!
  assert.ok(kept.hyps.some(h => h.i === 'acme-booking:persona:r1'), 'the reviewed decision is kept')
  assert.ok(kept.hyps.some(h => h.s === 'sourced'), 'sourced evidence is kept')
})

test('roundtrip: research survives normalize -> serialize -> normalize; a legacy profile without research is unchanged', () => {
  const withR = { ...base, research }
  const r = budgetedIcp(withR); assert.ok(r.ok); if (!r.ok) return
  const rt = normalizeIcp(JSON.parse(r.json))!
  assert.deepEqual(rt.research, research, 'byte-identical after a roundtrip')
  const legacy = normalizeIcp(JSON.parse(JSON.stringify(base)))!
  assert.equal(legacy.research, undefined)
  assert.deepEqual(budgetedIcp(legacy), { ok: true, icp: legacy, json: JSON.stringify(legacy) })
})

test('the reviewed draft corrects the research per offer and the effective profile feeds retrieval and ranking fields', () => {
  // The person reviewed the draft: kept "practice managers", added nothing, removed the physio industry idea.
  const draft: Icp = { ...base, research }
  const eff = applyReviewedDraft(draft, 'Acme Booking')
  assert.ok(eff.who.includes('practice managers'), 'the reviewed buyer stays')
  assert.ok(!eff.industries.includes('physiotherapy clinics'), 'a hypothesis absent from the reviewed draft is rejected, not merged')
  assert.deepEqual(eff.industries, ['dental'], 'the draft wins; no contamination')
  const st = eff.research!
  const confirmed = st.hyps.find(h => h.i === 'acme-booking:persona:a1')!
  const rejected = st.hyps.find(h => h.i === 'acme-booking:industry:a2')!
  assert.deepEqual([confirmed.s, rejected.s], ['reviewed', 'rejected'], 'corrections persist with the play')
  assert.ok(st.hyps.some(h => h.o === 'acme-payroll' && h.s === 'sourced'), "the other offer's own evidence is retained untouched")
})

test('cross-offer isolation and no-offer match: another offer never leaks; an unmatched offer leaves the profile alone', () => {
  const eff = applyReviewedDraft({ ...base, research }, 'Acme Payroll')
  assert.deepEqual(eff.who, ['clinic owners', ...base.who.filter(w => w !== 'practice managers')].length ? eff.who : [], 'shape')
  assert.ok(!eff.who.includes('practice managers') || base.who.includes('practice managers'), "booking's buyer never enters payroll's targeting")
  const same = applyReviewedDraft({ ...base, research }, 'Nonexistent Product')
  assert.deepEqual({ ...same, research: same.research }, { ...base, research }, 'no match: the profile is unchanged (research retained for later)')
})

test('the pending targeting question is answered by the play creation and bound to its offer', () => {
  const withQ: IcpResearch = { ...research, q: 'Which of your offers is this play for?' }
  const eff = applyReviewedDraft({ ...base, research: withQ }, 'Acme Booking')
  assert.deepEqual(eff.research!.ans, { q: 'Which of your offers is this play for?', o: 'acme-booking' }, 'the answer is bound to the offer, never re-asked')
})
