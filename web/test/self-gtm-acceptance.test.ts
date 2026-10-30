import test from 'node:test'
import assert from 'node:assert/strict'
import { runAcceptance, type AcceptanceFixture, type Candidate } from '../lib/gtm/acceptance.ts'
import { LAUNCH_POLICY_VERSION } from '../lib/outreach/launch-policy.ts'
import { DAY, type LifecycleEvent } from '../lib/gtm/lifecycle.ts'
import { RETENTION } from '../lib/growth/retention.ts'

// #407 stage A: dazl -> dazl over a synthetic fixture. Every prospect, contact, reply and payment below is made up
// (.test domains); nothing calls a provider, a mailbox or Stripe, and none of it is live traction.
const T0 = Date.UTC(2026, 6, 1)
const NOW = T0 + 200 * DAY
const day = (d: number) => new Date(NOW - d * DAY).toISOString().slice(0, 10)

let n = 0
const cand = (company: string, title: string, quote: string, over: Partial<Candidate['lead']> = {}, extra: Partial<Candidate> = {}): Candidate => {
  const slug = company.toLowerCase().replace(/[^a-z]+/g, '')
  return {
    lead: {
      id: `lead-${++n}`, company, signal: title, source_url: `https://forum.test/t/${n}`, evidence_excerpt: quote,
      event_date: day(10), date_status: 'verified', review_reason: null, quarantined_at: null, evidence_purged_at: null,
      confidence: 80, score: 100 - n, ...over,
    },
    title, quote, requirements: ['Gmail'], contact: `founder@${slug}.test`, ...extra,
  }
}

const CANDIDATES: Candidate[] = [
  cand('Clinic Scheduling Co', 'Where do you find B2B leads for a small SaaS?', 'Founder here, we sell scheduling software to clinics and need more customers. Any lead sources you trust?', {}, { requirements: ['Gmail', 'HubSpot'] }),
  cand('Northside Agency', 'How do agencies get clients without referrals?', 'We run a small marketing agency. Referrals dried up, how do we find new clients with outbound?'),
  cand('Bounce Fix Ltd', 'Our contact data bounces like crazy, alternatives to our provider?', 'Bounce rate is 18% on our cold email. Which data provider do you use?', {}, { requirements: ['Gmail', 'Pipedrive'] }),
  // a buyer, but the event date is not verified: qualifies, never reaches the preview
  cand('Unverified Date Inc', 'We built an MVP, how do we land our first customers?', 'We built a CRM add-on for plumbers. How do we get customers beyond friends?', { date_status: 'unverified' }),
  // a buyer whose stated requirement is not built: waitlisted, never promised
  cand('Outlook Shop', 'Need more B2B customers, what do you use for leads?', 'We sell IT support to dentists and need more customers, we send from Outlook only.', {}, { requirements: ['Outlook'] }),
  // negative sources: not buyers
  cand('Job Seeker', 'HELPPPP What organizations should I cold email?', "I've given up on internships so now I'm cold emailing labs for a role. Here's my resume."),
  cand('AI SDR Vendor', 'We just launched our AI SDR - check out our tool!', 'It writes cold emails for you. DM me for a demo.'),
]

// each paid invoice carries the monthly service period it bought, as billing reports it
const pay = (c: string, d: number, status = 'paid') => ({ id: `${c}-pay-${d}-${status}`, at: T0 + d * DAY, customer: c, kind: 'payment', status, periods: [{ start: T0 + d * DAY, end: T0 + (d + 30) * DAY, subscription: `sub_${c}` }] }) as LifecycleEvent
const EVENTS: LifecycleEvent[] = [
  { id: 'a-touch', at: T0, customer: 'a', kind: 'touch', channel: 'email', identity: 'founder@clinicschedulingco.test' },
  { id: 'a-signup', at: T0 + DAY, customer: 'a', kind: 'signup', viaTaggedLink: true, consented: true, identity: 'founder@clinicschedulingco.test' },
  { id: 'a-run', at: T0 + 2 * DAY, customer: 'a', kind: 'run', status: 'done', usableLeads: 4 },
  ...[3, 33, 63, 93, 123, 153, 183].map(d => pay('a', d)),
  { id: 'a-cost', at: T0 + 2 * DAY, customer: 'a', kind: 'cost', usd: 3, what: 'research' },
  { id: 'b-signup', at: T0 + 2 * DAY, customer: 'b', kind: 'signup', viaTaggedLink: false, consented: false, identity: 'owner@northsideagency.test' },
  { id: 'b-run', at: T0 + 3 * DAY, customer: 'b', kind: 'run', status: 'done', usableLeads: 0 },
  { id: 'c-signup', at: T0 + 4 * DAY, customer: 'c', kind: 'signup', viaTaggedLink: false, consented: false, identity: null },
  { id: 'fake-signup', at: T0 + DAY, customer: 'fake', kind: 'signup', viaTaggedLink: true, consented: true, identity: null },
  { id: 'fake-run', at: T0 + 2 * DAY, customer: 'fake', kind: 'run', status: 'done', usableLeads: 9 },
]

const thread = { authenticatedSender: true, takenOver: false, handledMessageIds: ['m-old'], autoReplies: 0 }
const fixture = (over: Partial<AcceptanceFixture> = {}): AcceptanceFixture => ({
  site: { url: 'https://dazl.ai', offer: 'Finds companies publicly asking for what you sell, with the quote and source.', copy: 'dazl finds buyers who are asking for what you sell. Pro is $49 per month; model usage runs on your own AI key.' },
  run: { jobId: 'run-self-1', tenantId: 'tenant-dazl', status: 'done', finishedAt: NOW - DAY, spendUsd: 1.2 },
  candidates: CANDIDATES,
  policy: {
    version: LAUNCH_POLICY_VERSION, sender: 'founder@dazl.test', audience: { playIds: ['founder-led-b2b', 'agencies', 'outbound-teams'] },
    exclusions: { domains: ['existingcustomer.test'], emails: [] }, dailyCap: 10, spendCapUsd: 20,
    claims: { mayStatePrice: true, benchmarkUrls: [] }, stops: { pauseOnAnyReply: true, maxBounceRate: 0.05 }, testInbox: 'qa@dazl.test',
  },
  launch: { acceptedVersion: LAUNCH_POLICY_VERSION, connectedMailbox: 'founder@dazl.test', testInboxDelivered: true, stopsEnforced: { reply: true, optOut: true, bounce: true, uncertainPause: true, domainCap: true } },
  answerPolicy: { cta: 'signup', maxAutoReplies: 2 },
  inbound: [
    { inbound: { messageId: 'm1', text: 'Thanks - how much does this cost per month?' }, thread },
    { inbound: { messageId: 'm2', text: 'Can I get 50% off for the first year?' }, thread },
    { inbound: { messageId: 'm3', text: 'Does it integrate with Salesforce?' }, thread },
    { inbound: { messageId: 'm4', text: 'Please remove me from your list.' }, thread },
    { inbound: { messageId: 'm-old', text: 'how much does it cost?' }, thread },
  ],
  lifecycle: { events: EVENTS, meta: [{ customer: 'fake', synthetic: true, staging: false }], cohortStart: T0, cohortEnd: T0 + 30 * DAY },
  ...over,
})

test('dazl -> dazl end to end: every step passes and hands the next one only what it kept', () => {
  const r = runAcceptance(fixture(), NOW)
  assert.deepEqual(r.holds, [])
  assert.equal(r.website.ok, true)

  // qualify: buyers kept; job seeker and vendor screened by who is asking; an unbuilt requirement is waitlisted
  assert.deepEqual(r.qualify.kept, ['lead-1', 'lead-2', 'lead-3', 'lead-4'])
  assert.deepEqual(r.qualify.screened, [{ leadId: 'lead-5', reason: 'waitlist' }, { leadId: 'lead-6', reason: 'job_seeker' }, { leadId: 'lead-7', reason: 'vendor_promo' }])

  // preview: only verified buyers from the run, inferred offer labelled, no contact details
  assert.equal(r.preview.status, 'ready')
  if (r.preview.status !== 'ready') return
  assert.deepEqual(r.preview.companies.map(c => c.company), ['Clinic Scheduling Co', 'Northside Agency', 'Bounce Fix Ltd'])
  assert.equal(r.preview.offer.inferred, true)
  assert.ok(!JSON.stringify(r.preview).includes('@'))

  // preflight: the drafts built from the preview pass the policy, with the price and its cost disclosure
  assert.deepEqual(r.preflight, { ok: true, failures: [], heldLeads: [] })

  // answers: routine question answered from facts with no unsupported claim; everything else is not answered
  assert.deepEqual(r.answers.map(a => a.decision.action), ['reply', 'escalate', 'escalate', 'suppress', 'ignore'])
  const [price, discount, crm] = r.answers.map(a => a.decision)
  assert.ok(price.action === 'reply' && price.body.includes('$49 per month') && price.body.includes('your own AI key') && price.factsVersion === r.truthVersion)
  assert.ok(discount.action === 'escalate' && discount.reason === 'authority')
  assert.ok(crm.action === 'escalate' && crm.reason === 'unknown_integration')
  assert.ok(r.answers.every(a => a.issues.length === 0))

  // lifecycle: activation by delivered value, direct attribution only with a consented tagged link, the synthetic
  // tenant excluded, day-30 retention and coverage from the shared helper, each over its own cohort
  const l = r.lifecycle
  assert.equal(l.customers, 3)
  assert.equal(l.excluded, 1)
  assert.deepEqual(l.byStage, { retained: 1, zero_result: 1, abandoned_setup: 1 })
  assert.deepEqual(l.byAttribution, { direct: 1, assisted: 0, unknown: 2 })
  assert.equal(l.activationRate, 1 / 3)
  assert.deepEqual([l.retention.eligible, l.retention.retained, l.retention.rate, l.retention.label], [1, 1, 1, RETENTION.labels.day30])
  assert.deepEqual([l.coverage.covered, l.coverage.not_covered, l.coverage.unknown, l.coverage.cohort_size, l.coverage.label], [1, 0, 0, 1, RETENTION.labels.coverage])
})

test('the path holds at the step that fails, and later steps get nothing to work with', () => {
  // copy promising an unbuilt channel holds at the website step
  const copy = runAcceptance(fixture({ site: { ...fixture().site, copy: 'dazl sends your outreach by SMS and WhatsApp.' } }), NOW)
  assert.ok(copy.holds.includes('website'))
  assert.deepEqual(copy.website.issues.map(i => i.kind), ['unavailable_capability', 'unavailable_capability'])

  // only non-buyers: nothing qualifies, so there is no preview and no preflight
  const none = runAcceptance(fixture({ candidates: CANDIDATES.slice(4) }), NOW)
  assert.deepEqual(none.holds, ['qualify', 'preview'])
  assert.equal(none.preflight, null)

  // an unfinished run never becomes proof
  const running = runAcceptance(fixture({ run: { ...fixture().run, status: 'running' } }), NOW)
  assert.ok(running.preview.status === 'hold' && running.preview.reason === 'run_not_finished')
  assert.ok(running.holds.includes('preview'))

  // an excluded customer's domain and a missing contact hold their drafts and the launch
  const cands = CANDIDATES.map((c, i) => i === 0 ? { ...c, contact: 'founder@existingcustomer.test' } : i === 1 ? { ...c, contact: null } : c)
  const held = runAcceptance(fixture({ candidates: cands }), NOW)
  assert.ok(held.holds.includes('preflight'))
  assert.deepEqual(held.preflight?.heldLeads, ['lead-1', 'lead-2'])
  assert.ok(held.preflight?.failures.includes('sample_excluded') && held.preflight?.failures.includes('sample_contact'))

  // an unaccepted launch policy holds every send
  const unaccepted = runAcceptance(fixture({ launch: { ...fixture().launch, acceptedVersion: null } }), NOW)
  assert.ok(unaccepted.preflight?.failures.includes('policy_not_accepted'))
})

test('deterministic: the same fixture gives the same result', () => {
  assert.deepEqual(runAcceptance(fixture(), NOW), runAcceptance(fixture(), NOW))
})
