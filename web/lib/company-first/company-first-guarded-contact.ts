// Internal optional adapter. No search, address inference, profile transport,
// or contact/Ready shortcut. All physical reads use the bounded public reader.
import { parse,type DefaultTreeAdapterMap } from 'parse5'
import { extractPeople } from '../connectors/sitecrawl.ts'
import type { ObservedSafeGet } from '../sources/http.ts'
import { isCoreVerifiedOwnFinding,isCoreVerifiedAtsFinding,type Scope } from './company-first-evidence.ts'
import { companyFirstPublicReader,type PublicPageReadAuthority } from './company-first-public-reader.ts'
import type { CompanyFirstContactReaders,ContactStage,OfficialDirectory,OfficialBio } from './company-first-contact-proof.ts'

type Finding=Parameters<CompanyFirstContactReaders['isCurrent']>[1]
export type GuardedContactAuthority=Pick<CompanyFirstContactReaders,'isCurrent'|'reserveBeforeDispatch'> &
 Partial<Pick<CompanyFirstContactReaders,'corroborateProfile'>> & {publicRead:PublicPageReadAuthority}
export type GuardedCompanyFirstContactReaders=CompanyFirstContactReaders & {
 verifyOwnRole(originalBio:OfficialBio,finding:Finding,signal:AbortSignal):Promise<GuardedOwnRoleReceipt|null>
}
type Node=DefaultTreeAdapterMap['node']
type Element=DefaultTreeAdapterMap['element']
const children=(n:Node):readonly Node[]=>'childNodes'in n?n.childNodes:[]
const el=(n:Node):n is Element=>'tagName'in n
const attr=(n:Element,key:string)=>n.attrs.find(a=>a.name===key)?.value
const key=(s:string)=>s.normalize('NFC').trim().replace(/\s+/g,' ').toLowerCase()
const sane=(x:unknown,max=120):x is string=>typeof x==='string'&&!!x.trim()&&x.length<=max&&!/[\p{C}<>]/u.test(x)
const namePattern=/^(?:[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\u30FC\u30FB]{2,20}|\p{L}[\p{L}\p{M}'’.\-]*(?: +\p{L}[\p{L}\p{M}'’.\-]*)+)$/u
const ROLE_RECEIPT_TTL_MS=5*60_000
export type GuardedOwnRoleReceipt=Readonly<{
 kind:'official_own_role';sourceUrl:string;observedAtMs:number;name:string;title:string;company:string;
 linkedin:string|null;literalRoleQuote:string;literalNameQuote:string
}>
type GuardedPage=NonNullable<Awaited<ReturnType<ReturnType<typeof companyFirstPublicReader>['readContactHtml']>>>
const issuedRoles=new WeakMap<OfficialBio,Readonly<{scope:Scope;finding:Finding;receipt:GuardedOwnRoleReceipt;page:GuardedPage}>>()
export function readGuardedOwnRoleReceipt(observation:OfficialBio,scope:Scope,finding:Finding,now=Date.now()):GuardedOwnRoleReceipt|null {
 const issued=issuedRoles.get(observation)
 return issued&&issued.finding===finding&&issued.scope.tenant===scope.tenant&&issued.scope.job===scope.job&&
   issued.scope.attempt===scope.attempt&&Number.isFinite(now)&&now>=issued.receipt.observedAtMs&&
   now-issued.receipt.observedAtMs<=ROLE_RECEIPT_TTL_MS?issued.receipt:null
}
// Internal canonical writer only: keep the original observed page object, never
// reconstruct a branded reader output from receipt data or expose raw HTML to UI.
export function readGuardedOwnRolePage(observation:OfficialBio,scope:Scope,finding:Finding,now=Date.now()):GuardedPage|null {
 return readGuardedOwnRoleReceipt(observation,scope,finding,now)?issuedRoles.get(observation)?.page??null:null
}
const outOfScope=/\b(?:former|alumni|previously|retired|emeritus|archive[ds]?|resigned|testimonials?|customers?)\b/i
const heading=/^h[1-6]$/
const profile=/^https:\/\/(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/in\/[a-z0-9_-]{3,100}\/?$/i
const address=/^[a-z0-9]+(?:[._-][a-z0-9]+)*@[a-z0-9.-]+\.[a-z]{2,}$/i
const directoryLabel=/^(?:(?:our |the )?(?:team|leadership|people|management|staff)|meet (?:our |the )?team)$/i
const blocked=(n:Element)=>/^(?:head|template|script|style|noscript|textarea|iframe|dialog|details|svg|math|object|embed|select|option|plaintext|del|s|strike|blockquote)$/.test(n.tagName)||
 ['hidden','inert','style'].some(x=>attr(n,x)!==undefined)||attr(n,'aria-hidden')?.trim().toLowerCase()==='true'||
 /(?:^|\s)(?:hidden|invisible|sr-only|visually-hidden|screen-reader-only|d-none)(?:\s|$)/i.test(attr(n,'class')??'')||
 ['class','id','aria-label','data-status'].some(x=>outOfScope.test((attr(n,x)??'').replace(/[_-]+/g,' ')))
function literal(n:Element):string{
 const loc=n.sourceCodeLocation,k=children(n)
 return loc?.startTag&&loc.endTag&&k.length===1&&k[0].nodeName==='#text'&&'value'in k[0]?k[0].value.trim():''
}
function href(n:Element,raw:string):string|null{
 const loc=n.sourceCodeLocation?.attrs?.href
 return loc?(/^href\s*=\s*(["'])([^"'&<>]+)\1$/i.exec(raw.slice(loc.startOffset,loc.endOffset))?.[2]??null):null
}
function exactOwn(raw:string,base:string,origin:string){
 if(!sane(raw,480)||!(/^(?:https:\/\/|\/(?!\/))/.test(raw))||/[\\\s%?#]/.test(raw))return null
 try{
   const u=new URL(raw,base)
   return u.origin===origin&&u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&u.pathname!=='/'&&
     u.pathname!=='/robots.txt'&&(raw.startsWith('/')?u.pathname===raw:u.href===raw)?u.href:null
 }catch{return null}
}
type Card={name:string;title:string;company?:string;links:{href:string;text:string}[]}
function cards(raw:string):Card[]|null{
 const root=parse(raw,{sourceCodeLocationInfo:true,scriptingEnabled:true})
 const stack:{node:Node;body:boolean}[]=[{node:root,body:false}],out:Card[]=[]
 const names=new Set<string>()
 let seen=0
 while(stack.length){
  if(++seen>10_000||out.length>80)return null
  const {node,body}=stack.pop()!
  if(el(node)){
   if(node.tagName==='base'||(node.tagName==='meta'&&attr(node,'http-equiv')?.toLowerCase().trim()==='refresh'))return null
   if(blocked(node)&&node.tagName!=='head')continue
   if(body&&heading.test(node.tagName)&&outOfScope.test(literal(node)))return null
   if(body&&(node.tagName==='article'||node.tagName==='li')&&node.sourceCodeLocation?.startTag&&node.sourceCodeLocation.endTag){
    const direct=children(node).filter(el),visible=direct.filter(n=>!blocked(n))
    const heads=visible.filter(n=>heading.test(n.tagName))
    const roles=visible.filter(n=>(n.tagName==='p'||n.tagName==='span')&&attr(n,'itemprop')!=='worksFor')
    const employers=visible.filter(n=>attr(n,'itemprop')==='worksFor')
    const name=heads.length===1?literal(heads[0]):'',title=roles.length===1?literal(roles[0]):''
    if(sane(name)&&namePattern.test(name)){
      if(names.has(key(name)))return null
      names.add(key(name))
    }
    // Entire contribution must be one explicit person card. Unsupported or
    // nested mixed-person content can't silently become positive evidence.
    if(sane(name)&&namePattern.test(name)&&sane(title)&&employers.length<=1&&
       direct.every(n=>heading.test(n.tagName)||/^(?:p|span|a|img)$/.test(n.tagName))&&
       children(node).every(n=>el(n)||!('value'in n)||!n.value.trim())&&
       visible.every(n=>!['alt','title','aria-label','data-status'].some(a=>outOfScope.test(attr(n,a)??''))&&
         (!['a','p','span'].includes(n.tagName)||!!literal(n))&&!outOfScope.test(literal(n)))){
      const company=employers.length?literal(employers[0]):undefined
      out.push({name,title,...(company?{company}:{}),
        links:visible.filter(n=>n.tagName==='a').flatMap(n=>{const u=href(n,raw);return u&&u===attr(n,'href')?[{href:u,text:literal(n)}]:[]})})
    }
   }
  }
  const inside=body||(el(node)&&node.tagName==='body')
  if(stack.length+children(node).length>10_000)return null
  for(const child of children(node))stack.push({node:child,body:inside})
 }
 return out
}

export function bindGuardedCompanyFirstContact(raw:Scope,authority:GuardedContactAuthority,wire?:ObservedSafeGet):GuardedCompanyFirstContactReaders{
 const scope=Object.freeze({...raw}), same=(s:Scope)=>s.tenant===scope.tenant&&s.job===scope.job&&s.attempt===scope.attempt
 let read=companyFirstPublicReader(scope,authority.publicRead,wire)
 let active:Finding|null=null,dir:OfficialDirectory|null=null,bio:OfficialBio|null=null,permit:ContactStage|null=null,bioPage:GuardedPage|null=null
 const used=new WeakSet<Finding>()
 const branded=(f:Finding)=>isCoreVerifiedOwnFinding(f,scope)||isCoreVerifiedAtsFinding(f,scope)
 const take=async (stage:ContactStage,signal:AbortSignal)=>{
   if(signal.aborted||!active||permit!==stage)return null
   permit=null
   const f=active
   return branded(f)&&await authority.isCurrent(scope,f)===true&&!signal.aborted&&active===f?f:null
 }
 const still=async(f:Finding,signal:AbortSignal)=>!signal.aborted&&active===f&&await authority.isCurrent(scope,f)===true&&active===f&&!signal.aborted
 return {
  async isCurrent(s,f){
   if(!same(s)||!branded(f)||await authority.isCurrent(scope,f)!==true)return false
   if(active!==f){active=f;dir=null;bio=null;bioPage=null;permit=null
     read=companyFirstPublicReader(scope,authority.publicRead,wire)}
   return true
  },
  async reserveBeforeDispatch(r){
   const f=active
   if(!f||!same(r.scope)||r.signal.aborted||permit||
      (r.stage==='directory'?used.has(f):r.stage==='bio'?!dir||!!bio:r.stage==='profile'?!bio: true)||
      await authority.reserveBeforeDispatch(r)!==true||active!==f||r.signal.aborted||permit)return false
   permit=r.stage
   return true
  },
  async readDirectory(origin,signal){
   const f=await take('directory',signal)
   if(!f||origin!==f.site.website||used.has(f))return null
   used.add(f)
   const start=f.site.identitySource
   if(new URL(start).origin!==origin)return null
   const nav=await read.readContactHtml(start,signal)
   if(!nav||!await still(f,signal))return null
   const targets=new Set(nav.visibleLinks.filter(x=>directoryLabel.test(x.visibleLabel)).flatMap(x=>{
    const u=exactOwn(x.literalHref,start,origin);return u&&u!==start?[u]:[]
   }))
   if(targets.size!==1)return null
   const url=[...targets][0],page=await read.readContactHtml(url,signal)
   if(!page||!await still(f,signal))return null
   const list=cards(page.html)
   if(!list?.length)return null
   const legacy=extractPeople(page.html,url)
   const people:OfficialDirectory['people'][number][]=[]
   for(const p of list){
    if(legacy.some(row=>row.value.startsWith(p.name+', ')&&key(row.value.slice(p.name.length+2))!==key(p.title)))return null
    if(p.company&&key(p.company)!==key(f.name))return null
    const links=new Set(p.links.filter(l=>[key(p.name),'bio','biography','view bio','read bio'].includes(key(l.text))).flatMap(l=>{
     const u=exactOwn(l.href,url,origin);return u&&u!==url&&u!==start?[u]:[]
    }))
    if(links.size!==1)continue
    people.push(Object.freeze({name:p.name,title:p.title,bioUrl:[...links][0]}))
   }
   if(!people.length||people.some((p,i)=>people.slice(0,i).some(q=>q.bioUrl===p.bioUrl)))return null
   return dir=Object.freeze({url,navigation:Object.freeze({sourceUrl:start,linkedUrl:url}),people:Object.freeze(people)})
  },
  async readBio(url,signal){
   const f=await take('bio',signal)
   const expected=dir?.people.find(p=>p.bioUrl===url)
   if(!f||!expected)return null
   const page=await read.readContactHtml(url,signal)
   if(!page||!await still(f,signal))return null
   const list=cards(page.html)
   if(list?.length!==1)return null
   const p=list[0]
   if(key(p.name)!==key(expected.name)||key(p.title)!==key(expected.title)||!p.company||key(p.company)!==key(f.name))return null
   const linked=p.links.filter(l=>profile.test(l.href)&&[key(p.name),key(p.name)+' on linkedin'].includes(key(l.text)))
   const host=new URL(f.site.website).hostname.replace(/^www\./,'').toLowerCase()
   const email=p.links.filter(l=>address.test(l.text)&&l.href==='mailto:'+l.text&&l.text.split('@')[1].toLowerCase()===host)
   if(linked.length>1||email.length>1||p.links.some(l=>profile.test(l.href)&&!linked.includes(l)))return null
   bioPage=page
   return bio=Object.freeze({url,name:p.name,title:p.title,company:p.company,text:[p.name,p.title,...email.map(e=>e.text)].join('\n'),
    profiles:Object.freeze(linked.map(l=>Object.freeze({url:l.href,named:p.name}))),
    publications:Object.freeze(email.map(e=>Object.freeze({named:p.name,address:e.text,literalLine:e.text})))})
  },
  async verifyOwnRole(originalBio,finding,signal){
   const f=await take('profile',signal)
   const observed=bio,page=bioPage
   const stamp=page?.observedAtMs
   if(!f||f!==finding||!observed||observed!==originalBio||observed.profiles.length>1||!page||stamp===undefined||
      !await still(f,signal)||bio!==observed||bioPage!==page||Date.now()-stamp>ROLE_RECEIPT_TTL_MS||Date.now()<stamp)return null
   // Present-role evidence from the verified employer only; a LinkedIn link,
   // when present, is merely a literal listing on the own-site card.
   const receipt=Object.freeze({kind:'official_own_role' as const,
    sourceUrl:observed.url,observedAtMs:stamp,name:observed.name,title:observed.title,company:observed.company,
    linkedin:observed.profiles[0]?.url??null,literalRoleQuote:observed.title,literalNameQuote:observed.name})
   issuedRoles.set(observed,Object.freeze({scope,finding:f,page,receipt}))
   return receipt
  },
  async corroborateProfile(url,signal){
   const f=await take('profile',signal)
   if(!f||bio?.profiles[0]?.url!==url||!authority.corroborateProfile)return null
   const p=await authority.corroborateProfile(url,signal)
   return p&&await still(f,signal)?p:null
  },
 }
}
