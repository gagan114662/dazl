// Private discovery only: the owned-site -> official Rippling board -> exact
// literal posting chain says where to look, not when it was posted or that
// a Remote eligibility area is a verified job/office location.
import type { Candidate, CompanyFirstPorts, Scope } from './company-first-evidence.ts'
import type { ObservedCareerPage } from './company-first-public-reader.ts'

type VerifiedSite=NonNullable<Awaited<ReturnType<CompanyFirstPorts['verifyWebsite']>>>
type Reader=(exactUrl:string,signal:AbortSignal)=>Promise<ObservedCareerPage|null>
export type RipplingPostingHypothesis=Readonly<{
  kind:'owned_rippling_posting_hypothesis'; scope:Scope; companyKey:string; websiteOrigin:string;
  exactOwnedLinkSource:string; exactBoardUrl:string; exactPostingUrl:string;
  literalBoardHref:string; literalPostingHref:string; linkedLabel:string;
}>
const HOST='ats.rippling.com'
const SLUG='[A-Za-z0-9][A-Za-z0-9_-]{0,79}'
const ID='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const BOARD=new RegExp(`^/(${SLUG})/jobs$`)
const POSTING=new RegExp(`^/(${SLUG})/jobs/(${ID})$`)
const MAX_POSTINGS=3
const text=(v:unknown,n=200):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=n&&!/[\p{C}]/u.test(v)
const canonical=(v:string)=>v.normalize('NFC').trim().replace(/\s+/g,' ').toLowerCase()
const exactUrl=(raw:unknown)=>{
  if(!text(raw,470)||/[\s\\%?#]/u.test(raw))return null
  try{
    const u=new URL(raw)
    return u.href===raw&&u.protocol==='https:'&&u.hostname.includes('.')&&!u.port&&!u.username&&!u.password?u:null
  }catch{return null}
}
function literalUrl(raw:string,base:string){
  if(raw.startsWith('/')&&!raw.startsWith('//'))return exactUrl(new URL(base).origin+raw)
  return exactUrl(raw)
}
function isPage(r:ObservedCareerPage|null,u:string):r is ObservedCareerPage{
  return !!r&&r.url===u&&r.finalUrl===u&&r.contentType==='text/html'&&
    typeof r.visibleText==='string'&&r.visibleText.length<=65_536&&Array.isArray(r.visibleLinks)&&r.visibleLinks.length<=256
}
function literalCompany(visible:string,name:string){
  const phrase=canonical(name).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${phrase}(?![\\p{L}\\p{N}\\p{M}])`,'u').test(canonical(visible))
}

/** One guarded owned page, one exact official board, up to three exact
 * linked postings. No slug guessing, aliases, inferred dated result, hidden
 * markup, search snippets, write, provider, or cross-company path fallback. */
export async function discoverOwnedRipplingPostings(
  scope:Scope,candidate:Candidate,website:VerifiedSite,read:Reader,signal:AbortSignal,
):Promise<readonly RipplingPostingHypothesis[]>{
  const denied=()=>Object.freeze([] as RipplingPostingHypothesis[])
  if(signal.aborted||!Object.values(scope).every(v=>text(v))||website.status!=='verified'||
    !text(website.companyKey)||!text(candidate.name)||website.candidateName!==candidate.name)return denied()
  const owned=exactUrl(website.identitySource)
  if(!owned||owned.origin!==website.website||owned.hostname===HOST)return denied()
  const frozen=Object.freeze({...scope})
  try{
    const first=await read(owned.href,signal)
    if(signal.aborted||!isPage(first,owned.href))return denied()
    const boards=new Map<string,string>()
    for(const a of first.visibleLinks){
      if(!text(a.literalHref,470)||!text(a.visibleLabel))continue
      const u=literalUrl(a.literalHref,owned.href)
      if(u?.hostname===HOST&&BOARD.test(u.pathname))boards.set(u.href,a.literalHref)
    }
    if(boards.size!==1)return denied()
    const [[boardUrl,literalBoardHref]]=boards
    const board=exactUrl(boardUrl)!
    const slug=BOARD.exec(board.pathname)?.[1]
    const listing=await read(boardUrl,signal)
    if(signal.aborted||!slug||!isPage(listing,boardUrl))return denied()
    const posts=new Map<string,{href:string;label:string}>()
    for(const a of listing.visibleLinks){
      if(!text(a.literalHref,470)||!text(a.visibleLabel))continue
      const u=literalUrl(a.literalHref,boardUrl)
      if(u?.origin!==board.origin||POSTING.exec(u.pathname)?.[1]!==slug)continue
      const prior=posts.get(u.href)
      if(prior&&prior.label!==a.visibleLabel)return denied()
      posts.set(u.href,{href:a.literalHref,label:a.visibleLabel})
    }
    const out:RipplingPostingHypothesis[]=[]
    for(const [post,literal] of [...posts].slice(0,MAX_POSTINGS)){
      if(signal.aborted)return denied()
      const observed=await read(post,signal)
      if(!isPage(observed,post)||!literalCompany(observed.visibleText,candidate.name)||
        /\b(?:no longer available|position (?:was )?filled|posting (?:is )?closed)\b/i.test(observed.visibleText))continue
      out.push(Object.freeze({kind:'owned_rippling_posting_hypothesis',scope:frozen,companyKey:website.companyKey,
        websiteOrigin:owned.origin,exactOwnedLinkSource:owned.href,exactBoardUrl:boardUrl,exactPostingUrl:post,
        literalBoardHref,literalPostingHref:literal.href,linkedLabel:literal.label}))
    }
    return signal.aborted?denied():Object.freeze(out)
  }catch{return denied()}
}
