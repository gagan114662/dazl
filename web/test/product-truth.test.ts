import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { productTruth, BENCHMARKS, type ProductTruth } from '../lib/product-truth.ts'
import { CHANNELS } from '../lib/channels.ts'
import { CRM_PROVIDERS } from '../lib/crm/index.ts'
import { VENDORS } from '../lib/llm/vendors.ts'
import { PLAN_LIMITS, PLAN_PRICE_USD_MONTHLY, PRICE_DISCLOSURE } from '../lib/plans.ts'
import { productFactsFromTruth, qualifyProspect, truthClaimIssues } from '../lib/outreach/capability-claims.ts'
import { acceptLaunchPolicy, claimIssuesFor, LAUNCH_POLICY_VERSION, migrateLaunchPolicy, parsePolicy, policyProblems, type LaunchPolicy } from '../lib/outreach/launch-policy.ts'
import { decide } from '../lib/replies/buyer-answers.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { saveSettings, createDraft } from '../lib/outreach/service.ts'
import { polishDraft } from '../lib/outreach/draft-llm.ts'
import { migrateMemory, saveMemory } from '../lib/memory.ts'
import type { Provider } from '../lib/llm/provider.ts'

// #402: the product truth record is built from code and flags; claims and prospect fit are checked against it.
// Synthetic env, tenants and leads only; every model call is a stub.
const OFF: Record<string, string | undefined> = {}
const truth = productTruth(OFF)
const cap = (t: ProductTruth, id: string) => t.capabilities.find(c => c.id === id)

test('the record is derived from the code registries and flags, and its version follows them', () => {
  for (const c of CHANNELS) assert.equal(cap(truth, `source:${c.id}`)?.state, c.status === 'live' ? 'available' : c.status === 'worker' ? 'limited' : 'unavailable', c.id)
  for (const p of CRM_PROVIDERS) assert.equal(cap(truth, `crm:${p}`)?.state, 'available', p)
  for (const v of VENDORS) assert.deepEqual([cap(truth, `model:${v}`)?.state, cap(truth, `model:${v}`)?.requires], ['available', ['own_key']], v)
  assert.equal(cap(truth, 'channel:gmail')?.state, 'available')
  for (const id of ['channel:outlook', 'channel:linkedin_messaging', 'channel:sms', 'channel:whatsapp', 'crm:salesforce', 'feature:api_mcp']) assert.equal(cap(truth, id)?.state, 'unavailable', id)
  assert.deepEqual(truth.pricing.plans, (Object.keys(PLAN_LIMITS) as (keyof typeof PLAN_LIMITS)[]).map(id => ({ id, monthlyUsd: PLAN_PRICE_USD_MONTHLY[id], scansPerMonth: PLAN_LIMITS[id].scansPerMonth })))
  assert.equal(truth.pricing.disclosure, PRICE_DISCLOSURE)
  assert.deepEqual([truth.pricing.ownAiKeyRequired, truth.pricing.providerCostSeparate, truth.benchmarks], [true, true, BENCHMARKS])
  assert.equal(BENCHMARKS.length, 0, 'no benchmark has been published (#372 never run)')
  // the same code and env give the same version; a flag that changes what ships gives a new one
  assert.equal(productTruth(OFF).version, truth.version)
  assert.match(truth.version, /^pt-[0-9a-f]{16}$/)
  const trialOn = productTruth({ TINYFISH_API_KEY: 'k', DAZL_TRIAL_SCAN_RESERVE_USD: '0.5', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '2', DAZL_TRIAL_GLOBAL_DAILY_USD: '10', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0', DAZL_TRIAL_TINYFISH_FETCH_USD: '0' })
  assert.equal(cap(truth, 'feature:trial_scans')?.state, 'unavailable')
  assert.equal(cap(trialOn, 'feature:trial_scans')?.state, 'available')
  assert.notEqual(trialOn.version, truth.version)
  assert.equal(productTruth({ STRIPE_SECRET_KEY: 'sk', STRIPE_PRICE_PRO: 'price_1' }).pricing.checkoutAvailable, true)
  assert.equal(truth.pricing.checkoutAvailable, false)
})

test('a claim of an unavailable sender, channel or integration is refused; a shipped one or a disclosed limitation passes', () => {
  const issues = (t: string) => truthClaimIssues(t, truth)
  assert.deepEqual(issues('dazl sends from your Outlook inbox.'), ['capability_unavailable:channel:outlook'])
  assert.deepEqual(issues('It runs LinkedIn outreach for you.'), ['capability_limited:source:linkedin', 'capability_unavailable:channel:linkedin_messaging'])
  assert.deepEqual(issues('Leads sync to Salesforce.'), ['capability_unavailable:crm:salesforce'])
  assert.deepEqual(issues('We also do SMS and WhatsApp follow-ups.'), ['capability_unavailable:channel:sms', 'capability_unavailable:channel:whatsapp'])
  assert.deepEqual(issues('Email goes from your own Gmail and leads go to HubSpot or Pipedrive.'), [])
  assert.deepEqual(issues('Email goes from your own Gmail; there is no LinkedIn messaging or SMS.'), [], 'a negated mention is a disclosed limitation')
  // the lead's own quoted words and links are not the seller's claims
  assert.deepEqual(issues('Saved excerpt from this public page: "We use Salesforce and LinkedIn Sales Navigator"\nhttps://acme.example/salesforce'), [])
  // own-key enrichment needs its prerequisite stated; the operator worker cannot be promised at all
  assert.deepEqual(issues('Contacts are enriched with Apollo.'), ['capability_limited:enrichment:apollo'])
  assert.deepEqual(issues('Contacts can be enriched with Apollo on your own Apollo key.'), [])
  assert.deepEqual(issues('We read Reddit threads for you.'), ['capability_limited:source:reddit'])
  // a person named Claude is not a model claim
  assert.deepEqual(issues('Hi Claude, saw the posting.'), [])
})

test('prices must be published ones with the own-key and provider-cost disclosure; comparisons need a published benchmark', () => {
  const issues = (t: string, o = {}) => truthClaimIssues(t, truth, o)
  assert.deepEqual(issues(`Pro is $49 a month. ${PRICE_DISCLOSURE}`), [])
  assert.deepEqual(issues('Pro is $49 a month.'), ['byok_not_disclosed'])
  assert.deepEqual(issues(`Pro is $39 a month. ${PRICE_DISCLOSURE}`), ['price_not_in_truth'])
  assert.deepEqual(issues('Our pricing is simple and flat.'), ['byok_not_disclosed'])
  assert.deepEqual(issues('dazl finds more qualified leads than Gojiberry.'), ['comparative_unbenchmarked:gojiberry'])
  assert.deepEqual(issues('Better than ChatGPT or Pancake at finding buyers.'), ['comparative_unbenchmarked:pancake', 'comparative_unbenchmarked:chatgpt'])
  assert.deepEqual(issues('Guaranteed meetings, 10x more replies.'), ['unbacked_superlative'])
  // the owner listing a URL is not enough: the benchmark must be published in the record, cover that competitor, and be linked
  const url = 'https://dazl.example/benchmarks/2026-11'
  assert.deepEqual(issues(`Beats Gojiberry: ${url}`, { benchmarkUrls: [url] }), ['comparative_unbenchmarked:gojiberry'])
  const benched: ProductTruth = { ...truth, benchmarks: [{ url, competitors: ['gojiberry'], scope: 'precision@10, 5 synthetic plays', measuredAt: '2026-11-01' }] }
  assert.deepEqual(truthClaimIssues(`Beats Gojiberry on precision@10: ${url}`, benched, { benchmarkUrls: [url] }), [])
  assert.deepEqual(truthClaimIssues(`Beats Gojiberry on precision@10: ${url}`, benched, { benchmarkUrls: [] }), ['comparative_unbenchmarked:gojiberry'])
  assert.deepEqual(truthClaimIssues(`Beats Pancake: ${url}`, benched, { benchmarkUrls: [url] }), ['comparative_unbenchmarked:pancake'], 'the benchmark covers its own competitors only')
})

test('a changed record invalidates copy that relies on it, and only that copy', () => {
  const stale = { acceptedVersion: 'pt-0000000000000000' }
  assert.deepEqual(truthClaimIssues('Email goes from your own Gmail.', truth, stale), ['product_truth_changed'])
  assert.deepEqual(truthClaimIssues('Saw the posting about your second clinic. Worth a short call?', truth, stale), [])
  assert.deepEqual(truthClaimIssues('Email goes from your own Gmail.', truth, { acceptedVersion: truth.version }), [])
})

test('a prospect who needs an unshipped capability is no-fit or waitlist; a job-ad requirement is not their need', () => {
  assert.deepEqual(qualifyProspect('We need a tool that sends from Outlook.', truth), { verdict: 'no_fit', unmet: ['channel:outlook'] })
  assert.deepEqual(qualifyProspect('Our team is looking for LinkedIn lead data.', truth), { verdict: 'waitlist', unmet: ['source:linkedin'] })
  assert.deepEqual(qualifyProspect('Salesforce integration is a must.', truth), { verdict: 'no_fit', unmet: ['crm:salesforce'] })
  assert.deepEqual(qualifyProspect('We need leads pushed to HubSpot.', truth), { verdict: 'fit', unmet: [] })
  assert.deepEqual(qualifyProspect('Hiring an SDR: 2+ years of experience with Salesforce and Outreach required.', truth), { verdict: 'fit', unmet: [] })
  assert.deepEqual(qualifyProspect('Acme uses Salesforce.', truth), { verdict: 'fit', unmet: [] }, 'a mention is not a requirement')
})

const policy = (over: Partial<LaunchPolicy['claims']> = {}): LaunchPolicy => parsePolicy({
  version: LAUNCH_POLICY_VERSION, sender: 'founder@seller.example', audience: { playIds: ['play-1'] }, exclusions: { domains: [], emails: [] },
  dailyCap: 20, spendCapUsd: 25, claims: { mayStatePrice: true, benchmarkUrls: [], ...over }, stops: { pauseOnAnyReply: true, maxBounceRate: 0.05 },
  testInbox: 'founder@seller.example',
})

test('the launch policy binds the record by version: owner-accepted, current only, applied to every draft check', () => {
  const current = productTruth().version
  const bound = policy({ productTruthVersion: current })
  assert.equal(bound.claims.productTruthVersion, current)
  assert.equal('productTruthVersion' in policy().claims, false, 'unset stays unset: an unbound policy is unchanged')
  assert.deepEqual(policyProblems(policy({ productTruthVersion: 'v1' })), ['product_truth_invalid'])
  const db = new Database(':memory:'); migrateLaunchPolicy(db)
  assert.deepEqual(acceptLaunchPolicy(db, 'A', policy({ productTruthVersion: 'pt-0000000000000000' }), 1), { ok: false, problems: ['product_truth_not_current'] })
  assert.deepEqual(acceptLaunchPolicy(db, 'A', bound, 1), { ok: true })
  // unbound: the product truth is not applied (another tenant's product has no record here)
  assert.deepEqual(claimIssuesFor(policy(), 'We send from Outlook.'), [])
  assert.deepEqual(claimIssuesFor(bound, 'We send from Outlook.'), ['capability_unavailable:channel:outlook'])
  // the price authority and the product truth both apply
  assert.deepEqual(claimIssuesFor({ ...bound, claims: { ...bound.claims, mayStatePrice: false } }, 'Pro is $49 per month.'), ['price_not_allowed', 'byok_not_disclosed'])
  // the prospect's own words: a stated need for an unshipped sender holds the draft as no-fit
  assert.deepEqual(claimIssuesFor(bound, 'Saw the posting. Worth a short call?', [], 'We need to send from Outlook'), ['prospect_no_fit:channel:outlook'])
  assert.deepEqual(claimIssuesFor(bound, 'Saw the posting. Worth a short call?', [], 'Hiring SDRs'), [])
  // a record that changed since acceptance holds drafts that rely on it
  const stale = { ...bound, claims: { ...bound.claims, productTruthVersion: 'pt-0000000000000000' } }
  assert.deepEqual(claimIssuesFor(stale, 'Email goes from your own Gmail.'), ['product_truth_changed'])
})

test('routine buyer answers come from the record, and a changed record stops them until the owner accepts it', () => {
  const facts = productFactsFromTruth(truth, { signupUrl: 'https://app.example/sign-up', bookingUrl: null })
  assert.equal(facts.version, truth.version)
  assert.deepEqual(facts.knownIntegrations, ['Gmail', 'HubSpot', 'Pipedrive', 'Webhook'])
  assert.match(facts.pricing, /Pro is \$49 a month/)
  assert.ok(facts.pricing.includes(PRICE_DISCLOSURE))
  assert.match(facts.limitations, /Not available: .*Outlook.*LinkedIn messages.*SMS/)
  assert.deepEqual(truthClaimIssues(`${facts.pricing}\n${facts.prerequisites}\n${facts.limitations}`, truth), [], 'the facts never promise what the record does not ship')
  const thread = { authenticatedSender: true, takenOver: false, handledMessageIds: [], autoReplies: 0 }
  const ask = (text: string, accepted?: string) => decide({ messageId: 'm1', text }, thread, facts, { cta: 'signup', maxAutoReplies: 3, ...(accepted ? { acceptedFactsVersion: accepted } : {}) })
  assert.deepEqual(ask('Does it integrate with Salesforce?'), { action: 'escalate', messageId: 'm1', reason: 'unknown_integration', detail: 'Salesforce' })
  assert.deepEqual(ask('Does it send from Outlook?').action, 'escalate')
  assert.equal(ask('Does it work with HubSpot?', truth.version).action, 'reply')
  assert.deepEqual(ask('How much does it cost?', 'pt-0000000000000000'), { action: 'escalate', messageId: 'm1', reason: 'facts_stale' })
})

test('polish under a bound record: the model is told what is not shipped, and an unbacked rewrite is refused', async () => {
  const master = randomBytes(32)
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateOutreach(db); migrateMemory(db); migrateLaunchPolicy(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-' + 'A'.repeat(40), master)
  saveSettings(db, 'A', { sender_name: 'G', postal_address: '1 King St W, Toronto ON, Canada', booking_url: null })
  saveMemory(db, 'A', { positioning: 'lead research with the evidence for each lead' })
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('j1', 'A', 'b', 'i', 'l', 'running')").run()
  for (const id of ['l1', 'l2', 'l3']) db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence, human_confirmed_at, human_confirmed_from) VALUES (?, 'j1', 'Pat', 'Acme', 'pat@acme.example', 'hiring AEs', 'https://n.example/a', 'quote', 80, 1800000000, 'test_review')").run(id)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'j1'").run()
  const prompts: string[] = []
  const stub = (text: string): Record<string, Provider> => ({ anthropic: { research: async () => ({ text: '', citedUrls: [] }), completeDetailed: async (_k: string, p: string) => { prompts.push(p); return { text, model: 'claude-sonnet-4-5', request_id: 'msg_x', usage: { input_tokens: 10, output_tokens: 5 } } } } })
  const outlook = 'Subject: Saw the hiring\n\nHi Pat,\n\nSaw the AE hiring reported. dazl sends your outreach from Outlook and LinkedIn. Worth a short call?\n\nThanks,'
  // unbound tenant: unchanged behaviour (the record is not applied to another product)
  const id1 = createDraft(db, 'A', 'l1', 'Dazl')
  assert.equal((await polishDraft(db, 'A', id1, 'Dazl', { master, providers: stub(outlook) as never })).rewritten, true)
  assert.doesNotMatch(prompts[0], /not available/)
  // bound: refused, template kept, and the prompt named what is not shipped
  assert.deepEqual(acceptLaunchPolicy(db, 'A', { ...policy({ productTruthVersion: productTruth().version }), sender: 'g@seller.example', testInbox: 'g@seller.example' }, 1), { ok: true })
  const id2 = createDraft(db, 'A', 'l2', 'Dazl')
  const before = (db.prepare('SELECT body FROM outreach_messages WHERE id = ?').get(id2) as { body: string }).body
  const r = await polishDraft(db, 'A', id2, 'Dazl', { master, providers: stub(outlook) as never })
  assert.deepEqual([r.rewritten, !r.rewritten && r.reason], [false, 'blocked_claim'])
  assert.equal((db.prepare('SELECT body FROM outreach_messages WHERE id = ?').get(id2) as { body: string }).body, before)
  assert.match(prompts[1], /not available: .*Outlook/)
  // a rewrite inside the record is accepted
  const id3 = createDraft(db, 'A', 'l3', 'Dazl')
  assert.equal((await polishDraft(db, 'A', id3, 'Dazl', { master, providers: stub('Subject: Saw the hiring\n\nHi Pat,\n\nSaw the AE hiring reported. We research leads with the evidence attached. Worth a short call?\n\nThanks,') as never })).rewritten, true)
})
