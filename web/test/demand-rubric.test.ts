// lib/qualify/demand.ts (#401): who is asking, what demand they show, and how sure, on SYNTHETIC posts only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessDemand, rubricFor, LEAD_GENERATION, type DemandInput } from '../lib/qualify/demand.ts'

const src = { source_url: 'https://forum.example/t/1', date: '2026-10-20' }
const post = (title: string, quote: string, author: DemandInput['author'] = { name: 'Sam Rivera', headline: 'Founder at Northwind Analytics' }): DemandInput => ({ title, quote, ...src, author })
const R = LEAD_GENERATION

test('the issue\'s fixtures: a founder asking for B2B leads qualifies; job seeker, recruiter, vendor, consumer and funding news cannot be high intent', () => {
  const founder = assessDemand(post('Where can I find B2B leads for my SaaS?', 'I am the founder of a 10-person analytics startup and we need a reliable lead source for outbound; any recommendations for a data provider?'), R)
  assert.equal(founder.verdict, 'high_intent'); assert.ok(founder.categories.includes('vendor_request'))
  assert.deepEqual(founder.scores, { evidence: 3, fit: 3, intent: 3 }); assert.equal(founder.requester.authority, 'decision_maker')
  for (const [title, quote, role] of [
    ['Looking for a sales internship', 'Student here, graduating in May. Any leads on internships at B2B startups? Happy to share my resume.', 'job_seeker'],
    ['We are hiring SDRs', 'We are hiring for an SDR role, DM me your CV if you have outbound experience and want to build pipeline.', 'recruiter'],
    ['We built the best lead gen tool', 'We just launched LeadRocket, check out our tool, it finds verified leads in seconds. DM me for a demo.', 'vendor_promo'],
    ['Need a plumber near me', 'Looking for a reliable plumber near me for my kitchen, any leads?', 'consumer'],
    ['Acme raised a $20M Series B', 'Acme announced today it raised a $20M Series B to expand its sales team.', 'announcement'],
  ] as const) {
    const a = assessDemand(post(title, quote, { name: 'Alex Kim', headline: '' }), R)
    assert.notEqual(a.verdict, 'high_intent', role); assert.equal(a.verdict, 'not_demand', role)
    assert.equal(a.requester.role, role, title); assert.equal(a.scores.intent, 0); assert.equal(a.scores.fit, 0)
  }
})

test('agencies and sales-tool companies stay eligible when they ask for a buying use case; self-promotion without an ask does not', () => {
  const agency = assessDemand(post('How do we find more clients for our agency?', 'We run a small B2B marketing agency. Our pipeline is thin and manual prospecting takes hours of research every week. What do you use to find leads?', { name: 'Priya N', headline: 'Owner, Brightline Agency' }), R)
  assert.equal(agency.requester.role, null); assert.ok(agency.categories.includes('workflow_bottleneck') && agency.categories.includes('data_quality'))
  assert.equal(agency.verdict, 'high_intent')
  const switching = assessDemand(post('Alternatives to Apollo?', 'Our bounce rate on Apollo lists is 30%. Switching from Apollo; which one should I use?', { name: 'Jo', headline: 'Head of Sales at Fernway' }), R)
  assert.ok(switching.categories.includes('evaluation')); assert.equal(switching.verdict, 'high_intent')
})

test('weak triggers alone are not demand; a mentioned customer is not the requester; missing provenance lowers evidence', () => {
  const growth = assessDemand(post('We just closed our seed round', 'Excited to share we closed a seed round and are hiring SDRs to grow the team.'), R)
  assert.equal(growth.weak_triggers, true); assert.deepEqual(growth.categories, []); assert.equal(growth.verdict, 'not_demand')
  assert.match(growth.reasons.join('; '), /only a contextual trigger/)
  // the text names a company (a customer), but the requester is the post's author, never that company
  const named = assessDemand(post('Our customer Globex needs more leads', 'Globex, one of our customers, says their lead lists are garbage. Any recommendations for a lead list provider?', { name: null, headline: null }), R)
  assert.equal(named.requester.name, null, 'the author is unknown; Globex is not made the requester')
  assert.equal(named.scores.evidence, 2); assert.match(named.reasons.join(), /author not named/)
  const undated = assessDemand({ title: 'Need B2B leads?', quote: 'Any recommendations for a lead source for my startup?' }, R)
  assert.equal(undated.scores.evidence, 0); assert.notEqual(undated.verdict, 'high_intent', 'no link, date or author: never high intent')
})

test('a comparison or evaluation request is never permission to contact', () => {
  for (const q of ['Alternatives to ZoomInfo? Which one should I use for my startup?', 'Where can I find B2B leads for my company?'])
    assert.equal(assessDemand(post('Question', q), R).contact_permitted, false)
})

test('the rubric comes from the tenant\'s own offer, the same rule for every tenant; no rubric means no demand claim', () => {
  assert.equal(rubricFor('We help B2B teams find leads and prospects with evidence'), LEAD_GENERATION)
  assert.equal(rubricFor('Evidence-backed lead research for founders'), LEAD_GENERATION)
  assert.equal(rubricFor('Dental implants and cleanings in Toronto'), null)
  const none = assessDemand(post('Where can I find B2B leads?', 'Any recommendations for a lead source?'), null)
  assert.equal(none.rubric, null); assert.equal(none.verdict, 'not_demand'); assert.match(none.reasons.join(), /no demand rubric/)
})

test('screening before paid grading: only non-buyers and trigger-only posts are dropped; an unrecognised post still goes to grading', () => {
  assert.equal(assessDemand(post('Seed round closed', 'We closed a seed round and are hiring SDRs.'), R).screen_out, true)
  assert.equal(assessDemand(post('Internship?', 'Student looking for an internship, here is my resume.'), R).screen_out, true)
  const unknown = assessDemand(post('Thoughts on our onboarding emails?', 'Curious how others structure the first week of onboarding for new users.'), R)
  assert.equal(unknown.verdict, 'not_demand'); assert.equal(unknown.screen_out, false, 'not recognised is not proof of no demand')
  const deliver = assessDemand(post('too many filters that automatically reject emails ?', "how are you dealing with all the spam filters that make our cold emails dead on arrival? I'm supposed to be scaling the cold email program at my company"), R)
  assert.ok(deliver.categories.includes('workflow_bottleneck')); assert.equal(deliver.screen_out, false)
})

test('a question that only mentions funding or growth stays at weak intent; an unknown asker with no business context is only possible', () => {
  const growthQ = assessDemand(post('We just raised funding and are scaling fast', 'Any tips on onboarding new hires quickly?'), R)
  assert.equal(growthQ.requester.role, null, 'a question, not an announcement'); assert.deepEqual(growthQ.categories, [])
  assert.equal(growthQ.scores.intent, 1); assert.equal(growthQ.verdict, 'not_demand'); assert.equal(growthQ.screen_out, true)
  const anon = assessDemand(post('Where can I find B2B leads?', 'Any recommendations for a lead source?', { name: 'Kai', headline: '' }), R)
  assert.equal(anon.requester.authority, 'unknown'); assert.equal(anon.requester.business_asker, false)
  assert.equal(anon.scores.fit, 0); assert.equal(anon.verdict, 'possible', 'demand shown, but not who could buy: never high intent')
  const sdr = assessDemand(post('Where can I find B2B leads?', 'Any recommendations for a lead source for our team?', { name: 'Kai', headline: 'SDR at Fernway' }), R)
  assert.equal(sdr.requester.authority, 'practitioner'); assert.equal(sdr.scores.fit, 2)
})
