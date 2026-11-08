// #401/#379 buying-need evidence (lib/scan/need-evidence.ts): the persistent writer at a new search's write stage and
// the tenant-scoped reader, on SQLite and Postgres, through the ACTUAL exports (createQueryJob, setCompetitors,
// loadPlayDemandRubric, qualifyDemand, domain-basis, compileTargeting) - never a re-implementation.
//
// OLD -> NEW control: before the writer runs, the reader proves nothing (the old world: no buying-need record exists,
// nothing claimed); after the ordinary write-stage call, a source-bound founder post with a confirmed domain reads
// verified_buying_need, and every adversarial post is excluded or unproven with its named reason.
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Db } from '../lib/db/client.ts'
import { createQueryJob } from '../lib/scan/store-db.ts'
import { setCompetitors } from '../lib/signals/competitor-reddit.ts'
import { setPlayOffer } from '../lib/scan/play-offer.ts'
import { compileTargeting } from '../lib/scan/targeting.ts'
import {
  planNeedSupport, recordNeedEvidence, currentBuyingNeed, needReadContext,
  type DemandArtifact, type NeedRecord,
} from '../lib/scan/need-evidence.ts'
import { bothEngines } from './helpers/engines.ts'

const A = 'a'.repeat(32), B = 'b'.repeat(32)
const AS_OF = new Date('2026-11-03T12:00:00Z')
const NOW = Math.floor(AS_OF.getTime() / 1000)
const OFFER = 'Dazl finds B2B sales leads and builds verified prospect lists for outbound teams'
const QUERY = 'B2B SaaS founders asking for lead sources'

async function tenant(db: Db, id: string, sells: string) {
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt, sells) VALUES (?, ?, 'n', 'Dazl', 'x', 'y', ?)", [id, `${id}@example.test`, sells])
  await db.run('UPDATE users SET website = ? WHERE id = ?', ['https://dazl.ai', id])
}
async function play(db: Db, tenantId: string, query = QUERY, offer: string | null = OFFER, seller: string | null = 'Dazl finds B2B sales leads - https://dazl.ai') {
  const id = await createQueryJob(db, tenantId, { query, icp: null, seller, offer })
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = ? WHERE id = ?", [NOW, id])
  return id
}
async function lead(db: Db, jobId: string, id: string, o: { company: string; domain?: string | null; url?: string; published?: string | null; event_date?: string | null; verified?: boolean }) {
  await db.run(
    `INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, score, confidence, review_reason, published_at, event_date, created_at)
     VALUES (?, ?, '', ?, ?, 'Looking for a lead source', ?, 80, ?, ?, ?, ?, ?)`,
    [id, jobId, o.company, o.domain ?? null, o.url ?? `https://forum.example.test/t/${id}`,
      o.verified === false ? null : 80, o.verified === false ? 'quote_unconfirmed' : null, o.published ?? null, o.event_date ?? null, NOW])
}
// A company domain CONFIRMED the way the crawl confirms it (domain-basis.ts): the cited page is hosted on the domain.
async function confirmDomain(db: Db, tenantId: string, leadId: string, domain: string) {
  await db.run(
    `INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at)
     VALUES (?, ?, ?, 'sitecrawl', 'domain', ?, NULL, NULL, ?, '2026-11-02', ?)`,
    [`dom-${leadId}`, leadId, tenantId, `${domain}|evidence_own_domain`, `https://${domain}/`, NOW])
}
const artifact = (url: string, post: { author: DemandArtifact['author']; text: string; published_at: string | null; title?: string | null }): DemandArtifact => ({ source_url: url, ...post })
const need = (db: Db, tenantId: string, jobId: string, leadId: string) => currentBuyingNeed(db, tenantId, jobId, leadId, { asOf: AS_OF })
const record = (db: Db, tenantId: string, leadId: string) => db.get<NeedRecord>('SELECT * FROM lead_need_evidence WHERE tenant_id = ? AND lead_id = ?', [tenantId, leadId])

// The founding team's real ask (fixture buyer-founder-b2b-leads from the qualifier's labelled set).
const FOUNDER_POST = "I'm the co-founder of a B2B invoicing startup. We need a reliable source of sales leads for mid-size accounting firms. Any recommendations for a lead list provider?"
const FOUNDER_AUTHOR = { name: 'Maya Chen', headline: 'Co-founder, Tallyline', company: 'Tallyline' }

async function basePlay(db: Db, tenantId: string) {
  await tenant(db, tenantId, OFFER)
  assert.equal((await setCompetitors(db, tenantId, ['LeadForge', 'ProspectPilot'])).ok, true)
  return play(db, tenantId)
}

// ---------------------------------------------------------------------------------------------------- plan semantics (pure)
test('planNeedSupport: only an open, unambiguous, positive-AND hiring condition supports the hiring classification', () => {
  assert.deepEqual(planNeedSupport(compileTargeting('companies hiring sales reps in Ohio', null)), { support: 'hiring', conditions: ['C1'] })
  assert.deepEqual(planNeedSupport(compileTargeting('companies that hired their first VP of Sales', null)), { support: 'none', reason: 'completed_hire_not_open_need' })
  assert.deepEqual(planNeedSupport(compileTargeting('companies in Ohio not hiring sales reps', null)), { support: 'none', reason: 'hiring_negated' })
  assert.deepEqual(planNeedSupport(compileTargeting('companies hiring sales reps or that raised seed funding', null)), { support: 'none', reason: 'hiring_one_of_choices' })
  assert.deepEqual(planNeedSupport(compileTargeting('dentists in Ohio', null)), { support: 'none', reason: 'no_plan_conditions' })
  assert.deepEqual(planNeedSupport(compileTargeting('companies hiring sales reps within 30 days of the raise', null)), { support: 'none', reason: 'plan_ambiguous' })
})

// ---------------------------------------------------------------------------------------------------- OLD -> NEW positive control
bothEngines('OLD: no record, nothing claimed. NEW: a source-bound founder post on a confirmed domain verifies buying need', async ({ db }) => {
  const job = await basePlay(db, A)
  await lead(db, job, 'L1', { company: 'Tallyline', domain: 'tallyline.example', published: '2026-10-28' })
  await confirmDomain(db, A, 'L1', 'tallyline.example')

  // OLD behavior: before the write stage ran, there is nothing to read - unproven, never a guess.
  assert.deepEqual(await need(db, A, job, 'L1'), { status: 'unproven', reason: 'buying_need_unproven:no_record' })

  // NEW: the search's write stage records the verdict through the actual writer...
  const url = 'https://forum.example.test/t/L1'
  const s = await recordNeedEvidence(db, A, job, {
    asOf: AS_OF,
    demandArtifacts: [artifact(url, { author: FOUNDER_AUTHOR, text: FOUNDER_POST, published_at: '2026-10-28T09:00:00Z' })],
  })
  assert.equal(s.leads, 1)
  assert.equal(s.verified_buying_need, 1)
  assert.equal(s.rubric, 'ok')
  // ...bound to the version, offer, window, plan, source artifact, author and date:
  const rec = (await record(db, A, 'L1'))!
  assert.equal(rec.job_id, job)
  assert.equal(rec.basis, 'demand_post')
  assert.equal(rec.verdict, 'verified_buying_need')
  assert.equal(rec.reason, null)
  assert.equal(rec.qualifier_version, 'demand-qualifier/1')
  assert.equal(rec.offer, OFFER)
  assert.equal(Number(rec.window_days), 90)
  assert.equal(rec.author_name, 'Maya Chen')
  assert.equal(rec.author_company, 'Tallyline')
  assert.equal(rec.published_at, '2026-10-28T09:00:00Z')
  assert.equal(rec.source_url, url)
  assert.equal(rec.plan_support, JSON.stringify({ support: 'none', reason: 'no_plan_conditions' }))
  // ...and the tenant-scoped reader returns it while every binding holds.
  const got = await need(db, A, job, 'L1')
  assert.equal(got.status, 'verified_buying_need')
  // The card row beside the lead (the existing per-lead channel) says the same.
  const card = await db.get<{ value: string }>("SELECT value FROM lead_enrichments WHERE lead_id = 'L1' AND tenant_id = ? AND connector = 'scan:need'", [A])
  assert.ok(card?.value.startsWith('Verified buying need'))
})

// ---------------------------------------------------------------------------------------------------- adversarial classes through the actual writer
bothEngines('vendor, competitor, job seeker, recruiter, consumer, third party, event and growth posts are never verified', async ({ db }) => {
  const job = await basePlay(db, A)
  const posts: [string, string, DemandArtifact['author'], string][] = [
    ['v1', 'LeadHarbor', { name: 'Kai Lund', headline: 'Founder, LeadHarbor', company: 'LeadHarbor' }, 'We built LeadHarbor to find verified B2B leads in seconds. Start your free trial, link in comments.'],
    ['v2', 'ProspectPilot', { name: 'Greg Tan', headline: 'VP Sales, ProspectPilot', company: 'ProspectPilot' }, "I'm VP of sales here and we're looking for lead lists to benchmark our own data against."],
    ['v3', 'Campus', { name: 'Alex Kim', headline: 'Business student', company: null }, 'I\'m a student looking for internships in sales. Which companies should I cold email? Does anyone have lead lists of startups that take interns?'],
    ['v4', 'Rivetly', { name: 'Nora Hale', headline: 'Talent Partner, Rivetly', company: 'Rivetly' }, "We're hiring our first SDR to build prospect lists and book meetings. Apply via the link below."],
    ['v5', 'Sam Home', { name: 'Sam R.', headline: null, company: null }, 'Anyone have a lead on a reliable plumber near me? My kitchen sink is leaking and I need someone this week.'],
    ['v6', 'Brightwave PR', { name: 'Hana Sato', headline: 'Account Manager, Brightwave PR', company: 'Brightwave PR' }, 'Our client Vantage Freight is looking for a lead list provider for their sales team. Who would you recommend?'],
    ['v7', 'Orbitly', { name: 'Orbitly Newsroom', headline: null, company: 'Orbitly' }, 'Thrilled to announce Orbitly raised a $12M Series A led by Northwind Ventures to scale our go-to-market.'],
    ['v8', 'Petalbox', { name: 'Lee Wong', headline: 'Founder, Petalbox', company: 'Petalbox' }, "What's the single best growth hack you used to get to $1M ARR? Founders, share your playbook."],
  ]
  const artifacts: DemandArtifact[] = []
  for (const [id, company, author, text] of posts) {
    const url = `https://forum.example.test/t/${id}`
    await lead(db, job, id, { company, url, published: '2026-10-30' })
    artifacts.push(artifact(url, { author, text, published_at: '2026-10-30T10:00:00Z' }))
  }
  const s = await recordNeedEvidence(db, A, job, { asOf: AS_OF, demandArtifacts: artifacts })
  assert.equal(s.verified_buying_need, 0)
  const want: Record<string, [string, string]> = {
    v1: ['excluded', 'excluded:vendor_promotion'],
    v2: ['excluded', 'excluded:competitor'],
    v3: ['excluded', 'excluded:job_seeker'],
    v4: ['unproven', 'buying_need_unproven:weak_trigger:recruiter'],
    v5: ['excluded', 'excluded:consumer'],
    v6: ['excluded', 'excluded:third_party_demand'],
    v7: ['unproven', 'buying_need_unproven:weak_trigger:unrelated_event'],
    v8: ['unproven', 'buying_need_unproven:weak_trigger:generic_growth'],
  }
  for (const [id, [verdict, reason]] of Object.entries(want)) {
    const rec = (await record(db, A, id))!
    assert.equal(rec.verdict, verdict, id)
    assert.equal(rec.reason, reason, id)
    const got = await need(db, A, job, id)
    assert.notEqual(got.status, 'verified_buying_need', id)
    assert.equal(got.status, verdict, id)
  }
  // counts agree with the per-lead verdicts (classification/labels/counts consistent)
  assert.equal(s.excluded, 5)
  assert.equal(s.unproven, 3)
  assert.equal(s.leads, 8)
})

// ---------------------------------------------------------------------------------------------------- outer canonical binding
bothEngines('high_intent alone is never verified: author binding, verified lead and a currently confirmed domain are all required', async ({ db }) => {
  const job = await basePlay(db, A)
  // a) the post's author works somewhere else ("wrong company")
  await lead(db, job, 'w1', { company: 'Tallyline', domain: 'tallyline.example', published: '2026-10-28' })
  await confirmDomain(db, A, 'w1', 'tallyline.example')
  // b) unknown author - even with a founder named on the company's own current site (never stamped from another page)
  await lead(db, job, 'w2', { company: 'Tallyline', domain: 'tallyline.example', published: '2026-10-28' })
  await confirmDomain(db, A, 'w2', 'tallyline.example')
  await db.run(
    `INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at)
     VALUES ('p-w2', 'w2', ?, 'sitecrawl', 'person', 'Maya Chen, Co-founder', NULL, NULL, 'https://tallyline.example/about', '2026-11-02', ?)`, [A, NOW])
  // c) bound author but the domain is NOT confirmed (a populated guess)
  await lead(db, job, 'w3', { company: 'Tallyline', domain: 'tallyline.example', published: '2026-10-28' })
  // d) everything bound but the lead itself is not a verified row
  await lead(db, job, 'w4', { company: 'Tallyline', domain: 'tallyline.example', published: '2026-10-28', verified: false })
  await confirmDomain(db, A, 'w4', 'tallyline.example')
  // e) the SAME source URL cited by another lead: the artifact replays, but the author belongs to Other Corp, never Corvana
  await lead(db, job, 'w5', { company: 'Corvana', domain: 'corvana.example', url: 'https://forum.example.test/t/w1', published: '2026-10-28' })
  await confirmDomain(db, A, 'w5', 'corvana.example')
  // f) bound author but the domain evidence is for a DIFFERENT domain (name-matched guess, not the lead's own)
  await lead(db, job, 'w6', { company: 'Tallyline', domain: 'tallyline.example', published: '2026-10-28' })
  await db.run(
    `INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at)
     VALUES ('dom-w6', 'w6', ?, 'sitecrawl', 'domain', 'other.example|evidence_own_domain', NULL, NULL, 'https://other.example/', '2026-11-02', ?)`, [A, NOW])
  const url = (id: string) => `https://forum.example.test/t/${id}`

  const s = await recordNeedEvidence(db, A, job, {
    asOf: AS_OF,
    demandArtifacts: [
      artifact(url('w1'), { author: { name: 'Maya Chen', headline: 'Co-founder, Other Corp', company: 'Other Corp' }, text: FOUNDER_POST, published_at: '2026-10-28T09:00:00Z' }),
      artifact(url('w2'), { author: null, text: "I'm the founder of a small B2B agency and we need a lead list provider for logistics companies.", published_at: '2026-10-29T10:00:00Z' }),
      artifact(url('w3'), { author: FOUNDER_AUTHOR, text: FOUNDER_POST, published_at: '2026-10-28T09:00:00Z' }),
      artifact(url('w4'), { author: FOUNDER_AUTHOR, text: FOUNDER_POST, published_at: '2026-10-28T09:00:00Z' }),
      artifact(url('w6'), { author: FOUNDER_AUTHOR, text: FOUNDER_POST, published_at: '2026-10-28T09:00:00Z' }),
    ],
  })
  assert.equal(s.verified_buying_need, 0)
  assert.equal((await record(db, A, 'w1'))!.reason, 'author_company_unbound') // the source says the author is at Other Corp, not Tallyline
  assert.equal((await record(db, A, 'w2'))!.verdict, 'needs_evidence')
  assert.equal((await record(db, A, 'w3'))!.reason, 'domain_unconfirmed_now')
  assert.equal((await record(db, A, 'w4'))!.reason, 'lead_not_verified')
  assert.equal((await record(db, A, 'w5'))!.reason, 'author_company_unbound') // replayed artifact: the author is Other Corp's, never Corvana's
  assert.equal((await record(db, A, 'w6'))!.reason, 'domain_unconfirmed_now') // evidence confirms a different domain
  for (const id of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6']) assert.notEqual((await need(db, A, job, id)).status, 'verified_buying_need', id)
})

// ---------------------------------------------------------------------------------------------------- source dates: own, old, future, missing
bothEngines('only the source artifact\'s OWN date counts: missing, future or stale dates never verify', async ({ db }) => {
  const job = await basePlay(db, A)
  const url = (id: string) => `https://forum.example.test/t/${id}`
  // missing post date; the lead's fresh event_date is never manufactured into the post
  await lead(db, job, 'd1', { company: 'Tallyline', domain: 'tallyline.example', event_date: '2026-11-02' })
  await confirmDomain(db, A, 'd1', 'tallyline.example')
  // future date
  await lead(db, job, 'd2', { company: 'Tallyline', domain: 'tallyline.example' })
  await confirmDomain(db, A, 'd2', 'tallyline.example')
  // stale: the post's own date is outside the 90-day window
  await lead(db, job, 'd3', { company: 'Tallyline', domain: 'tallyline.example' })
  await confirmDomain(db, A, 'd3', 'tallyline.example')
  const s = await recordNeedEvidence(db, A, job, {
    asOf: AS_OF,
    demandArtifacts: [
      artifact(url('d1'), { author: FOUNDER_AUTHOR, text: FOUNDER_POST, published_at: null }),
      artifact(url('d2'), { author: FOUNDER_AUTHOR, text: FOUNDER_POST, published_at: '2027-01-01T00:00:00Z' }),
      artifact(url('d3'), { author: { name: 'Owen Park', headline: 'Founder, Tallyline', company: 'Tallyline' }, text: "I'm the founder of Tallyline, a B2B SaaS company, and we're looking for a lead list vendor.", published_at: '2026-03-01T10:00:00Z' }),
    ],
  })
  assert.equal(s.verified_buying_need, 0)
  const r1 = (await record(db, A, 'd1'))!
  assert.equal(r1.verdict, 'needs_evidence')
  assert.equal(r1.published_at, null) // nothing manufactured
  assert.ok(JSON.parse(r1.missing!).includes('date_unknown'))
  assert.ok(JSON.parse((await record(db, A, 'd2'))!.missing!).includes('date_in_future'))
  assert.ok(JSON.parse((await record(db, A, 'd3'))!.missing!).includes('date_outside_window'))
})

// ---------------------------------------------------------------------------------------------------- rubric fail-closed
bothEngines('a conflicted play fails closed: recorded unqualifiable with the loader reason, read back unproven', async ({ db }) => {
  await tenant(db, A, OFFER)
  // the request states a different offer than the play's snapshot: the play has no effective offer (#349 conflict)
  const job = await play(db, A, 'Selling CRM consulting to London startups', null)
  await lead(db, job, 'c1', { company: 'Tallyline', domain: 'tallyline.example', published: '2026-10-28' })
  await confirmDomain(db, A, 'c1', 'tallyline.example')
  const url = 'https://forum.example.test/t/c1'
  const s = await recordNeedEvidence(db, A, job, {
    asOf: AS_OF,
    demandArtifacts: [artifact(url, { author: FOUNDER_AUTHOR, text: FOUNDER_POST, published_at: '2026-10-28T09:00:00Z' })],
  })
  assert.equal(s.verified_buying_need, 0)
  assert.equal(s.unqualifiable, 1)
  assert.equal(s.rubric, 'offer_conflict')
  assert.equal((await record(db, A, 'c1'))!.reason, 'buying_need_unproven:no_rubric:offer_conflict')
  const got = await need(db, A, job, 'c1')
  assert.equal(got.status, 'unproven')
  assert.equal((got as { reason: string }).reason, 'buying_need_unproven:no_rubric:offer_conflict')
})

// ---------------------------------------------------------------------------------------------------- tenant scope
bothEngines('tenant scope is enforced by the record, not the rubric: a foreign tenant reads and writes nothing', async ({ db }) => {
  const job = await basePlay(db, A)
  await tenant(db, B, 'Bookkeeping for restaurants')
  await lead(db, job, 't1', { company: 'Tallyline', domain: 'tallyline.example', published: '2026-10-28' })
  await confirmDomain(db, A, 't1', 'tallyline.example')
  const url = 'https://forum.example.test/t/t1'
  await recordNeedEvidence(db, A, job, { asOf: AS_OF, demandArtifacts: [artifact(url, { author: FOUNDER_AUTHOR, text: FOUNDER_POST, published_at: '2026-10-28T09:00:00Z' })] })
  assert.equal((await need(db, A, job, 't1')).status, 'verified_buying_need')
  // tenant B: no record under its scope, and the writer refuses A's job outright
  assert.deepEqual(await need(db, B, job, 't1'), { status: 'unproven', reason: 'buying_need_unproven:no_record' })
  await assert.rejects(recordNeedEvidence(db, B, job, { asOf: AS_OF }))
  // and A's record is unchanged
  assert.equal((await record(db, A, 't1'))!.verdict, 'verified_buying_need')
})

// ---------------------------------------------------------------------------------------------------- drift and withdrawal fail closed
bothEngines('a stale offer reads unproven', async ({ db }) => {
  const job = await basePlay(db, A)
  await lead(db, job, 's1', { company: 'Tallyline', domain: 'tallyline.example', published: '2026-10-28' })
  await confirmDomain(db, A, 's1', 'tallyline.example')
  const url = 'https://forum.example.test/t/s1'
  await recordNeedEvidence(db, A, job, { asOf: AS_OF, demandArtifacts: [artifact(url, { author: FOUNDER_AUTHOR, text: FOUNDER_POST, published_at: '2026-10-28T09:00:00Z' })] })
  assert.equal((await need(db, A, job, 's1')).status, 'verified_buying_need')
  assert.equal(await setPlayOffer(db, A, job, 'Bookkeeping and payroll for independent restaurants'), true)
  assert.deepEqual(await need(db, A, job, 's1'), { status: 'unproven', reason: 'buying_need_unproven:stale_offer' })
})

bothEngines('a stored record whose version, plan or classifier result drifted reads unproven', async ({ db }) => {
  await tenant(db, A, OFFER)
  assert.equal((await setCompetitors(db, A, ['LeadForge', 'ProspectPilot'])).ok, true)
  const mk = async (leadId: string) => {
    const job = await play(db, A)
    await lead(db, job, leadId, { company: 'Tallyline', domain: 'tallyline.example', published: '2026-10-28' })
    await confirmDomain(db, A, leadId, 'tallyline.example')
    const url = `https://forum.example.test/t/${leadId}`
    await recordNeedEvidence(db, A, job, { asOf: AS_OF, demandArtifacts: [artifact(url, { author: FOUNDER_AUTHOR, text: FOUNDER_POST, published_at: '2026-10-28T09:00:00Z' })] })
    assert.equal((await need(db, A, job, leadId)).status, 'verified_buying_need', leadId)
    return job
  }
  const j1 = await mk('g1') // qualifier version drift
  const j2 = await mk('g2') // plan semantics drift
  const j3 = await mk('g3') // the stored artifact no longer classifies the same
  await db.run("UPDATE lead_need_evidence SET qualifier_version = 'demand-qualifier/0' WHERE lead_id = 'g1'", [])
  await db.run("UPDATE scan_jobs SET query = 'companies hiring sales reps in Ohio' WHERE id = ?", [j2])
  await db.run("UPDATE lead_need_evidence SET source_text = 'We just launched our new office in Toronto!' WHERE lead_id = 'g3'", [])
  assert.deepEqual(await need(db, A, j1, 'g1'), { status: 'unproven', reason: 'buying_need_unproven:stale_version' })
  assert.deepEqual(await need(db, A, j2, 'g2'), { status: 'unproven', reason: 'buying_need_unproven:stale_plan' })
  assert.deepEqual(await need(db, A, j3, 'g3'), { status: 'unproven', reason: 'buying_need_unproven:qualifier_drift' })
})

bothEngines('a withdrawn domain or lead reads unproven now', async ({ db }) => {
  const job = await basePlay(db, A)
  await lead(db, job, 'x1', { company: 'Tallyline', domain: 'tallyline.example', published: '2026-10-28' })
  await confirmDomain(db, A, 'x1', 'tallyline.example')
  await lead(db, job, 'x2', { company: 'Corvana', domain: 'corvana.example', published: '2026-10-28' })
  await confirmDomain(db, A, 'x2', 'corvana.example')
  const url = (id: string) => `https://forum.example.test/t/${id}`
  await recordNeedEvidence(db, A, job, {
    asOf: AS_OF,
    demandArtifacts: [
      artifact(url('x1'), { author: FOUNDER_AUTHOR, text: FOUNDER_POST, published_at: '2026-10-28T09:00:00Z' }),
      artifact(url('x2'), { author: { name: 'Daniel Osei', headline: 'Head of Sales, Corvana', company: 'Corvana' }, text: "Our prospect lists from our current provider bounce at 30%. I'm head of sales at a 40-person SaaS company and we need verified contacts that actually work.", published_at: '2026-10-20T15:30:00Z' }),
    ],
  })
  assert.equal((await need(db, A, job, 'x1')).status, 'verified_buying_need')
  assert.equal((await need(db, A, job, 'x2')).status, 'verified_buying_need')
  await db.run("DELETE FROM lead_enrichments WHERE lead_id = 'x1' AND connector = 'sitecrawl'", [])
  await db.run("UPDATE leads SET review_reason = 'quote_unconfirmed', confidence = NULL WHERE id = 'x2'", [])
  assert.deepEqual(await need(db, A, job, 'x1'), { status: 'unproven', reason: 'buying_need_unproven:domain_withdrawn' })
  assert.deepEqual(await need(db, A, job, 'x2'), { status: 'unproven', reason: 'buying_need_unproven:lead_withdrawn' })
})

// ---------------------------------------------------------------------------------------------------- writer failure: atomic, fail closed
bothEngines('a failed writer leaves NO verdicts (one transaction), and the reader fails closed on the absence', async ({ db }) => {
  const job = await basePlay(db, A)
  await lead(db, job, 'f1', { company: 'Tallyline', domain: 'tallyline.example', published: '2026-10-28' })
  await confirmDomain(db, A, 'f1', 'tallyline.example')
  await lead(db, job, 'f2', { company: 'Corvana', domain: 'corvana.example', published: '2026-10-28' })
  // a pre-existing row that collides with the card row the writer must insert for f2
  await db.run(
    `INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at)
     VALUES ('need-f2', 'f2', ?, 'other', 'x', 'x', NULL, NULL, 'https://x.example/', '2026-11-02', ?)`, [A, NOW])
  const url = (id: string) => `https://forum.example.test/t/${id}`
  await assert.rejects(recordNeedEvidence(db, A, job, {
    asOf: AS_OF,
    demandArtifacts: [
      artifact(url('f1'), { author: FOUNDER_AUTHOR, text: FOUNDER_POST, published_at: '2026-10-28T09:00:00Z' }),
      artifact(url('f2'), { author: { name: 'D', headline: 'CEO, Corvana', company: 'Corvana' }, text: FOUNDER_POST, published_at: '2026-10-28T09:00:00Z' }),
    ],
  }))
  // nothing half-written: no evidence rows, no card rows for either lead
  assert.equal((await db.get<{ n: number }>('SELECT count(*) AS n FROM lead_need_evidence WHERE tenant_id = ?', [A]))!.n, 0)
  assert.equal((await db.get<{ n: number }>("SELECT count(*) AS n FROM lead_enrichments WHERE tenant_id = ? AND connector = 'scan:need'", [A]))!.n, 0)
  assert.deepEqual(await need(db, A, job, 'f1'), { status: 'unproven', reason: 'buying_need_unproven:no_record' })
})

// ---------------------------------------------------------------------------------------------------- repeat reads never write
bothEngines('reads never write: repeated reads change no stored state', async ({ db }) => {
  const job = await basePlay(db, A)
  await lead(db, job, 'r1', { company: 'Tallyline', domain: 'tallyline.example', published: '2026-10-28' })
  await confirmDomain(db, A, 'r1', 'tallyline.example')
  const url = 'https://forum.example.test/t/r1'
  await recordNeedEvidence(db, A, job, { asOf: AS_OF, demandArtifacts: [artifact(url, { author: FOUNDER_AUTHOR, text: FOUNDER_POST, published_at: '2026-10-28T09:00:00Z' })] })
  const before = {
    ev: (await db.get<{ n: number }>('SELECT count(*) AS n FROM lead_need_evidence', []))!.n,
    en: (await db.get<{ n: number }>('SELECT count(*) AS n FROM lead_enrichments', []))!.n,
    created: (await record(db, A, 'r1'))!.created_at,
  }
  await need(db, A, job, 'r1'); await need(db, A, job, 'r1'); await needReadContext(db, A, job)
  assert.equal((await db.get<{ n: number }>('SELECT count(*) AS n FROM lead_need_evidence', []))!.n, before.ev)
  assert.equal((await db.get<{ n: number }>('SELECT count(*) AS n FROM lead_enrichments', []))!.n, before.en)
  assert.equal((await record(db, A, 'r1'))!.created_at, before.created)
})

// ---------------------------------------------------------------------------------------------------- hiring trigger: trigger-only, never verified need
bothEngines('a hiring plan classifies surviving leads trigger-only; completed, negated, optional or absent hiring proves nothing', async ({ db }) => {
  const C = 'c'.repeat(32)
  await tenant(db, C, '') // no offer anywhere: the hiring classification must not need a rubric
  const mkJob = (q: string) => play(db, C, q, null, null)
  // open hiring in positive AND scope: a surviving verified lead is trigger-only, never verified buying need
  const h1 = await mkJob('companies hiring sales reps in Ohio')
  await lead(db, h1, 'hv', { company: 'Acme Corp' })
  await lead(db, h1, 'hh', { company: 'Held Co' })
  const s1 = await recordNeedEvidence(db, C, h1, { asOf: AS_OF, held: new Map([['hh', 'sales_hiring_check_failed']]) })
  assert.equal(s1.rubric, 'no_offer')
  assert.equal(s1.plan_support, 'hiring')
  assert.equal(s1.trigger_only, 1)
  assert.equal(s1.unproven, 1)
  const rhv = await need(db, C, h1, 'hv')
  assert.equal(rhv.status, 'trigger_only')
  assert.notEqual(rhv.status, 'verified_buying_need')
  const rhh = await need(db, C, h1, 'hh')
  assert.deepEqual(rhh, { status: 'unproven', reason: 'buying_need_unproven:sales_hiring_check_failed' })
  // a later withdrawal ends the trigger reading too
  await db.run("UPDATE leads SET review_reason = 'quote_unconfirmed', confidence = NULL WHERE id = 'hv'", [])
  assert.deepEqual(await need(db, C, h1, 'hv'), { status: 'unproven', reason: 'buying_need_unproven:lead_withdrawn' })

  // completed hire / negated / one-of-choices / no conditions: named reasons, nothing claimed
  const cases: [string, string][] = [
    ['companies that hired their first VP of Sales', 'buying_need_unproven:completed_hire_not_open_need'],
    ['companies in Ohio not hiring sales reps', 'buying_need_unproven:hiring_negated'],
    ['companies hiring sales reps or that raised seed funding', 'buying_need_unproven:hiring_one_of_choices'],
    ['dentists in Ohio', 'buying_need_unproven:no_plan_conditions'],
  ]
  for (const [q, reason] of cases) {
    const j = await mkJob(q)
    const lid = `n${cases.findIndex(c => c[0] === q)}`
    await lead(db, j, lid, { company: 'Some Co' })
    const s = await recordNeedEvidence(db, C, j, { asOf: AS_OF })
    assert.equal(s.verified_buying_need, 0, q)
    assert.equal(s.trigger_only, 0, q)
    assert.deepEqual(await need(db, C, j, lid), { status: 'unproven', reason }, q)
  }
})

// ---------------------------------------------------------------------------------------------------- the consumer gate (classifyLeads), sync path
// The #401/#379 contract: actionability itself reads the need evidence. A verified buyer moves held -> actionable
// through the SAME classifyLeads path once the writer recorded the verdict; a missing writer/record/store holds it.
test('[sqlite] classifyLeads gates promotion on the recorded verdict: valid buyer ready, missing record/store held, reads never write', async () => {
  const { default: Database } = await import('better-sqlite3')
  const { migrateAllSqlite } = await import('../lib/db/sqlite-migrations.ts')
  const { sqliteDb } = await import('../lib/db/client.ts')
  const { classifyLeads, recordActionability } = await import('../lib/scan/actionable.ts')
  const { loadPlayDemandRubric } = await import('../lib/scan/demand-rubric-play.ts')
  const raw = new Database(':memory:')
  migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  const now = Math.floor(Date.now() / 1000)
  const day = new Date().toISOString().slice(0, 10)
  const jobId = await basePlay(db, A)
  // a fully sourced lead: confirmed domain, named founder and published mailbox on it, the hiring gate's pass row
  await db.run(
    `INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, score, confidence, fit, published_at, created_at)
     VALUES ('ok', ?, '', 'Tallyline', 'tallyline.example', 'Looking for a lead source', 'https://forum.example.test/t/ok', 80, 80, 5, ?, ?)`, [jobId, day, now])
  const enr = db.run.bind(db)
  await enr("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES ('okp', 'ok', ?, 'sitecrawl', 'person', 'Maya Chen, Co-founder', 'x', NULL, 'https://tallyline.example/team', ?, ?)", [A, day, now])
  await enr("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES ('oke', 'ok', ?, 'sitecrawl', 'email', 'hello@tallyline.example', 'x', NULL, 'https://tallyline.example/contact', ?, ?)", [A, day, now])
  await confirmDomain(db, A, 'ok', 'tallyline.example')
  await enr("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES ('okg', 'ok', ?, 'scan:gate', 'gate_passed', 'sales_hiring', 'x', NULL, 'https://invalid.example/', ?, ?)", [A, day, now])
  const job = { id: jobId, user_id: A, query: QUERY, icp: null }
  const gateCtx = async () => ({ rubric: (await loadPlayDemandRubric(db, A, jobId)).rubric })

  // OLD world: no writer ran. Even a fully sourced lead is NOT promoted - held as buying_need_unproven.
  let rows = classifyLeads(raw, job, new Map(), await gateCtx())
  assert.deepEqual([rows[0].actionable, rows[0].missing], [false, ['buying_need_unproven']])
  let y = recordActionability(raw, job, new Map(), await gateCtx())
  assert.equal(y.actionable, 0)
  assert.equal(y.missing.buying_need_unproven, 1)

  // NEW: the search's write stage records the verified verdict...
  const s = await recordNeedEvidence(db, A, jobId, {
    asOf: new Date(),
    demandArtifacts: [artifact('https://forum.example.test/t/ok', { author: FOUNDER_AUTHOR, text: FOUNDER_POST, published_at: new Date(Date.now() - 3 * 86400000).toISOString() })],
  })
  assert.equal(s.verified_buying_need, 1)
  // ...and the SAME consumer path now promotes the lead: held -> ready.
  rows = classifyLeads(raw, job, new Map(), await gateCtx())
  assert.deepEqual([rows[0].actionable, rows[0].missing], [true, []])
  y = recordActionability(raw, job, new Map(), await gateCtx())
  assert.equal(y.actionable, 1)

  // repeat reads write nothing
  const counts = async () => [
    (await db.get<{ n: number }>('SELECT count(*) AS n FROM lead_need_evidence', []))!.n,
    (await db.get<{ n: number }>('SELECT count(*) AS n FROM lead_enrichments', []))!.n,
  ]
  const before = await counts()
  classifyLeads(raw, job, new Map(), await gateCtx()); classifyLeads(raw, job, new Map(), await gateCtx())
  assert.deepEqual(await counts(), before)

  // a stored record whose bindings drifted (the play's offer changed) holds again
  await setPlayOffer(db, A, jobId, 'Bookkeeping and payroll for independent restaurants')
  rows = classifyLeads(raw, job, new Map(), await gateCtx())
  assert.deepEqual([rows[0].actionable, rows[0].missing], [false, ['buying_need_unproven']])
  await setPlayOffer(db, A, jobId, OFFER)
  // a deleted record (the writer's absence) holds again
  await db.run('DELETE FROM lead_need_evidence', [])
  rows = classifyLeads(raw, job, new Map(), await gateCtx())
  assert.deepEqual([rows[0].actionable, rows[0].missing], [false, ['buying_need_unproven']])
  await db.close()
})

// an older store without the evidence table holds every lead - never a silent bypass
test('[sqlite] older store without lead_need_evidence: classification fails closed', async () => {
  const { default: Database } = await import('better-sqlite3')
  const { migrateScan, createJob } = await import('../lib/scan/store.ts')
  const { migrateConnectors } = await import('../lib/connectors/store.ts')
  const { migrateMemory } = await import('../lib/memory.ts')
  const { classifyLeads } = await import('../lib/scan/actionable.ts')
  const raw = new Database(':memory:')
  migrateScan(raw); migrateConnectors(raw); migrateMemory(raw) // deliberately NO migrateNeedEvidence: the old shape
  const jobId = createJob(raw, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  raw.prepare("UPDATE scan_jobs SET status = 'running', query = 'dentists in Ohio' WHERE id = ?").run(jobId)
  raw.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, confidence, score, fit) VALUES ('L', ?, '', 'Acme', 'acme.example', 's', 'https://x.example/', 80, 80, 5)").run(jobId)
  raw.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES ('Lg', 'L', 'u1', 'scan:gate', 'gate_passed', 'sales_hiring', 'x', NULL, 'https://invalid.example/', '2026-11-01', 1)").run()
  const rows = classifyLeads(raw, { id: jobId, user_id: 'u1', query: 'dentists in Ohio', icp: null })
  assert.equal(rows[0].actionable, false)
  assert.equal(rows[0].missing[0], 'buying_need_unproven', 'the missing evidence table holds the lead first')
})

// ---------------------------------------------------------------------------------------------------- sync/async parity
// The classification gate (sync, needProven) and the reader (async, currentBuyingNeed) must decide IDENTICALLY on
// identical rows and context - they share the one pure revalidation, and this matrix proves it stays that way.
test('[sqlite] parity: the sync gate and the async reader agree across the whole drift matrix', async () => {
  const { default: Database } = await import('better-sqlite3')
  const { migrateAllSqlite } = await import('../lib/db/sqlite-migrations.ts')
  const { sqliteDb } = await import('../lib/db/client.ts')
  const { needProven } = await import('../lib/scan/actionable.ts')
  const { loadPlayDemandRubric } = await import('../lib/scan/demand-rubric-play.ts')
  const raw = new Database(':memory:')
  migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  const job = await basePlay(db, A)
  await lead(db, job, 'p1', { company: 'Tallyline', domain: 'tallyline.example', published: '2026-10-28' })
  await confirmDomain(db, A, 'p1', 'tallyline.example')
  const url = 'https://forum.example.test/t/p1'
  const write = () => recordNeedEvidence(db, A, job, { asOf: AS_OF, demandArtifacts: [artifact(url, { author: FOUNDER_AUTHOR, text: FOUNDER_POST, published_at: '2026-10-28T09:00:00Z' })] })
  await write()
  const ctx = async () => {
    const j = (await db.get<{ query: string | null; icp: string | null }>('SELECT query, icp FROM scan_jobs WHERE id = ?', [job]))!
    return { rubric: (await loadPlayDemandRubric(db, A, job)).rubric, planSupportKey: JSON.stringify(planNeedSupport(compileTargeting(j.query, j.icp))), asOf: AS_OF }
  }
  const leadRow = { id: 'p1', company: 'Tallyline', company_domain: 'tallyline.example' }
  const both = async () => [
    (await need(db, A, job, 'p1')).status,
    needProven(raw, { id: job, user_id: A }, leadRow, await ctx()),
  ] as const
  const expectParity = async (status: string, gate: boolean, note: string) => {
    const [st, g] = await both()
    assert.equal(st, status, note)
    assert.equal(g, gate, note)
  }

  await expectParity('verified_buying_need', true, 'baseline: both paths prove it')
  await db.run("UPDATE lead_need_evidence SET qualifier_version = 'demand-qualifier/0' WHERE lead_id = 'p1'", [])
  await expectParity('unproven', false, 'version drift: both hold')
  await write(); await setPlayOffer(db, A, job, 'Bookkeeping and payroll for independent restaurants')
  await expectParity('unproven', false, 'offer drift: both hold')
  await setPlayOffer(db, A, job, OFFER)
  await expectParity('verified_buying_need', true, 'restored: both prove it again')
  await db.run("UPDATE scan_jobs SET query = 'companies hiring sales reps in Ohio' WHERE id = ?", [job])
  await expectParity('unproven', false, 'plan drift: both hold')
  await db.run('UPDATE scan_jobs SET query = ? WHERE id = ?', [QUERY, job])
  await expectParity('verified_buying_need', true, 'plan restored')
  await db.run("UPDATE lead_need_evidence SET source_text = 'We just launched our new office in Toronto!' WHERE lead_id = 'p1'", [])
  await expectParity('unproven', false, 'qualifier drift: both hold')
  await write()
  await db.run("DELETE FROM lead_enrichments WHERE lead_id = 'p1' AND connector = 'sitecrawl'", [])
  await expectParity('unproven', false, 'domain withdrawn: both hold')
  await db.close()
})
