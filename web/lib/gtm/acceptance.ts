// dazl acquiring customers for dazl.ai with dazl.ai (#407), stage A: one acceptance path through the self-GTM pieces,
// run over a fixture, with no provider, mailbox or payment calls. Each step is the shipped function for that part of
// the journey; this file only hands one step's output to the next and records what each step kept, held or dropped:
//   website   the offer inferred from dazl's own public page, and dazl's own copy checked against product truth (#402)
//   qualify   requester screen (#401) and requirement fit against what ships (#402); screened candidates keep their reason
//   preview   proof preview from the verified run's own leads, buyers only (#403)
//   preflight one launch policy and sample drafts built from the preview, checked before any send (#405)
//   answers   inbound replies decided from product facts, the answers checked against product truth (#406, #402)
//   lifecycle signup -> activation -> paid -> retained cohort for the fixture's customers (#404)
// Fixture companies, replies and payments are synthetic: they never count as live traction. Nothing here sends.
import { requesterRole, type RequesterRole } from '../replies/requester.ts'
import { productTruth, qualifyRequirements, claimIssues, type ClaimIssue, type ProductTruth } from '../product-truth.ts'
import { buildProofPreview, type ProofLeadRow, type ProofPreview, type ProofRun } from '../scan/proof-preview.ts'
import { preflight, type LaunchPolicy, type PreflightInput, type PreflightResult } from '../outreach/launch-policy.ts'
import { decide, type Decision, type Inbound, type ProductFacts, type ThreadState, type AnswerPolicy } from '../replies/buyer-answers.ts'
import { cohortReport, type CohortReport, type CustomerMeta, type LifecycleEvent } from './lifecycle.ts'

export interface Candidate { lead: ProofLeadRow; title: string; quote: string; requirements: string[]; contact: string | null }
export interface AcceptanceFixture {
  site: { url: string; offer: string; copy: string }
  run: ProofRun
  candidates: Candidate[]
  policy: LaunchPolicy
  launch: Omit<PreflightInput, 'policy' | 'samples'>
  answerPolicy: AnswerPolicy
  inbound: { inbound: Inbound; thread: ThreadState }[]
  lifecycle: { events: LifecycleEvent[]; meta: CustomerMeta[]; cohortStart: number; cohortEnd: number }
}

export type Screened = { leadId: string; reason: RequesterRole | 'waitlist' | 'needs_review' }
export interface AcceptanceResult {
  truthVersion: string
  website: { ok: boolean; issues: ClaimIssue[] }
  qualify: { kept: string[]; screened: Screened[] }
  preview: ProofPreview
  preflight: PreflightResult | null
  answers: { decision: Decision; issues: ClaimIssue[] }[]
  lifecycle: CohortReport
  holds: string[]   // the steps that stopped the path; empty when every step passed
}

// The facts the routine answers may use, all from the product-truth record: nothing in a reply is typed by hand.
export function factsFrom(truth: ProductTruth, signupUrl: string): ProductFacts {
  const paid = truth.plans.filter(p => p.usdPerMonth > 0).map(p => `${p.id} is $${p.usdPerMonth} per month`).join('; ')
  return {
    version: truth.version,
    pricing: `There is a free plan; ${paid}. Not included: ${truth.costExclusions.join('; ')}.`,
    prerequisites: `To start you need ${truth.setup.join(', ')}.`,
    howToStart: `Sign up, add your own AI key, describe your offer and run a scan.`,
    limitations: `Sending is from ${truth.senders.map(s => s[0].toUpperCase() + s.slice(1)).join(', ')} only.`,
    signupUrl, bookingUrl: null,
    knownIntegrations: [...truth.senders, ...truth.crm],
  }
}

// The first-touch draft for one preview company: the event and quote from the verified run, the price with its cost
// disclosure. Built from the preview and the facts only.
function draftFor(company: { company: string; event: string; quote: string }, facts: ProductFacts): string {
  return `Saw that ${company.company}: ${company.event} ("${company.quote}"). dazl finds companies showing that kind of signal for your own offer. ${facts.pricing} ${facts.signupUrl}`
}

export function runAcceptance(f: AcceptanceFixture, now: number): AcceptanceResult {
  const truth = productTruth()
  const facts = factsFrom(truth, f.site.url)
  const holds: string[] = []

  const websiteIssues = claimIssues(f.site.copy, [], truth)
  if (websiteIssues.length) holds.push('website')

  const kept: Candidate[] = [], screened: Screened[] = []
  for (const c of f.candidates) {
    const role = requesterRole(c.title, c.quote)
    if (role) { screened.push({ leadId: c.lead.id, reason: role }); continue }
    const fit = qualifyRequirements(c.requirements, truth)
    if (fit.verdict !== 'fit') { screened.push({ leadId: c.lead.id, reason: fit.verdict }); continue }
    kept.push(c)
  }
  if (!kept.length) holds.push('qualify')

  const preview = buildProofPreview({ run: f.run, inferredOffer: { text: f.site.offer, sourceUrl: f.site.url }, leads: kept.map(c => c.lead) }, now)
  let pre: PreflightResult | null = null
  if (preview.status !== 'ready') holds.push('preview')
  else {
    const byCompany = new Map(kept.map(c => [c.lead.company.trim().toLowerCase(), c]))
    const samples = preview.companies.map(p => {
      const c = byCompany.get(p.company.toLowerCase())!
      const body = draftFor(p, facts)
      return { leadId: c.lead.id, to: c.contact ?? '', body, evidenceOk: true, dateOk: true, contactOk: !!c.contact, claimIssues: claimIssues(body, [], truth).map(i => i.kind) }
    })
    pre = preflight({ ...f.launch, policy: f.policy, samples })
    if (!pre.ok) holds.push('preflight')
  }

  const answers = f.inbound.map(({ inbound, thread }) => {
    const decision = decide(inbound, thread, facts, f.answerPolicy)
    return { decision, issues: decision.action === 'reply' ? claimIssues(decision.body, [], truth) : [] }
  })
  if (answers.some(a => a.issues.length)) holds.push('answers')

  const lifecycle = cohortReport(f.lifecycle.events, f.lifecycle.meta, f.lifecycle.cohortStart, f.lifecycle.cohortEnd, now)
  return { truthVersion: truth.version, website: { ok: !websiteIssues.length, issues: websiteIssues }, qualify: { kept: kept.map(c => c.lead.id), screened }, preview, preflight: pre, answers, lifecycle, holds }
}
