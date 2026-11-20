// Protected scratch only; no routes, provider wiring or receipt writer.
// Discover/grade, contact and final canonical proof remain separate stages.
import type Database from 'better-sqlite3'
import type { AuthorizedScorecardExecution } from './scorecard-dispatch.ts'
import { authorizeScorecardSubject, scorecardPinnedBudget, type ScorecardSubjectInput } from './scorecard-admission.ts'
import { ownsNewDiscoveryScratch } from './scorecard-evidence-scratch.ts'
import { type Finding } from './company-first-evidence.ts'
import { isIssuedCompanyFirstContact, readIssuedContactBio, type ProvenCompanyFirstContact } from './company-first-contact-proof.ts'
import { isCurrentCanonicalGrading, isFinalCanonicalGrading, takeCanonicalGradedDraft, type CanonicalGradedDraftReceipt, type CanonicalGradedDraft } from './company-first-protected-grading.ts'
import { readPrivateCompanyFirstProof, type CanonicalStagesReader } from './company-first-canonical-read.ts'
import type { CandidateEvidence, CandidateKey } from './company-first-private-proof.ts'
import type { WebsiteProof } from './company-first-website-proof.ts'
import { insertVerifiedLeadRows } from '../scan/runner.ts'
import { FIT_MIN } from '../scan/scoreboard.ts'

type FindingWithSignal = Extract<Finding, {state:'signal_verified'}>
type Site = Extract<WebsiteProof, {state:'verified'}>['site']
type Scope = Readonly<{
  primary:Database.Database; scratch:Database.Database; execution:AuthorizedScorecardExecution;
  finding:FindingWithSignal; signal:AbortSignal
}>
declare const contactBrand:unique symbol
export type CanonicalContactPacket = Readonly<{[contactBrand]:true}>
const packets = new WeakMap<CanonicalContactPacket,{scope:Scope;evidence:CandidateEvidence;grade:CanonicalGradedDraftReceipt;draft:CanonicalGradedDraft['draft'];contact:ProvenCompanyFirstContact;written?:string}>()
const current = (s:Scope) => !s.signal.aborted &&
  ownsNewDiscoveryScratch(s.scratch,s.primary,s.execution.ticket)

/** Join the interval-bound product contact proof to one consumed real grade.
 * No contact readers are called in the completion phase. */
export function prepareCanonicalContact(rawScope:Scope,grade:CanonicalGradedDraftReceipt,
  contact:ProvenCompanyFirstContact):CanonicalContactPacket|null {
  const s=Object.freeze({...rawScope})
  if(!current(s))return null
  const {primary,scratch,execution,finding}=s
  const t=execution.ticket
  if(!isIssuedCompanyFirstContact(contact,{tenant:t.tenantId,job:t.jobId,attempt:String(t.attempt)},finding))return null
  const graded=takeCanonicalGradedDraft(grade,primary,scratch,execution,finding)
  const fit=graded?.draft.fit
  if(!graded||graded.evidenceGated||typeof fit!=='number'||!Number.isFinite(fit)||fit<FIT_MIN)return null
  if(!current(s))return null
  const evidence=Object.freeze({
    companyKey:finding.site.companyKey,website:finding.site.website,identitySource:finding.site.identitySource,
    event:finding.signal.event,eventSource:finding.signal.sourceUrl,eventDate:finding.signal.date,literalQuote:finding.signal.quote,
    buyer:contact.buyer.name,title:contact.buyer.title,buyerBio:contact.buyer.bioUrl,linkedin:contact.buyer.linkedin,...(contact.buyer.ownRole?{ownRole:contact.buyer.ownRole}:{}),
    email:contact.published.address,emailSource:contact.published.sourceUrl,
  })
  const packet=Object.freeze({}) as CanonicalContactPacket
  packets.set(packet,{scope:s,evidence,grade,draft:graded.draft,contact})
  return packet
}

/** Persist only the actual verified+graded row, while the owned scratch job is
 * running. This is not finish, enrichment, a policy receipt, or Ready. */
export function stageCanonicalContactRow(packet:CanonicalContactPacket, s:Scope):string|null {
  const bound=packets.get(packet)
  if(!bound||bound.written||bound.scope.primary!==s.primary||bound.scope.scratch!==s.scratch||
      bound.scope.execution!==s.execution||bound.scope.finding!==s.finding||bound.scope.signal!==s.signal)return null
  const {primary,scratch,execution,finding}=bound.scope
  const t=execution.ticket
  const allowed=()=>process.env.DAZL_ENV==='staging'&&process.env.DAZL_COMMIT_SHA===t.release&&
    scratch!==primary&&scratch.memory&&current(bound.scope)&&isCurrentCanonicalGrading(bound.grade,primary,scratch,execution,finding)
  try{
    if(!allowed()||scratch.inTransaction||primary.inTransaction)return null
    const draft=bound.draft
    if(draft.source_url!==bound.evidence.eventSource||draft.event_date!==bound.evidence.eventDate||
      draft.excerpt!==bound.evidence.literalQuote||!['page_bound','ats_structured'].includes(draft.event_date_proof??'')||
      draft.evidence_copy_page||draft.evidence_origin)return null
    // Hold the authoritative primary lock across the short private write.
    // No provider, reads of a publisher, or async work under either lock.
    const id=primary.transaction(()=>scratch.transaction(()=>{
      if(!allowed())return null
      const row=scratch.prepare(`SELECT query,icp,sources,seller,offer FROM scan_jobs
        WHERE id=? AND user_id='private-scratch' AND attempts=? AND status='running' AND error IS NULL
          AND funded_by='user' AND csv_domain IS NULL AND watch_id IS NULL AND run_budget=?`).get(t.jobId,t.attempt,scorecardPinnedBudget())
      if(!row||!authorizeScorecardSubject(t,row as ScorecardSubjectInput))return null
      return insertVerifiedLeadRows(scratch,{id:t.jobId,user_id:'private-scratch',attempts:t.attempt,watch_id:null,csv_domain:null},[draft])[0]?.id??null
    }).immediate()).immediate()
    if(id)bound.written=id
    return id
  }catch{return null}
}

/** This is the exact staged row and original issued contact, never a
 * caller-provided row ID or fresh proof from an arbitrary page. */
export function currentCanonicalContactPacket(packet:CanonicalContactPacket,s:Scope){
  const b=packets.get(packet)
  if(!b?.written||b.scope.primary!==s.primary||b.scope.scratch!==s.scratch||
    b.scope.execution!==s.execution||b.scope.finding!==s.finding||b.scope.signal!==s.signal)return null
  const {primary,scratch,execution,finding}=b.scope
  const t=execution.ticket
  if(process.env.DAZL_ENV!=='staging'||process.env.DAZL_COMMIT_SHA!==t.release||
    !current(b.scope)||!isCurrentCanonicalGrading(b.grade,primary,scratch,execution,finding))return null
  const bio=readIssuedContactBio(b.contact,{tenant:t.tenantId,job:t.jobId,attempt:String(t.attempt)},finding)
  return bio?Object.freeze({id:b.written,evidence:b.evidence,bio}):null
}

/** The existing canonical stage owner must have persisted and re-read actual
 * proof; a grade, outreach contact proof and a key cannot mint its decisions.
 * A private receipt is not publish or send authority. No raw evidence returned. */
export async function verifyCanonicalContact(packet:CanonicalContactPacket,s:Scope,
  subject:ScorecardSubjectInput,key:CandidateKey,site:Site,stages:CanonicalStagesReader):
  Promise<Extract<Awaited<ReturnType<typeof readPrivateCompanyFirstProof>>,{state:'verified_private'}>['receipt']|null> {
  const bound=packets.get(packet)
  if(!bound||bound.written!==key.id||bound.scope.primary!==s.primary||bound.scope.scratch!==s.scratch||
      bound.scope.execution!==s.execution||bound.scope.finding!==s.finding||bound.scope.signal!==s.signal)return null
  packets.delete(packet)
  const {scope,evidence}=bound
  if(!current(scope)||typeof stages!=='function'||!isFinalCanonicalGrading(bound.grade,scope.primary,scope.scratch,scope.execution,scope.finding))return null
  const verdict=await readPrivateCompanyFirstProof(scope.primary,scope.scratch,scope.execution.ticket,
    subject,key,evidence,stages,Date.now,site)
  return current(scope)&&verdict.state==='verified_private'?verdict.receipt:null
}
