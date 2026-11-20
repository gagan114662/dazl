// Optional provider-free source adapter. The reviewed authority chooses and
// attributes exact public record URLs to the independent originating entities.
// No source is invented from discovery output or from a mirrored search result.
import { getDomain } from 'tldts'
import type { CompanyFirstPorts,CompanySizeBand,CompanySizeFact,SizeReadInput } from './company-first-evidence.ts'

type Source=Readonly<{url:string; basis:CompanySizeFact['basis']; producerKey:string; controllerKey:string; datasetKey:string; recordKey:string; employeesLabel:string; measurementDateLabel:string}>
type Plan=Readonly<{scope:SizeReadInput['scope'];companyKey:string;websiteOrigin:string;version:string;expiresAtMs:number;sources:readonly [Source,Source]}>
type RecordObservation=Readonly<{url:string;recordKey:string;producerKey:string;observedDay:string;employees:CompanySizeBand;visibleRecord:string}>
export interface CompanySizeReadAuthority {
  currentReviewedSources(target:SizeReadInput, signal:AbortSignal):Promise<Plan|null>
  reserveExactRead(request:Readonly<{target:SizeReadInput;version:string;url:string;signal:AbortSignal}>):Promise<boolean>
  // A guarded TLS/robots exact read and reviewed deterministic parser for the
  // source's own complete record; never model output, estimates, or search snippets.
  readExactRecord(url:string, signal:AbortSignal):Promise<RecordObservation|null>
}

const issued=new WeakMap<readonly CompanySizeFact[],number>()
export function isReviewedCompanySizePair(value:readonly CompanySizeFact[],now:number):boolean{
  return Array.isArray(value)&&Number.isSafeInteger(now)&&(issued.get(value)??0)>now
}

const sane=(x:unknown,max=200):x is string=>typeof x==='string'&&x.length<=max&&!!x.trim()&&!/[\p{C}]/u.test(x)
const day=(x:unknown):x is string=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x
const band=(x:CompanySizeBand)=>!!x&&Number.isSafeInteger(x.min)&&Number.isSafeInteger(x.max)&&x.min>=0&&x.min<=x.max
function exact(url:string):URL|null{
 if(!sane(url,500)||/[\s\\]/u.test(url))return null
 try{
   const u=new URL(url)
   return u.href===url&&u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname!=='/'?u:null
 }catch{return null}
}
const domain=(u:URL)=>getDomain(u.hostname,{allowPrivateDomains:true})
export function createReviewedCompanySizeReader(authority:CompanySizeReadAuthority):NonNullable<CompanyFirstPorts['readCompanySize']>{
  return async ({input,signal})=>{
    const compile=(plan:Plan|null)=>{
      if(!plan||plan.companyKey!==input.companyKey||plan.websiteOrigin!==input.websiteOrigin||
        plan.scope?.tenant!==input.scope.tenant||plan.scope.job!==input.scope.job||plan.scope.attempt!==input.scope.attempt||
        !sane(plan.version)||!Number.isSafeInteger(plan.expiresAtMs)||plan.expiresAtMs<=Date.now()||
        !Array.isArray(plan.sources)||plan.sources.length!==2)return null
      const firsts=new Set<string>(), producers=new Set<string>(), controllers=new Set<string>(), datasets=new Set<string>()
      const owned=domain(new URL(input.websiteOrigin))
      if(!owned)return null
      const sources:Source[]=[]
      for(const s of plan.sources){
        const u=exact(s?.url),d=u&&domain(u)
        if(!u||!d||firsts.has(d)||!sane(s.producerKey)||producers.has(s.producerKey)||!sane(s.controllerKey)||controllers.has(s.controllerKey)||
          !sane(s.datasetKey)||datasets.has(s.datasetKey)||!sane(s.recordKey)||
          !sane(s.employeesLabel,120)||!sane(s.measurementDateLabel,120)||s.employeesLabel===s.measurementDateLabel||
          (s.basis==='first_party_disclosure'?u.origin!==input.websiteOrigin:s.basis!=='independent_primary_record'||d===owned))return null
        firsts.add(d);producers.add(s.producerKey);controllers.add(s.controllerKey);datasets.add(s.datasetKey)
        sources.push(Object.freeze({url:s.url,basis:s.basis,producerKey:s.producerKey,controllerKey:s.controllerKey,datasetKey:s.datasetKey,recordKey:s.recordKey,employeesLabel:s.employeesLabel,measurementDateLabel:s.measurementDateLabel}))
      }
      if(!sources.some(s=>s.basis==='independent_primary_record'))return null
      return {version:plan.version,expiry:plan.expiresAtMs,sources,key:JSON.stringify([plan.version,plan.expiresAtMs,sources])}
    }
    if(signal.aborted)return null
    const initial=compile(await authority.currentReviewedSources(input,signal))
    if(!initial||signal.aborted)return null
    const current=async()=>!signal.aborted&&compile(await authority.currentReviewedSources(input,signal))?.key===initial.key&&!signal.aborted
    const facts:CompanySizeFact[]=[]
    for(const s of initial.sources){
      if(!await current()||!await authority.reserveExactRead({target:input,version:initial.version,url:s.url,signal})||signal.aborted)return null
      const observation=await authority.readExactRecord(s.url,signal)
      const r=observation?Object.freeze({...observation,employees:Object.freeze({...observation.employees})}):null
      if(!r||r.url!==s.url||r.recordKey!==s.recordKey||r.producerKey!==s.producerKey||!day(r.observedDay)||!band(r.employees)||
        typeof r.visibleRecord!=='string'||r.visibleRecord.length>32_000||Buffer.byteLength(r.visibleRecord)>32_000||!await current())return null
      // Fixed publisher field labels from reviewed parser policy, not a count
      // guessed from arbitrary digits or a date inferred from retrieval time.
      const rows=r.visibleRecord.split(/\r?\n/).map(l=>l.trim())
      const values=(label:string)=>rows.filter(l=>l.startsWith(label+':')).map(l=>l.slice(label.length+1).trim())
      const count=values(s.employeesLabel),date=values(s.measurementDateLabel)
      if(count.length!==1||date.length!==1||date[0]!==r.observedDay)return null
      const countBand=/^(0|[1-9][0-9]*)(?: *[-–] *(0|[1-9][0-9]*))?$/.exec(count[0])
      if(!countBand||Number(countBand[1])!==r.employees.min||Number(countBand[2]??countBand[1])!==r.employees.max)return null
      const fact=Object.freeze({scope:input.scope,companyKey:input.companyKey,sourceUrl:s.url,datasetKey:s.datasetKey,observedDay:r.observedDay,
        basis:s.basis,employees:Object.freeze({...r.employees})})
      facts.push(fact)
    }
    const pair=Object.freeze(facts)
    issued.set(pair,Math.min(initial.expiry,Date.now()+30_000))
    return pair
  }
}
