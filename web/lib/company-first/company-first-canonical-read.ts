// Final private read bridge only. Uses current legacy product rule readers;
// none is converted into a synthetic affirmative StageAttestation.
import type Database from 'better-sqlite3'
import { enrichmentsForLeads } from '../connectors/store.ts'
import { leadHoldReason, timingOptsFor } from '../outreach/lead-hold.ts'
import { currentnessHeld, leadWindowHeld } from '../outreach/currentness.ts'
import { requiredGateHeld } from '../scan/held-state.ts'
import { timingProofGap } from '../scan/timing-proof.ts'
import { currentSiteContact, siteIdentity, whoOf } from '../scan/site-contact.ts'
import { companyKey } from '../scan/evidence.ts'
import { profileFromListedLabel } from '../people/site-profile.ts'
import { strictPublishedWorkEmailsForLeads } from '../people/work-email.ts'
import { domainRelationship } from '../signals/domain-basis.ts'
import { authorizeScorecardSubject, scorecardPinnedBudget, SCORECARD_ANCHOR, type ScorecardSubjectInput, type VerifiedScorecardTicket } from './scorecard-admission.ts'
import { evaluatePrivateCandidateProof, type CandidateEvidence, type CandidateKey, type Claim, type ProofSnapshot } from './company-first-private-proof.ts'

type VisibleSubset = 'required_hold'|'timing_currentness'|'owned_buyer_listed_profile'|'named_published_work_email'
type Held = 'wrong_claim'|'evidence_mismatch'|'required_hold'|'timing_currentness'|'product_hold'|'buyer_proof_missing'|'published_email_missing'|'authoritative_stages_missing'|'authoritative_stages_invalid'|'store_unavailable'
type Result = {state:'held';reason:Held;observed:readonly VisibleSubset[]} |
  {state:'verified_private';receipt:NonNullable<Awaited<ReturnType<typeof evaluatePrivateCandidateProof>>>}
// This port is deliberately absent until the trusted canonical stage owner
// installs it. Only synchronous, same-private-store reads are allowed; it
// must NOT infer stages from public UI, the verified ticket, or this subset.
export type CanonicalStagesReader = (db:Database.Database, claim:Claim, key:CandidateKey) => ProofSnapshot|null

type Row = Record<string,unknown> & {id:string; company:string; company_domain:string|null; source_url:string; evidence_excerpt:string|null;
  event_date:string|null; signal_kind:string|null; query:string|null; icp:string|null; seller:string|null; offer:string|null;
  sources:string|null; run_budget:string|null }
// Real primary dispatch authorization is distinct from the scratch tenant
// alias. Never infer the actor from SQLite leads or the caller's expected row.
function activePrimary(primary:Database.Database,x:VerifiedScorecardTicket,now:number):boolean {
  if (!Number.isSafeInteger(now)||now>=x.expiresAt) return false
  return !!primary.prepare(`SELECT 1 FROM scan_jobs j JOIN company_scorecard_claims c
      ON c.nonce=j.company_scorecard_claim_nonce AND c.job_id=j.id AND c.attempt=j.attempts AND c.tenant_id=j.user_id
    JOIN company_scorecard_cohorts p ON p.cohort=c.cohort AND p.tenant_id=j.user_id AND p.next_ordinal=c.ordinal
    JOIN organizations o ON o.id=p.tenant_id AND o.company_first_scorecard_enabled=1 AND o.company_first_scorecard_revision=p.workspace_revision
    JOIN memberships m ON m.tenant_id=o.id AND m.member_id=p.actor_id AND m.role='owner'
    JOIN users u ON u.id=m.member_id
    WHERE j.id=? AND j.user_id=? AND j.status='running' AND j.error IS NULL AND j.attempts=?
      AND j.company_scorecard_dispatch_started_at IS NOT NULL AND j.company_scorecard_dispatch_release=?
      AND c.status='running' AND c.lane=1 AND c.nonce=? AND c.ordinal=? AND c.cohort=? AND c.subject_mac=? AND c.expires_at=?
      AND p.actor_id=? AND p.workspace_revision=? AND p.release=? AND p.roster=?
      AND j.business_name=? AND j.run_budget=?
      AND j.query IS NULL AND j.icp IS NULL AND j.seller IS NULL AND j.offer IS NULL AND j.sources IS NULL AND j.icp_inferred IS NULL
      AND NOT EXISTS (SELECT 1 FROM tenant_tombstones d WHERE d.deleted_tenant IN (o.id,u.id))`)
    .get(x.jobId,x.tenantId,x.attempt,x.release,x.nonce,x.ordinal,x.cohort,x.subjectMac,x.expiresAt,x.actorId,x.workspaceRevision,
      x.release,JSON.stringify(x.presets),SCORECARD_ANCHOR.business_name,scorecardPinnedBudget())
}

export async function readPrivateCompanyFirstProof(primary:Database.Database, db:Database.Database, ticket:VerifiedScorecardTicket,
  subject:ScorecardSubjectInput, key:CandidateKey, expected:CandidateEvidence,
  sources?:CanonicalStagesReader, clock=Date.now):Promise<Result> {
  const observed:VisibleSubset[]=[]
  const hold=(reason:Held):Result=>({state:'held',reason,observed:[...observed]})
  const t0=clock()
  const approved=authorizeScorecardSubject(ticket,subject,()=>t0)
  if(!approved||ticket.lane!=='new'||!/^[a-f0-9]{24}$/.test(key.id)||!key.revision) return hold('wrong_claim')
  const claim:Claim=Object.freeze({tenant:ticket.tenantId,job:ticket.jobId,attempt:ticket.attempt,actor:ticket.actorId})
  const selected=Object.freeze({...key})
  const evidence=Object.freeze({...expected})
  let snapshot:ProofSnapshot|null
  try{
    if(primary===db||!activePrimary(primary,ticket,t0))return hold('wrong_claim')
    const scratchTenant='private-scratch' // isolated physical scratch store, not an authorized product workspace
    const read=db.transaction((): {held:Held}|{snapshot:ProofSnapshot|null}=>{
      const row=db.prepare(`SELECT l.*, j.query,j.icp,j.sources,j.seller,j.offer,j.run_budget
        FROM leads l JOIN scan_jobs j ON j.id=l.scan_job_id
        WHERE l.id=? AND j.id=? AND j.user_id=? AND j.attempts=? AND j.status='done' AND j.error IS NULL
          AND j.funded_by='user' AND j.csv_domain IS NULL AND j.watch_id IS NULL`).get(selected.id,claim.job,scratchTenant,claim.attempt) as Row|undefined
      if(!row||row.run_budget!==scorecardPinnedBudget()||row.query!==approved.subject.query||row.icp!==approved.subject.icp||
         row.seller!==approved.subject.seller||row.offer!==approved.subject.offer||row.sources!==approved.subject.sources) return {held:'wrong_claim'}
      if(companyKey(row.company)!==evidence.companyKey||row.source_url!==evidence.eventSource||
         row.evidence_excerpt!==evidence.literalQuote||row.event_date!==evidence.eventDate||row.signal_kind!==evidence.event)
        return {held:'evidence_mismatch'}
      const at=new Date(t0)
      const enrichments=enrichmentsForLeads(db,scratchTenant,[row.id])[row.id]??[]
      if(requiredGateHeld(db,scratchTenant,row.id)!==null)return {held:'required_hold'}
      observed.push('required_hold')
      if(timingProofGap(db,scratchTenant,row.id,at)!==null||currentnessHeld(db,scratchTenant,row.id,at)||
         leadWindowHeld(db,scratchTenant,row.id,at))return {held:'timing_currentness'}
      observed.push('timing_currentness')
      if(leadHoldReason(db,scratchTenant,row,enrichments,timingOptsFor(row),at)!==null)return {held:'product_hold'}
      const site=currentSiteContact(db,scratchTenant,row,whoOf(row.icp)||'founder')
      const domain=siteIdentity(evidence.website)
      if(!site.confirmed||!domain||site.domain!==domain||domainRelationship(db,scratchTenant,row.id,row.company_domain)!=='established'||
         !enrichments.some(r=>r.connector==='sitecrawl'&&r.kind==='domain'&&r.source_url===evidence.identitySource&&
           r.value.toLowerCase().endsWith('|evidence_own_domain')&&siteIdentity(r.value.split('|')[0])===domain)||
         site.person?.value!==`${evidence.buyer}, ${evidence.title}`||site.person.source_url!==evidence.buyerBio||
         profileFromListedLabel(site.person.label??null)!==evidence.linkedin)return {held:'buyer_proof_missing'}
      // The official link is only listed, not independently current. Do not
      // mint the owned-buyer/contact attestation from a sitecrawl label.
      observed.push('owned_buyer_listed_profile')
      const exactTarget=`${evidence.buyer}|${evidence.title}`
      const email=strictPublishedWorkEmailsForLeads(db,scratchTenant,[row.id],Math.floor(t0/1000))[row.id]??[]
      if(!email.some(v=>v.target===exactTarget&&v.status==='published'&&v.provider==='site'&&
           v.address===evidence.email&&v.source_url===evidence.emailSource))return {held:'published_email_missing'}
      observed.push('named_published_work_email')
      const canonical=sources?.(db,claim,selected)
      // Collapse absent/unreadable stages, never fabricate policy revisions,
      // independent LinkedIn, publisher evidence, feedback or billing records.
      return {snapshot:canonical?structuredClone(canonical):null}
    }).deferred()
    if('held' in read)return hold(read.held)
    if(!activePrimary(primary,ticket,clock()))return hold('wrong_claim')
    snapshot=read.snapshot
  }catch{return hold('store_unavailable')}
  if(!snapshot)return hold('authoritative_stages_missing')
  const receipt=await evaluatePrivateCandidateProof({readCurrentSnapshot:async()=>snapshot},claim,selected,evidence,clock)
  try { return receipt&&activePrimary(primary,ticket,clock())?{state:'verified_private',receipt}:hold('authoritative_stages_invalid') }
  catch { return hold('store_unavailable') }
}
