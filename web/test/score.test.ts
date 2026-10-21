import test from 'node:test'
import assert from 'node:assert/strict'
import { applyIcpGate, icpTextFor, isHidden, parseScores, scorePrompt, SIGNALS, type IcpMatch } from '../lib/scan/score.ts'

const UM: IcpMatch = { role: 'unknown', industry: 'unknown', size: 'unknown', location: 'unknown', note: '' }

test('taxonomy has 15-30 key-free signals, all snake_case ids', () => {
  assert.ok(SIGNALS.length >= 15 && SIGNALS.length <= 30)
  for (const s of SIGNALS) assert.match(s, /^[a-z][a-z0-9_]*$/)
})

test('parseScores: parses one line per lead, clamps to 0-5, keeps known signals only', () => {
  const text = `LEAD 1 | fit 4 | intent 5 | action 3 | signals raised_funding, hiring_relevant_role, made_up | why Just raised seed and hiring first AE
LEAD 2 | fit 9 | intent -2 | action 2 | signals none | why Big incumbent, no trigger`
  const s = parseScores(text, 2)
  assert.ok(s)
  assert.deepEqual(s[0], { fit: 4, intent: 5, action: 3, signals: ['raised_funding', 'hiring_relevant_role'], why: 'Just raised seed and hiring first AE', match: UM })
  assert.deepEqual(s[1], { fit: 5, intent: 0, action: 2, signals: [], why: 'Big incumbent, no trigger', match: UM })
})

test('parseScores: missing lead line fails the whole batch (no unfair ranking)', () => {
  assert.equal(parseScores('LEAD 1 | fit 4 | intent 4 | action 4 | signals hiring | why x', 2), null)
  assert.equal(parseScores('no grades here', 1), null)
})

test('isHidden: fit 0-1 hides, higher fits and unscored stay visible', () => {
  assert.equal(isHidden({ fit: 1, intent: 5, action: 5, why: '', signals: [], match: UM }), true)
  assert.equal(isHidden({ fit: 2, intent: 0, action: 0, why: '', signals: [], match: UM }), false)
  assert.equal(isHidden(null), false)
})

test('scorePrompt: carries the ICP text and every lead with its evidence', () => {
  const p = scorePrompt('ICP: seed startups hiring sales', [
    { company: 'Acme', name: 'Bob', signal: 'hired VP Sales', excerpt: 'Acme hired its first VP Sales' },
    { company: 'Beta', name: '', signal: 'raised seed', excerpt: null },
  ])
  assert.ok(p.includes('ICP: seed startups hiring sales'))
  assert.ok(p.includes('Acme hired its first VP Sales'))
  assert.ok(p.includes('LEAD 2'))
  assert.ok(p.includes('raised_funding'))
})

test('icpTextFor: renders the reviewed ICP, falls back to the raw query', () => {
  const t = icpTextFor({ summary: 'SaaS seller', who: ['VP Sales'], industries: ['SaaS'], sizes: ['1-10'], where: ['London'], signals: ['seed round'], exclude: ['agencies'] }, 'fallback')
  assert.ok(t.includes('SaaS seller') && t.includes('VP Sales') && t.includes('London') && t.includes('agencies'))
  assert.equal(icpTextFor(null, 'fallback'), 'fallback')
})

test('parseScores tolerates colons, commas and prose around the lines', () => {
  const text = `Here are my grades:
LEAD 1: fit 4, intent 5, action 3, signals raised_funding, hiring | why Just raised and hiring
LEAD 2 | fit: 1 | intent: 2 | action: 2 | signals: none | why: Incumbent with no trigger`
  const s = parseScores(text, 2)
  assert.ok(s)
  assert.deepEqual(s[0], { fit: 4, intent: 5, action: 3, signals: ['raised_funding', 'hiring'], why: 'Just raised and hiring', match: UM })
  assert.equal(s[1].fit, 1)
})

test('parseScores: match segment parses; mism reason is kept out of why', () => {
  const text = `LEAD 1 | fit 4 | intent 4 | action 4 | match yy?n | signals hiring | why Good fit, wrong region | mism wrong location: US-only, ICP is London
LEAD 2 | fit 3 | intent 3 | action 3 | match ???? | signals none | why Nothing known`
  const s = parseScores(text, 2)
  assert.ok(s)
  assert.deepEqual(s[0].match, { role: 'match', industry: 'match', size: 'unknown', location: 'mismatch', note: 'wrong location: US-only, ICP is London' })
  assert.equal(s[0].why, 'Good fit, wrong region')
  assert.deepEqual(s[1].match, { role: 'unknown', industry: 'unknown', size: 'unknown', location: 'unknown', note: '' })
})

test('applyIcpGate: mismatch on a specified criterion hides with reason; unknown and open criteria never gate', () => {
  const score = (match: IcpMatch, fit = 4) => ({ fit, intent: 3, action: 3, why: 'solid', signals: [], match })
  const icp = { summary: 'x', who: ['VP Sales'], industries: ['SaaS'], sizes: [], where: ['London'], signals: [], exclude: [] }
  const wrongIndustry = score({ role: 'match', industry: 'mismatch', size: 'unknown', location: 'match', note: 'manufacturing' })
  const allUnknown = score({ role: 'unknown', industry: 'unknown', size: 'unknown', location: 'unknown', note: '' })
  const wrongSizeOnly = score({ role: 'match', industry: 'match', size: 'mismatch', location: 'match', note: 'too big' }) // size not in ICP: never gates
  const out = applyIcpGate([wrongIndustry, allUnknown, wrongSizeOnly], icp)
  assert.equal(out[0].fit, 1)
  assert.ok(out[0].why.includes('ICP mismatch (industry: manufacturing)'))
  assert.equal(out[1].fit, 4)
  assert.equal(out[2].fit, 4)
  // null ICP: no gating at all
  const g = score({ role: 'mismatch', industry: 'mismatch', size: 'mismatch', location: 'mismatch', note: 'x' })
  assert.equal(applyIcpGate([g], null)[0].fit, 4)
})

test('evidence-quality gate: job-posting boilerplate without pain is capped below 50, intent forced to 1', async () => {
  const { applyEvidenceQualityGate } = await import('../lib/scan/score.ts')
  const leads = [
    // the JM Eagle case: generic role-summary quote, no pain language
    { signal: 'Hiring Sales Operations Manager with responsibility for managing CRM systems and process improvement', excerpt: 'SUMMARY A sales operations manager is responsible for overseeing and optimizing the sales processes, tools, and resources within an organization. 5+ years of experience required.', score: 85, intent: 4, why: 'hiring for CRM work' },
    // job posting that DOES show pain: keeps its grade
    { signal: 'Hiring a CRM admin because the team is frustrated with their current CRM and looking to switch', excerpt: 'We are looking for a CRM admin. Responsibilities include migrating away from our clunky legacy CRM.', score: 88, intent: 5, why: 'switching' },
    // non-job-posting evidence: untouched
    { signal: 'Founder post: our CRM is a nightmare, evaluating alternatives', excerpt: 'Honestly our CRM is a nightmare and we are actively evaluating alternatives this quarter.', score: 91, intent: 5, why: 'active pain' },
  ]
  const gated = applyEvidenceQualityGate(leads)
  assert.equal(gated, 1)
  assert.equal(leads[0].score, 49)
  assert.equal(leads[0].intent, 1)
  assert.match(leads[0].why, /job posting/i)
  assert.equal(leads[1].score, 88)
  assert.equal(leads[1].intent, 5)
  assert.equal(leads[2].score, 91)
})

test('evidence-quality gate: marker coverage and never raises intent', async () => {
  const { applyEvidenceQualityGate, readsLikeJobPosting, showsActivePain } = await import('../lib/scan/score.ts')
  for (const t of ['see the Responsibilities section', 'Requirements: 3 years of experience', 'We are looking for a driven SDR', 'What you\'ll do day-to-day', 'About the role: you will own']) {
    assert.ok(readsLikeJobPosting(t), t)
  }
  for (const t of ['announced Series B funding', 'opened a Berlin office', 'launched a new integration']) {
    assert.ok(!readsLikeJobPosting(t), t)
  }
  for (const t of ['frustrated with HubSpot', 'fed up and switching', 'looking for an alternative', 'rip it out', 'too expensive for what it is']) {
    assert.ok(showsActivePain(t), t)
  }
  const low = [{ signal: 'Hiring SDR. Responsibilities include outbound. Requirements: 1 years of experience', excerpt: '', score: 40, intent: 0, why: '' }]
  applyEvidenceQualityGate(low)
  assert.equal(low[0].intent, 0) // gate never raises
  assert.equal(low[0].score, 40) // already below the cap stays
})
