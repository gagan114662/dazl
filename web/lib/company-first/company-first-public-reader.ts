// Native public-page reader for settled candidate hints and reviewed owned
// pages. No rendering, record lookup, ownership inference, or posting proof.
import { parse, parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { parseRobots } from '../connectors/sitecrawl.ts'
import { observedSafeGet, type ObservedHttpResult, type ObservedSafeGet } from '../sources/http.ts'
import type { Scope } from './company-first-evidence.ts'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
export type ObservedCompanyPage = Readonly<{ url: string; finalUrl: string; contentType:'text/html'; visibleText:string; jsonLd:readonly string[] }>
export type VisibleCareerLink = Readonly<{ literalHref:string; visibleLabel:string }>
export type ObservedCareerPage = ObservedCompanyPage & Readonly<{ visibleLinks:readonly VisibleCareerLink[] }>
export interface PublicPageReadAuthority {
  // Atomically verify scope/stage authorization and admit this physical request.
  isCurrent(scope:Scope):Promise<boolean>
  reserveCurrentRead(request: Readonly<{scope:Scope; exactUrl:string; step:'robots'|'html'; signal:AbortSignal}>): Promise<boolean>
}
const USER_AGENT='dazl-contact-check/1.0 (+https://dazl.ai)'
const MAX_PAGES=8, MAX_STEPS=16, MAX_BODY=128_000, MAX_VISIBLE=65_536, MAX_NODES=12_000, MAX_LD=8
const MIME = /^text\/(html|plain)(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i
const NON_TEXT = new Set(['head','script','style','noscript','template','iframe','textarea','title','svg','math','video','audio','object','embed','canvas','dialog'])
const HIDDEN_CLASS = /(?:^|\s)(?:hidden|invisible|sr-only|visually-hidden|screen-reader-only|d-none)(?:\s|$)/i
const attr = (node:Element,key:string) => node.attrs.find(x=>x.name===key)?.value
const isElement = (node:Node):node is Element => 'tagName' in node
const children = (node:Node): readonly Node[] => 'childNodes' in node ? node.childNodes : []
const pageUrl = (raw:unknown) => {
  if (typeof raw!=='string' || raw.length>480 || /[\s\\?#]|%(?:2f|5c)/i.test(raw)) return null
  try {
    const u=new URL(raw)
    return u.href===raw && u.protocol==='https:' && !u.username && !u.password && !u.port &&
      /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(u.hostname) &&
      !/\.(?:localhost|local|internal|onion|test|invalid)$/i.test(u.hostname)?u:null
  } catch{return null}
}
const boundedBody = (r:ObservedHttpResult|null, u:string) =>
  !!r && r.finalUrl===u && r.complete && !r.location && !r.truncated && typeof r.body==='string' &&
    r.body.length<=MAX_BODY && new TextEncoder().encode(r.body).byteLength<=MAX_BODY &&
    r.contentEncoding==='identity'
const mime = (r:ObservedHttpResult) => MIME.exec(r.contentType??'')?.[1].toLowerCase()
function literalAnchor(node:Element,html:string):string|null{
  if(node.tagName!=='a')return null
  const loc=node.sourceCodeLocation?.attrs?.href
  if(!loc)return null
  const raw=html.slice(loc.startOffset,loc.endOffset)
  const href=/^href\s*=\s*(["'])([^"'<>&]{1,470})\1$/i.exec(raw)?.[2]
  return href&&href===attr(node,'href')?href:null
}
function statics(html:string,includeLinks:boolean,posting=false) {
  const doc=parse(html,{sourceCodeLocationInfo:true,scriptingEnabled:true})
  type LinkDraft = {literalHref:string; chunks:string[]}
  const stack: {node:Node;body:boolean;link?:LinkDraft}[]=children(doc).map(node=>({node,body:false})).reverse()
  const links:LinkDraft[]=[]
  let baseTag=false
  const fragments:string[] = [], jsonLd:string[] = []
  let count=0, size=0
  while(stack.length){
    const item=stack.pop()
    if(!item)break
    const {node,body}=item
    let link=item.link
    if(++count>MAX_NODES)return null
    if(node.nodeName==='#text' && body && 'value' in node){
      const text=node.value.replace(/\s+/g,' ').trim()
      if(text){
        size+=text.length+(fragments.length?3:0)
        if(size>MAX_VISIBLE)return null
        // Do not join unrelated DOM nodes into a fabricated visible statement.
        fragments.push(text)
        if(link&&link.chunks.length<12)link.chunks.push(text.slice(0,200))
      }
      continue
    }
    if(isElement(node)){
      const tag=node.tagName
      // Relative paths are not literal publisher links under an HTML base.
      if(includeLinks&&tag==='base')baseTag=true
      if(attr(node,'hidden')!==undefined || attr(node,'inert')!==undefined ||
         attr(node,'aria-hidden')?.trim().toLowerCase()==='true' || attr(node,'style')!==undefined ||
         HIDDEN_CLASS.test(attr(node,'class')??'') || (tag==='details' && attr(node,'open')===undefined))continue
      if(tag==='meta' && attr(node,'http-equiv')?.trim().toLowerCase()==='refresh')return null
      if(tag==='script' && attr(node,'type')?.trim().toLowerCase()==='application/ld+json' && attr(node,'src')===undefined){
        const loc=node.sourceCodeLocation
        if(loc?.startTag && loc.endTag){
          const literal=html.slice(loc.startTag.endOffset,loc.endTag.startOffset)
          if(literal.length>16_384 || jsonLd.length>=MAX_LD)return null
          try{
            const obj=JSON.parse(literal)
            if(obj && typeof obj==='object' && !Array.isArray(obj))jsonLd.push(literal)
          }catch{/* Invalid declarations are not observable schema nodes. */}
        }
        continue
      }
      if(posting&&/^(?:select|option|optgroup|datalist|input|button|details|plaintext|xmp|noembed|noframes)$/.test(tag))continue
      if(NON_TEXT.has(tag) && tag!=='head')continue
    }
    const inBody=body || (isElement(node)&&node.tagName==='body')
    if(includeLinks&&inBody&&isElement(node)){
      const href=literalAnchor(node,html)
      if(href){
        if(links.length>=256)return null
        link={literalHref:href,chunks:[]};links.push(link)
      }
    }
    const list=children(node)
    if(stack.length+list.length>MAX_NODES)return null
    for(let i=list.length-1;i>=0;i--)stack.push({node:list[i],body:inBody,link})
  }
  const visibleText=fragments.join(' | ')
  if(visibleText.length<12 || /\b(?:captcha|verify you are (?:a )?human|access denied)\b/i.test(visibleText.slice(0,500)))return null
  const visibleLinks=baseTag?[]:links.map(x=>({literalHref:x.literalHref,visibleLabel:x.chunks.join(' ').trim().slice(0,200)}))
    .filter(x=>x.visibleLabel).map(x=>Object.freeze(x))
  return {visibleText,fragments,jsonLd:Object.freeze(jsonLd),visibleLinks:Object.freeze(visibleLinks)}
}

// Greenhouse represents the description as HTML, sometimes escaped once in
// the JSON field. Unwrap only a whole escaped HTML envelope, not individual
// text nodes of already-marked-up content. Never join nodes to select a quote.
export function greenhouseDescriptionFragments(content:string):readonly string[]{
  if(content.length>MAX_BODY||Buffer.byteLength(content)>MAX_BODY)return []
  let html=content
  if(/^\s*&lt;[a-z!/]/i.test(content)&&!content.includes('<')){
    const envelope=parseFragment(content,{scriptingEnabled:true}).childNodes
    if(envelope.length!==1||!('value' in envelope[0])||!/^\s*<[a-z!/]/i.test(envelope[0].value))return []
    html=envelope[0].value
  }
  return statics(html,false,true)?.fragments??[]
}

export function companyFirstPublicReader(scope:Scope, authority:PublicPageReadAuthority, transport:ObservedSafeGet=observedSafeGet) {
  const exactScope=Object.freeze({tenant:scope.tenant,job:scope.job,attempt:scope.attempt})
  const scoped=Object.values(exactScope).every(v=>typeof v==='string' && !!v.trim() && v.length<=200 && !/[\p{C}]/u.test(v))
  let pages=0, steps=0
  const allowPublicUrl=(raw:string)=>scoped && pageUrl(raw)!==null
  async function readPage(raw:string, callerSignal:AbortSignal,includeLinks:boolean):Promise<ObservedCareerPage|null>{
    const u=pageUrl(raw)
    if(!scoped||!u||callerSignal.aborted||pages>=MAX_PAGES)return null
    pages++
    const signal=AbortSignal.any([callerSignal,AbortSignal.timeout(18_000)])
    async function read(url:string,step:'robots'|'html'){
      if(signal.aborted || steps>=MAX_STEPS)return null
      steps++
      if(await authority.reserveCurrentRead(Object.freeze({scope:exactScope,exactUrl:url,step,signal}))!==true || signal.aborted)return null
      return transport(url,{accept:step==='robots'?'text/plain':'text/html',userAgent:USER_AGENT,signal})
    }
    try{
      const robotsUrl=new URL('/robots.txt',u.origin).href
      // Keep this per physical read: no robots policy cache that crosses runs
      // or allows a refresh to move ownership/authority behind the scope.
      const rb=await read(robotsUrl,'robots')
      if(signal.aborted||!rb||!boundedBody(rb,robotsUrl)||![200,404,410].includes(rb.status))return null
      if(rb.status===200){
        if(mime(rb)!=='plain' || /<\s*(?:!doctype|html\b|body\b|script\b)/i.test(rb.body))return null
        const rules=parseRobots(rb.body,u.hostname)
        if(rules.delayMs!==0||!rules.allows(u.pathname))return null
      }
      const page=await read(raw,'html')
      if(signal.aborted||!page||!boundedBody(page,raw)||page.status!==200||mime(page)!=='html')return null
      const projected=statics(page.body,includeLinks)
      if(!projected || await authority.isCurrent(exactScope)!==true || signal.aborted)return null
      return Object.freeze({visibleText:projected.visibleText,jsonLd:projected.jsonLd,visibleLinks:projected.visibleLinks,
        url:raw,finalUrl:page.finalUrl,contentType:'text/html'})
    }catch{return null}
  }
  async function readPublicHtml(raw:string, signal:AbortSignal):Promise<ObservedCompanyPage|null>{
    const p=await readPage(raw,signal,false)
    if(!p)return null
    return Object.freeze({url:p.url,finalUrl:p.finalUrl,contentType:p.contentType,visibleText:p.visibleText,jsonLd:p.jsonLd})
  }
  return Object.freeze({allowPublicUrl,readPublicHtml,readCareerHtml:(raw:string,signal:AbortSignal)=>readPage(raw,signal,true)})
}
