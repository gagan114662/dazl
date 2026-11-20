// Protected additive lift from the Quest prototype's public JobPosting reader.
// Existing root/site, transport, date, and canonical location holds still apply.
import type { Candidate, CompanyFirstPorts, Scope } from './company-first-evidence.ts'
import type { ObservedCareerPage } from './company-first-public-reader.ts'

type Site = NonNullable<Awaited<ReturnType<CompanyFirstPorts['verifyWebsite']>>>
type Read = (url:string,signal:AbortSignal)=>Promise<ObservedCareerPage|null>
export type CareerSchemaObservation = Readonly<{
  kind:'owned_linked_jobposting'; scope:Scope; companyKey:string; employer:string; ownedOrigin:string; sourceUrl:string;
  linkSource:string; boardUrl?:string; title:string; day:string;
  // Literal registry-neutral address tuple, not a canonical place decision.
  location:Readonly<{locality:string;region:string;country:string}>
  ownedVisibleDate:boolean;
}>
/** Publisher-specific observation, not ownership, final signal, or Ready evidence. */
export type ExternalCareerProof = Readonly<{
  vendor:'workable'|'bamboohr'; sourceUrl:string; boardUrl:string; companyLinkSource:string;
  companyKey:string; employer:string; title:string; postedDay:string; witnessedUntil:number;
  location:CareerSchemaObservation['location'];
}>
type ReviewedTarget = (exact: Readonly<Pick<ExternalCareerProof,'title'|'location'>>) => boolean
const external = new WeakMap<CareerSchemaObservation,ExternalCareerProof>()
/** Only the private original from guarded reads; callers must supply current
 * reviewed canonical role AND place confirmation, never query-matched guesses. */
export function readExternalCareerProof(
  row:CareerSchemaObservation,scope:Scope,site:Site,reviewedTarget:ReviewedTarget,clock=Date.now,
):ExternalCareerProof|null{
  const p=external.get(row), now=clock()
  if(!p||!Number.isFinite(now)||now>=p.witnessedUntil||scope.tenant!==row.scope.tenant||scope.job!==row.scope.job||
    scope.attempt!==row.scope.attempt||site.status!=='verified'||site.website!==row.ownedOrigin||
    site.identitySource!==p.companyLinkSource||site.companyKey!==p.companyKey||site.candidateName!==p.employer)return null
  try{return reviewedTarget(Object.freeze({title:p.title,location:p.location}))===true?p:null}catch{return null}
}

type SignalInput = Parameters<CompanyFirstPorts['verifyDatedSignal']>[0]['input']
type SignalProof = NonNullable<Awaited<ReturnType<CompanyFirstPorts['verifyDatedSignal']>>>
const ownedEvidence = new WeakMap<CareerSchemaObservation,Readonly<{sourceText:string;expiresAt:number}>>()
const textScope=(a:Scope,b:Scope)=>a.tenant===b.tenant&&a.job===b.job&&a.attempt===b.attempt

/** Turn one observed owner-published posting into a candidate only. The
 * current reviewed role/place matchers stay authoritative; copies, ATS
 * vendor observations, and markup-only dates are never accepted here. */
export function matchOwnedCareerSignal(
  scope:Scope,input:SignalInput,rows:readonly CareerSchemaObservation[],
  matches: Readonly<{ role(title:string):boolean; place(location:CareerSchemaObservation['location']):boolean }>,
  signal:AbortSignal, clock=Date.now,
):SignalProof|null {
  if(signal.aborted||input.event!=='hiring_posting'||input.postingUrl||rows.length>4)return null
  try{
    const candidates:SignalProof[]=[]
    const current=clock()
    if(!Number.isSafeInteger(current)||current<1)return null
    for(const row of rows){
      const proof=ownedEvidence.get(row), page=exact(row.sourceUrl)
      if(!proof||current>=proof.expiresAt||!page||page.pathname==='/'||page.origin!==input.websiteOrigin||
        row.ownedOrigin!==input.websiteOrigin||row.companyKey!==input.companyKey||!textScope(scope,row.scope)||
        row.day<input.from||row.day>input.through||row.title.length<20||!matches.role(row.title)||!matches.place(row.location))continue
      const literalDate='Posted '+row.day
      if(!proof.sourceText.split(' | ').includes(row.title)||!proof.sourceText.split(' | ').includes(literalDate))continue
      candidates.push({companyKey:input.companyKey,place:input.place,event:input.event,date:row.day,
        sourceUrl:page.href,quote:row.title,literalSourceText:proof.sourceText,
        dateProof:{kind:'first_party_event_date',sourceUrl:page.href,day:row.day,literalDate}})
    }
    return !signal.aborted&&candidates.length===1?candidates[0]:null
  }catch{return null}
}

const txt=(v:unknown,n=200):v is string=>typeof v==='string'&&v===v.trim()&&!!v&&v.length<=n&&!/[\p{C}<>]/u.test(v)
const obj=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null
const fold=(v:string)=>v.normalize('NFC').replace(/\s+/gu,' ').trim().toLowerCase()
const day=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\d$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v
function exact(v:unknown):URL|null{
  if(!txt(v,470)||/[\s\\%?#]/.test(v))return null
  try{const u=new URL(v);return u.href===v&&u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&u.hostname.includes('.')?u:null}catch{return null}
}
const link=(v:string,origin:string)=>exact(v.startsWith('/')&&!v.startsWith('//')?origin+v:v)
function vendor(u:URL):'workable-board'|'workable-job'|'bamboo-board'|'bamboo-job'|null{
  if(u.hostname==='apply.workable.com'){
    if(/^\/j\/[A-Za-z0-9]{6,24}\/?$/.test(u.pathname))return 'workable-job'
    if(/^\/[a-z0-9][a-z0-9-]{0,62}\/?$/.test(u.pathname)&&u.pathname.replace(/\/$/,'')!=='/j')return 'workable-board'
  }
  if(/^[a-z0-9][a-z0-9-]{0,62}\.bamboohr\.com$/.test(u.hostname)){
    if(/^\/careers\/[1-9]\d{0,12}\/?$/.test(u.pathname))return 'bamboo-job'
    if(/^\/careers\/?$/.test(u.pathname))return 'bamboo-board'
  }
  return null
}
const schemaContext=(v:unknown)=>v==='https://schema.org'||v==='https://schema.org/'||v==='http://schema.org'
const currentPage=(r:ObservedCareerPage|null,url:string):r is ObservedCareerPage=>!!r&&r.url===url&&r.finalUrl===url&&
  r.contentType==='text/html'&&r.visibleText.length<=65_536&&r.visibleLinks.length<=256&&r.jsonLd.length<=8
// Bounded standard JSON with duplicate keys refused (including escaped
// equivalents); JSON.parse alone overwrites later authority fields.
function json(raw:string):unknown {
  let i=0,n=0
  const bad=()=>{throw new SyntaxError('invalid schema payload')}
  const wsp=()=>{while(/[ \t\r\n]/.test(raw[i]??''))i++}
  function quoted():string{
    if(raw[i]!=='"')return bad()
    const start=i++
    while(i<raw.length){const c=raw[i++];if(c==='"')return JSON.parse(raw.slice(start,i)) as string;if(c==='\\')i++}
    return bad()
  }
  function walk(depth:number):void{
    if(depth>20||++n>16_000)return bad()
    wsp();if(raw[i]==='"'){quoted();return}
    if(raw[i]==='{'||raw[i]==='['){
      const map=raw[i++]==='{',end=map?'}':']',keys=new Set<string>()
      wsp();if(raw[i]===end){i++;return}
      do{
        wsp();if(map){const k=quoted();if(keys.has(k))return bad();keys.add(k);wsp();if(raw[i++]!==':')return bad()}
        walk(depth+1);wsp();if(raw[i]===end){i++;return}
      }while(raw[i++]===',')
      return bad()
    }
    const start=i;while(i<raw.length&&!/[ \t\r\n,}\]]/.test(raw[i]))i++
    if(i===start)return bad()
  }
  walk(0);wsp();if(i!==raw.length)return bad()
  return JSON.parse(raw)
}
function decode(p:ObservedCareerPage,employer:string,origin:string,from:string,through:string,today:string){
  const jobs:Record<string,unknown>[]=[]
  try{
    for(const s of p.jsonLd){
      if(s.length>16_384)return null
      const o=obj(json(s))
      if(!o||!schemaContext(o['@context']))continue
      const graph=o['@graph']
      if(graph!==undefined&&(!Array.isArray(graph)||graph.length>20))return null
      if(o['@type']==='JobPosting')jobs.push(o)
      for(const item of Array.isArray(graph)?graph:[]){
        const node=obj(item)
        if(node?.['@type']==='JobPosting')jobs.push(node)
      }
    }
  }catch{return null}
  if(jobs.length!==1)return null
  const j=jobs[0],org=obj(j.hiringOrganization),loc=obj(j.jobLocation),addr=obj(loc?.address)
  // No graph references/delegated recruiter aliases/dateModified/"updated",
  // multi-address or telecommute eligibility as exact onsite market proof.
  if((j['@context']!==undefined&&!schemaContext(j['@context']))||j.url!==p.url||
    j.jobLocationType!==undefined||j.applicantLocationRequirements!==undefined||
    !org||org['@type']!=='Organization'||!txt(org.name)||fold(org.name)!==fold(employer)||
    (org.url!==undefined&&exact(org.url)?.origin!==origin)||(org.sameAs!==undefined&&exact(org.sameAs)?.origin!==origin)||
    !txt(j.title)||!day(j.datePosted)||j.datePosted<from||j.datePosted>through||j.datePosted>today||
    (j.validThrough!==undefined&&(!day(j.validThrough)||j.validThrough<today))||
    loc?.['@type']!=='Place'||addr?.['@type']!=='PostalAddress'||
    !txt(addr.addressLocality)||!txt(addr.addressRegion)||!txt(addr.addressCountry)||
    /\b(?:remote|hybrid|closed|expired|no longer available)\b/i.test(j.title+' | '+p.visibleText.slice(0,700)))return null
  const lines=p.visibleText.split(' | ').map(fold)
  if(!lines.includes(fold(j.title))||!lines.includes(fold(org.name))||
    ![addr.addressLocality,addr.addressRegion,addr.addressCountry].every(v=>lines.includes(fold(v))))return null
  return {title:j.title,day:j.datePosted,location:Object.freeze({locality:addr.addressLocality,region:addr.addressRegion,country:addr.addressCountry}),
    ownedVisibleDate:exact(p.url)?.origin===origin&&lines.includes(fold('Posted '+j.datePosted))}
}
export async function discoverOwnedCareerSchema(
  scope:Scope,candidate:Candidate,site:Site,window:Readonly<{from:string;through:string}>,read:Read,signal:AbortSignal,clock=Date.now,
):Promise<readonly CareerSchemaObservation[]>{
  const none=()=>Object.freeze([] as CareerSchemaObservation[])
  const u=exact(site.identitySource)
  if(signal.aborted||!u||u.origin!==site.website||site.status!=='verified'||site.candidateName!==candidate.name||
    ![scope.tenant,scope.job,scope.attempt,site.companyKey,candidate.name].every(v=>txt(v))||
    !day(window.from)||!day(window.through)||window.from>window.through)return none()
  const started=clock()
  if(!Number.isFinite(started))return none()
  const scoped=Object.freeze({...scope}),today=new Date(started).toISOString().slice(0,10)
  if(window.through>today)return none()
  const jobs=new Map<string,string|undefined>(),boards=new Set<string>()
  let identifiedBoard:string|undefined
  try{
    const root=await read(u.href,signal)
    if(signal.aborted||!currentPage(root,u.href))return none()
    // Only the independently verified company URL itself or a literal link
    // from that page. Same-origin path words are discovery bounds, not proof.
    if(root.jsonLd.length)jobs.set(root.url,undefined)
    for(const a of root.visibleLinks){
      const dst=link(a.literalHref,u.origin)
      if(!dst)continue
      const type=vendor(dst)
      if(type?.endsWith('-board'))boards.add(dst.href)
      else if(type?.endsWith('-job')||(dst.origin===u.origin&&/^\/(?:careers|jobs)\/[a-z0-9][a-z0-9/_-]{0,159}$/i.test(dst.pathname)))jobs.set(dst.href,undefined)
    }
    if(boards.size===1){
      const boardUrl=[...boards][0],board=exact(boardUrl)!,kind=vendor(board)
      const body=await read(boardUrl,signal)
      if(signal.aborted)return none()
      if(currentPage(body,boardUrl)&&body.visibleText.split(' | ').map(fold).includes(fold(candidate.name)))identifiedBoard=boardUrl
      if(currentPage(body,boardUrl))for(const a of body.visibleLinks){
        const post=link(a.literalHref,board.origin)
        if(post?.origin===board.origin&&vendor(post)===kind?.replace('-board','-job'))jobs.set(post.href,boardUrl)
      }
    }
    const out:CareerSchemaObservation[]=[]
    for(const [url,boardUrl] of [...jobs].slice(0,4)){
      if(signal.aborted)return none()
      const p=url===root.url?root:await read(url,signal)
      if(!currentPage(p,url))continue
      const d=decode(p,candidate.name,site.website,window.from,window.through,today)
      if(d){
        const row:CareerSchemaObservation=Object.freeze({kind:'owned_linked_jobposting',scope:scoped,companyKey:site.companyKey,employer:candidate.name,
          ownedOrigin:site.website,sourceUrl:url,linkSource:u.href,...(boardUrl?{boardUrl}:{}),...d})
        if(d.ownedVisibleDate&&!boardUrl)ownedEvidence.set(row,Object.freeze({sourceText:p.visibleText,expiresAt:clock()+60_000}))
        out.push(row)
        const provider=vendor(exact(url)!),lines=p.visibleText.split(' | ').map(fold)
        const witnessedUntil=started+60_000
        // Explicit positive publisher status only; a generic Apply button, an
        // unexpired validThrough, or absence of closure are not active proof.
        if(boardUrl&&boardUrl===identifiedBoard&&(provider==='workable-job'||provider==='bamboo-job')&&
          clock()<witnessedUntil&&lines.filter(line=>/^posted \d{4}-\d\d-\d\d$/u.test(line)).every(line=>line===fold('Posted '+d.day))&&lines.includes(fold('Posted '+d.day))&&lines.includes('applications open')&&
          !lines.some(line=>/\b(?:closed|expired|archived|no longer (?:accepting|available)|not accepting)\b/u.test(line))){
          external.set(row,Object.freeze({vendor:provider==='workable-job'?'workable':'bamboohr',sourceUrl:url,boardUrl,
            companyLinkSource:u.href,companyKey:site.companyKey,employer:candidate.name,title:d.title,postedDay:d.day,location:d.location,witnessedUntil}))
        }
      }
    }
    return signal.aborted?none():Object.freeze(out)
  }catch{return none()}
}
