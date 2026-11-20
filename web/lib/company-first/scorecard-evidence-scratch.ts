// SQLite-only private evidence scratch. Never pass the handle to a finder, provider,
// route, or publisher. The primary DB is read-only through fixed authorization statements.
import Database from 'better-sqlite3'
import { createHmac } from 'node:crypto'
import { authorizeScorecardSubject, scorecardPinnedBudget, scorecardRawBudget, SCORECARD_ANCHOR, verifyScorecardTicket, type ScorecardSubjectInput } from './scorecard-admission.ts'
import { createQueryJob, migrateScan } from '../scan/store.ts'
import { migrateConnectors, enrichmentsForLeads } from '../connectors/store.ts'
import { leadHoldReason, timingOptsFor } from '../outreach/lead-hold.ts'
import { currentSiteContact, siteIdentity, whoOf } from '../scan/site-contact.ts'
import { strictPublishedWorkEmailsForLeads } from '../people/work-email.ts'
import { titleMatches } from '../people/rank.ts'
import { identityOf } from '../scan/opportunity.ts'
import { targetKey, workEmailTargets } from '../people/work-email-eligible.ts'

type Authority = Readonly<{actorId:string;tenantId:string;jobId:string;release:string;attempt:1}>
type Input = Readonly<{eventQuote:string;sourceUrl:string;eventDay:string|null;candidateOrdinal:number;requiredGateFailed?:true}>
type Snapshot = Readonly<{schema:'private-scratch-v1'|'private-canonical-scratch-v1';candidates:readonly Readonly<{ordinal:number;canonicalReady:boolean;rightPlace:null;ownedSource?:boolean;namedBuyer?:boolean;publishedWorkEmail?:boolean}>[];candidateCount:number|null;rightPlaceCount?:number|null;seal:string}>
const NONE = 'not_authorized' as const
const DAY = /^\d{4}-\d{2}-\d{2}$/
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/u
const SEAL_KIND = 'dazl-private-scorecard-evidence:v1\n'
const bounded=(v:unknown,n:number):v is string=>typeof v==='string' && v.length>0 && v.length<=n && !/[\x00-\x08\x0b-\x1f\x7f]/.test(v)
function publicSource(value:unknown):value is string {
  if(!bounded(value,500)||/[@%]/.test(value))return false
  try {
    const u=new URL(value)
    // Pure syntax check only, never fetched here nor promoted as origin/location proof.
    return u.href===value && u.protocol==='https:' && !u.username&&!u.password&&!u.port&&!u.hash&&!u.search&&
      /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)&&!u.hostname.endsWith('.local')
  }catch{return false}
}

type CanonicalScratchCallback = (context:Readonly<{ db:Database.Database; job:Readonly<{id:string;user_id:string;attempts:1}>;
  signal:AbortSignal }>) => void | Promise<void>

function openScratch(primary:Database.Database, expected:Authority, signedTicket:string, key:Uint8Array,
  input:ScorecardSubjectInput,mode:'drafts'|'canonical'|'new-preverify', clock:()=>number){
  const scope=Object.freeze({...expected})
  const ticket=verifyScorecardTicket(signedTicket,key,scope,clock())
  const expectedLane=mode==='new-preverify'?'new':'old'
  if(!ticket||ticket.lane!==expectedLane||ticket.attempt!==1)return null
  const proof=authorizeScorecardSubject(ticket,input,clock)
  if(!proof)return null
  const subject=proof.subject
  const sealKey=Uint8Array.from(key)
  const authorize=()=>{
    const now=clock()
    if(!Number.isSafeInteger(now)||now>=ticket.expiresAt)return
    const admitted=primary.prepare(`SELECT 1 AS authorized
      FROM scan_jobs j JOIN company_scorecard_claims c ON c.nonce=j.company_scorecard_claim_nonce
      JOIN company_scorecard_cohorts p ON p.cohort=c.cohort AND p.tenant_id=c.tenant_id
      JOIN organizations o ON o.id=p.tenant_id JOIN memberships m ON m.tenant_id=o.id AND m.member_id=p.actor_id
      JOIN users u ON u.id=p.actor_id
      WHERE j.id=? AND j.user_id=? AND j.attempts=1 AND j.status='running' AND j.error IS NULL AND j.funded_by='user'
        AND j.csv_domain IS NULL AND j.watch_id IS NULL AND j.company_scorecard_dispatch_release=?
        AND j.business_name=? AND j.run_budget=?
        AND j.query IS NULL AND j.icp IS NULL AND j.offer IS NULL AND j.seller IS NULL AND j.sources IS NULL AND j.icp_inferred IS NULL
        AND j.company_scorecard_dispatch_started_at IS NOT NULL AND j.company_scorecard_dispatch_started_at<=?
        AND c.job_id=j.id AND c.tenant_id=j.user_id AND c.attempt=j.attempts AND c.status='running' AND c.lane=?
        AND c.cohort=? AND c.nonce=? AND c.ordinal=? AND c.expires_at=? AND c.subject_mac=? AND p.next_ordinal=c.ordinal
        AND p.release=? AND p.actor_id=? AND p.workspace_revision=? AND p.roster=?
        AND o.company_first_scorecard_enabled=1 AND o.company_first_scorecard_revision=p.workspace_revision
        AND m.role='owner' AND u.email_verified_at IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM tenant_tombstones d WHERE d.deleted_tenant IN(o.id,u.id))`)
      .get(ticket.jobId,ticket.tenantId,ticket.release,SCORECARD_ANCHOR.business_name,scorecardPinnedBudget(),now,expectedLane==='new'?1:0,ticket.cohort,ticket.nonce,ticket.ordinal,ticket.expiresAt,ticket.subjectMac,
        ticket.release,ticket.actorId,ticket.workspaceRevision,JSON.stringify(ticket.presets)) as {authorized:number}|undefined
    return admitted?.authorized===1 ? subject:undefined
  }
  const lifetime=new AbortController()
  let scratch:Database.Database|undefined, timer:ReturnType<typeof setTimeout>|undefined, closed=false
  function close(){
    if(closed)return
    closed=true; lifetime.abort(); if(timer)clearTimeout(timer);sealKey.fill(0)
    try{scratch?.close()}catch{/* never reuse */}scratch=undefined
  }
  const tenant='private-scratch', job=ticket.jobId // job id never exported; physical DB is per operation.
  try {
    const row=authorize()
    if(!row||!bounded(row.query,600)||[row.query,row.icp,row.offer,row.seller,row.sources].some(v=>v!==null&&EMAIL.test(v))){close();return null}
    scratch=new Database(':memory:')
    scratch.pragma('temp_store = MEMORY')
    migrateScan(scratch);migrateConnectors(scratch)
    // Leave no transport/credential tables available and give callers no database handle.
    scratch.transaction(()=>{
      createQueryJob(scratch!,tenant,{id:job,query:row.query,icp:row.icp,sources:row.sources,seller:row.seller??undefined,
        offer:row.offer,icpReviewed:true,runBudget:scorecardRawBudget()})
      // Use the same strict storage transition and exact policy as production,
      // without its tenant-key existence check: the opaque primary producer
      // already made that authoritative check. No credential table/row is copied.
      const pinned=scratch!.prepare(`UPDATE scan_jobs SET status='running',attempts=1,claimed_at=?,run_budget=?
        WHERE id=? AND user_id=? AND status='pending' AND attempts=0 AND run_budget=?`)
        .run(Math.floor(clock()/1_000),scorecardPinnedBudget(),job,tenant,scorecardRawBudget())
      if(pinned.changes!==1)throw new Error('scratch pin refused')
    })()
    // In this physically separate memory store no marked job can exist, and
    // the primary-only dispatch triggers refer to finance tables forbidden
    // here. Keep all ordinary canonical verifier/storage triggers intact.
    scratch.exec(`DROP TRIGGER IF EXISTS company_scorecard_no_handback;
      DROP TRIGGER IF EXISTS company_scorecard_marker_immutable;
      DROP TRIGGER IF EXISTS company_scorecard_dispatch_stamp;
      DROP TABLE scan_spend_calls; DROP TABLE tenant_spend_pools; DROP TABLE tenant_connectors`)
    timer=setTimeout(close,Math.max(0,ticket.expiresAt-clock())); timer.unref()
    const n=5
    let workUsed=false, workComplete=false
    const authorized=()=>{try {return !closed && scratch!==undefined && !!authorize()}catch{return false}}
    const limits=Object.freeze({maxSynchronousPageBytes:16_777_216,maxAsyncMs:180_000})
    return Object.freeze({
      async runCanonical(work:CanonicalScratchCallback):Promise<Snapshot|true|null>{
        if((mode!=='canonical'&&mode!=='new-preverify')||workUsed||!authorized()||!scratch){close();return null}
        workUsed=true
        // Restrict retained storage independently of the evidence-count bound. A trusted in-process
        // adapter can run existing local row/proof helpers; it is not an untrusted SQL sandbox.
        scratch.pragma(`max_page_count = ${Math.floor(limits.maxSynchronousPageBytes/4096)}`)
        const stop=setTimeout(close,Math.min(mode==='new-preverify'?480_000:limits.maxAsyncMs,Math.max(1,ticket.expiresAt-clock())))
        stop.unref()
        try {
          const scope=Object.freeze({db:scratch,job:Object.freeze({id:job,user_id:tenant,attempts:1 as const}),signal:lifetime.signal})
          // Never await uncooperative callback forever. Its captured handle is physically closed
          // before result leaves, even if trusted asynchronous caller ignores the cancel signal.
          const invocation=Promise.resolve().then(async()=>{if (!authorized()) return false; await work(scope); return true},()=>false)
            .catch(()=>false)
          let abort:()=>void=()=>{}
          const stopped=new Promise<false>(done=>{abort=()=>done(false);lifetime.signal.addEventListener('abort',abort,{once:true})})
          try{workComplete=await Promise.race([invocation,stopped])&&authorized()}
          finally {lifetime.signal.removeEventListener('abort',abort)}
          return workComplete?(mode==='new-preverify'?true:this.seal()):null
        }catch{return null}finally{clearTimeout(stop);close()}
      },
      close,
      // No company name, actor/contact, credential, human confirmation or arbitrary enrichment accepted.
      // This MVP can't mint first-party, location, publication/currentness or date proof from raw draft inputs.
      add(value:Input){
        if(mode!=='drafts'||!scratch||closed)return NONE
        try {
          try {if(!authorize()){close();return NONE}} catch {close();return NONE}
          if(!Number.isSafeInteger(value.candidateOrdinal)||value.candidateOrdinal<1||value.candidateOrdinal>n||
            !publicSource(value.sourceUrl)||!bounded(value.eventQuote,300)||EMAIL.test(value.eventQuote)||
            (value.eventDay!==null&&!DAY.test(value.eventDay)))return 'invalid_evidence' as const
          const id=String(value.candidateOrdinal)
          scratch.transaction(()=>{
            scratch!.prepare(`INSERT INTO leads(id,scan_job_id,company,signal,source_url,event_date,review_reason)
              VALUES(?,?,'Anonymous candidate',?,?,?,'unverified_scratch')`).run(id,job,value.eventQuote,value.sourceUrl,value.eventDay)
            if(value.requiredGateFailed===true) {
              const now=Math.floor(clock()/1_000)
              scratch!.prepare(`INSERT INTO lead_enrichments(id,tenant_id,lead_id,connector,kind,value,source_url,source_date,retrieved_at)
                VALUES(?,?,?,'scan:gate','gate_failed','scratch proof missing',?,?,?)`)
                .run('hold-'+id,tenant,id,value.sourceUrl,new Date(now*1_000).toISOString().slice(0,10),now)
            }
          })()
          return 'recorded' as const
        }catch{return 'invalid_evidence' as const}
      },
      // One anonymous aggregate transfer; no URL, text, contact, job id or timestamps.
      seal():Snapshot|null{
        if(!scratch||closed||(mode==='canonical'&&!workComplete))return null
        try{
          const j=authorize()
          if(!j)return null
          let candidateCount:number|null=null
          if(mode==='canonical'){
            // Only a completed canonical run can export; no synthetic human review or late worker stage.
            const finished=scratch.prepare(`SELECT candidates FROM scan_jobs WHERE id=? AND user_id=? AND status='done'
              AND error IS NULL AND attempts=1 AND claimed_at IS NULL AND finished_at IS NOT NULL
              AND (enrich_started_at IS NULL AND enrich_finished_at IS NULL OR
                   enrich_started_at IS NOT NULL AND enrich_finished_at>=enrich_started_at)`).get(job,tenant) as {candidates:number|null}|undefined
            if(!finished||scratch.prepare(`SELECT 1 FROM leads WHERE scan_job_id=? AND
              (human_confirmed_at IS NOT NULL OR human_confirmed_from IS NOT NULL OR source_kind='test') LIMIT 1`).get(job))return null
            if(finished.candidates!==null){
              if(!Number.isSafeInteger(finished.candidates)||finished.candidates<0)return null
              candidateCount=finished.candidates
            }
          }
          const rows=scratch.prepare('SELECT * FROM leads WHERE scan_job_id=? ORDER BY created_at,insert_seq,id LIMIT 6').all(job) as (Record<string,unknown>&{id:string})[]
          if(rows.length>n)return null
          const at=new Date(clock()), opts=timingOptsFor(j), byLead=enrichmentsForLeads(scratch,tenant,rows.map(r=>r.id))
          const ready=rows.map(r=>leadHoldReason(scratch!,tenant,r,byLead[r.id]??[],opts,at)===null)
          const strictEmails=mode==='canonical'
            ? strictPublishedWorkEmailsForLeads(scratch,tenant,rows.filter((_,i)=>ready[i]).map(r=>r.id),Math.floor(at.getTime()/1_000)): {}
          const who=whoOf(j.icp)
          const candidates=Object.freeze(rows.map((r,i)=>{
            const base={ordinal:mode==='canonical'?i+1:Number(r.id),canonicalReady:ready[i],rightPlace:null}
            if(mode!=='canonical')return Object.freeze(base)
            const site=ready[i]?currentSiteContact(scratch!,tenant,{id:r.id,company_domain:typeof r.company_domain==='string'?r.company_domain:null},who):null
            let sourceHost:string|null=null
            if(publicSource(r.source_url))sourceHost=new URL(r.source_url).hostname
            const ownedSource=!!site?.confirmed&&!!sourceHost&&siteIdentity(sourceHost)===site.domain&&r.evidence_origin===null&&r.evidence_purged_at===null&&r.own_fetch_failure===null&&
              typeof r.evidence_excerpt==='string'&&r.evidence_excerpt.length>0
            const rawTitle=site?.person?.value.split(',').slice(1).join(',').trim()??''
            const rawName=site?.person?.value.split(',')[0]?.trim()??''
            const exactKey=targetKey({name:rawName,title:rawTitle})
            const people=ownedSource&&rawName&&rawTitle?workEmailTargets(byLead[r.id]??[],who,at.getTime(),identityOf({id:r.id,contact:typeof r.contact==='string'?r.contact:null},byLead[r.id]??[])):[]
            const namedBuyer=ownedSource&&!!rawTitle&&(!who||titleMatches(rawTitle,who).length>0)&&
              people.filter(p=>targetKey(p)===exactKey&&p.verified?.currency==='verified_current'&&p.verified.basis==='first_party_page').length===1
            // Strict read rejects guesses, stale/unbound person/domain and non-published candidates.
            // Require a unique result and exact matching currently selected own-site person as well.
            const got=(strictEmails[r.id]??[]).filter(a=>a.target===exactKey)
            const publishedWorkEmail=namedBuyer&&got.length===1&&got[0].status==='published'&&got[0].provider==='site'&&
              !!got[0].address&&publicSource(got[0].source_url)&&siteIdentity(new URL(got[0].source_url).hostname)===site?.domain
            return Object.freeze({...base,ownedSource,namedBuyer,publishedWorkEmail})
          }))
          if(!authorize())return null
          const schema=mode==='canonical'?'private-canonical-scratch-v1':'private-scratch-v1'
          let rightPlaceCount: number|null = null
          if (mode==='canonical' && candidateCount!==null && scratch.prepare("SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name='company_scorecard_place_metric'").get()) {
            const measured=scratch.prepare('SELECT n FROM temp.company_scorecard_place_metric WHERE job_id=?').get(job) as {n:number}|undefined
            if (measured && Number.isSafeInteger(measured.n) && measured.n>=0 && measured.n<=candidateCount) rightPlaceCount=measured.n
          }
          // Bind aggregate to private signed authority without exposing it. No reversible raw case/lead digest.
          const seal=createHmac('sha256',sealKey).update(SEAL_KIND).update(JSON.stringify([ticket.nonce,ticket.release,schema,candidateCount,rightPlaceCount,candidates])).digest('hex')
          return Object.freeze({schema,candidateCount,rightPlaceCount,candidates,seal})
        }catch{return null}finally{close()}
      },
    })
  } catch {close();return null}
}

export function openPrivateEvidenceScratch(primary:Database.Database, expected:Authority, signedTicket:string, key:Uint8Array,input:ScorecardSubjectInput, clock=Date.now){
  return openScratch(primary,expected,signedTicket,key,input,'drafts',clock)
}

/** A protected local caller invokes only canonical offline persistence/final scoring in work.
 * Never hand it the primary ledger/credentials; paid and network stages happen separately
 * under existing central gates. Callback return values are discarded, including errors.
 */
export async function withCanonicalEvidenceScratch(primary:Database.Database, expected:Authority, signedTicket:string,
  key:Uint8Array,input:ScorecardSubjectInput,work:CanonicalScratchCallback, clock=Date.now):Promise<Snapshot|null>{
  const isolated=openScratch(primary,expected,signedTicket,key,input,'canonical',clock)
  const receipt=isolated?await isolated.runCanonical(work):null
  return receipt===true?null:receipt
}

/** Only the protected new lane may borrow this exact per-run memory database.
 * No evidence or callback result escapes this helper; work never receives primary.
 */
export async function withNewDiscoveryScratch(primary:Database.Database,expected:Authority,signedTicket:string,key:Uint8Array,
  input:ScorecardSubjectInput,work:CanonicalScratchCallback,clock=Date.now):Promise<boolean>{
  const isolated=openScratch(primary,expected,signedTicket,key,input,'new-preverify',clock)
  return isolated ? await isolated.runCanonical(work)===true : false
}
