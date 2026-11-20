// Same-process staging scratch projection only; never writes the primary store,
// guesses a mailbox, performs a lookup, stages outreach or attests Ready.
import { addEnrichment } from '../connectors/store.ts'
import { domainBasisToken } from '../connectors/sitecrawl.ts'
import { migrateEmailGuess, recordEmailGuesses } from '../people/email-pattern.ts'
import { migratePublishedDisplay, publishedDisplayCountry, recordPublishedDisplay } from '../people/published-display.ts'
import { migrateOutreach } from '../outreach/store.ts'
import { listedProfileLabel } from '../people/site-profile.ts'
import { strictPublishedWorkEmailsForLeads } from '../people/work-email.ts'
import { currentSiteContact, whoOf } from '../scan/site-contact.ts'
import { authorizeScorecardSubject, scorecardPinnedBudget } from './scorecard-admission.ts'
import { currentCanonicalContactPacket, type CanonicalContactPacket } from './company-first-final-proof-adapter.ts'
import { readReciprocalOwnedCareerPermalink } from './company-first-reciprocal-site.ts'
import { matchesIssuedCompanyIdentity } from './company-first-origin-issuer.ts'
import { projectObservedContactPage, type ObservedContactPage } from './company-first-public-reader.ts'
import { readGuardedOwnRolePage, readGuardedOwnRoleReceipt } from './company-first-guarded-contact.ts'
import type { WebsiteProof } from './company-first-website-proof.ts'

type Scope=Parameters<typeof currentCanonicalContactPacket>[1]
type Site=Extract<WebsiteProof,{state:'verified'}>['site']
type Row={company:string;company_domain:string|null;source_url:string;evidence_excerpt:string;event_date:string;
  query:string;icp:string;seller:string|null;offer:string|null;sources:string|null}
const PRIVATE='private-scratch'
const refused=()=>{throw new Error('canonical_contact_unavailable')}
const digits=(s:string)=>s.replace(/\D/g,'')
export function stageCanonicalSiteContact(packet:CanonicalContactPacket,s:Scope,issuedSite:Site,
  pages:Readonly<{homepage?:ObservedContactPage;bio?:ObservedContactPage}>):
  Readonly<{published:'candidate'|'display_only';currentRoute:boolean}>|null{
  const {primary,scratch,execution}=s
  const t=execution.ticket
  if(primary===scratch||!scratch.open||!scratch.memory||primary.inTransaction||scratch.inTransaction)return null
  try{return primary.transaction(()=>scratch.transaction(()=>{
    const bound=currentCanonicalContactPacket(packet,s)
    if(!bound)return null
    const {id,evidence:e}=bound
    const now=Date.now()
    const scope={tenant:t.tenantId,job:t.jobId,attempt:String(t.attempt)}
    const origin=new URL(e.website),host=origin.hostname
    // The existing basis means the verified event citation ITSELF is first-party.
    // A linked ATS is not this basis, even if its separate ownership was proved.
    if(origin.origin!==e.website||new URL(e.eventSource).origin!==e.website||
      new URL(e.buyerBio).origin!==e.website||e.emailSource!==e.buyerBio)return null
    const row=scratch.prepare(`SELECT l.company,l.company_domain,l.source_url,l.evidence_excerpt,l.event_date,
      j.query,j.icp,j.seller,j.offer,j.sources FROM leads l JOIN scan_jobs j ON j.id=l.scan_job_id
      WHERE l.id=? AND j.id=? AND j.user_id=? AND j.attempts=? AND j.status='running' AND j.error IS NULL
      AND j.run_budget=? AND l.review_reason IS NULL AND l.human_confirmed_at IS NULL`)
      .get(id,t.jobId,PRIVATE,t.attempt,scorecardPinnedBudget()) as Row|undefined
    const publicPosting=readReciprocalOwnedCareerPermalink(issuedSite,scope)
    const reciprocalOwn=!!publicPosting&&publicPosting.url===e.eventSource&&publicPosting.day===e.eventDate&&
      issuedSite.companyKey===e.companyKey&&issuedSite.website===e.website&&
      issuedSite.identitySource===e.identitySource&&issuedSite.candidateName===row?.company
    if(!row||!authorizeScorecardSubject(t,row)||row.company_domain!==null||row.source_url!==e.eventSource||
      row.evidence_excerpt!==e.literalQuote||row.event_date!==e.eventDate||
      (!reciprocalOwn&&!matchesIssuedCompanyIdentity(issuedSite,{scope,companyKey:e.companyKey,website:e.website,
        identitySource:e.identitySource,persistedCompany:row.company,persistedDomain:host},now)))return null
    const role=e.ownRole?readGuardedOwnRoleReceipt(bound.bio,scope,s.finding,now):null
    const rolePage=role?readGuardedOwnRolePage(bound.bio,scope,s.finding,now):null
    const rawBio=rolePage??pages.bio
    if(!rawBio||(rolePage&&pages.bio&&rolePage!==pages.bio))return null
    const bio=projectObservedContactPage(rawBio,scope,e.buyerBio,host,now)
    if(e.ownRole&&(!role||!rolePage||role.sourceUrl!==e.ownRole.sourceUrl||role.observedAtMs!==e.ownRole.fetchedAtMs||
        role.literalRoleQuote!==e.ownRole.quote||role.sourceUrl!==e.buyerBio||role.observedAtMs!==bio?.checkedAt||
        role.name!==e.buyer||role.title!==e.title||role.company!==row.company||role.linkedin!==e.linkedin||
        !role.literalRoleQuote||role.literalRoleQuote.length>254))return null
    if(!bio||!bio.seen.some(p=>p.address.toLowerCase()===e.email.toLowerCase())||
      primary.prepare('SELECT 1 FROM suppressions WHERE tenant_id=? AND lower(email)=lower(?)').get(t.tenantId,e.email))return null
    const where:unknown=JSON.parse(row.icp).where
    if(!Array.isArray(where)||!where.every(x=>typeof x==='string'))return null
    const display=publishedDisplayCountry(where)
    const home=pages.homepage?projectObservedContactPage(pages.homepage,scope,origin.href,host,now):null
    if(!display&&!home)return null
    const person=e.buyer+', '+e.title
    const label=e.linkedin?listedProfileLabel(e.linkedin):null
    if((e.linkedin&&!label)||(!e.linkedin&&!role)||person.length>120)return null
    const set=scratch.prepare('UPDATE leads SET company_domain=? WHERE id=? AND scan_job_id=? AND company_domain IS NULL')
      .run(host,id,t.jobId)
    if(set.changes!==1)return refused()
    const add=(kind:string,value:string,source_url:string,at:number,tag:string|null)=>
      addEnrichment(scratch,PRIVATE,id,{connector:'sitecrawl',kind,value,source_url,label:tag,confidence:null,
        source_date:new Date(at).toISOString().slice(0,10),retrieved_at:Math.floor(at/1000)})
    add('domain',host+'|evidence_own_domain',reciprocalOwn?e.eventSource:e.identitySource,now,domainBasisToken('evidence_own_domain'))
    add('person',person,e.buyerBio,bio.checkedAt,label)
    if(role)add('current_role',role.literalRoleQuote,role.sourceUrl,role.observedAtMs,String(role.observedAtMs))
    if(display){
      migratePublishedDisplay(scratch)
      // Install the canonical product schema only on the memory store.
      migrateOutreach(scratch)
      recordPublishedDisplay(scratch,PRIVATE,id,host,where,[{value:person,url:e.buyerBio}],bio.seen)
      const phone=bio.phones.length===1?bio.phones[0]:null
      // A lone tel href is not enough: the same owned page must show the
      // literal number, independently of the display-only email.
      if(phone&&bio.text.split(' | ').some(line=>digits(line)===digits(phone.value)))
        add('phone',phone.value,phone.url,bio.checkedAt,phone.label)
    }else{
      migrateEmailGuess(scratch)
      recordEmailGuesses(scratch,PRIVATE,id,host,[],[person],{env:{EMAIL_GUESS_ENABLED:'0'},homeText:home?.text,where,seen:bio.seen})
      add('email',e.email.toLowerCase(),e.emailSource,bio.checkedAt,'their own address, printed on the company website')
    }
    const ready=currentSiteContact(scratch,PRIVATE,{id,company_domain:host},whoOf(row.icp))
    const addresses=strictPublishedWorkEmailsForLeads(scratch,PRIVATE,[id],Math.floor(now/1000))[id]
    if(!ready.confirmed||ready.person?.source_url!==e.buyerBio||ready.person.value!==person||
      addresses?.length!==1||addresses[0].target!==e.buyer+'|'+e.title||addresses[0].address!==e.email||
      addresses[0].source_url!==e.emailSource||(!display&&ready.route?.value!==e.email))return refused()
    if(!currentCanonicalContactPacket(packet,s))return refused()
    return Object.freeze({published:display?'display_only' as const:'candidate' as const,currentRoute:!!ready.route})
  }).immediate()).immediate()}catch{return null}
}
