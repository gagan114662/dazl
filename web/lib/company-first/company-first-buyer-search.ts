// Company-first buyer proof by search (ported from the research runner).
// The search adapter (Claude Haiku web search through the existing client and
// spend reservation) only PROPOSES a person; nothing it says is trusted. A
// buyer is proven only by an exact named role card on the verified origin.
// Outside articles and mirrors have no verified current-employment issuer.
// Email is separate and optional: a missing published email never holds a buyer.
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { getDomain } from 'tldts'
import type { PublicProfileCorroboration } from './company-first-contact-proof.ts'
import type { Finding, Scope } from './company-first-evidence.ts'

export type BuyerSearchStage = 'buyer_search' | 'buyer_page' | 'buyer_profile'
export interface BuyerSearchCandidate {
  name: string
  title: string
  linkedin: string | null
  sources: readonly string[]
}
export interface PublicPage { url: string; text: string; html?: string }
export interface BuyerSearchReaders {
  isCurrent(scope: Scope, finding: SignalFinding): Promise<boolean>
  reserveBeforeDispatch(request: { scope: Scope; stage: BuyerSearchStage; signal: AbortSignal }): Promise<boolean>
  // Proposal only. Must use the existing Claude client under the scan budget.
  searchBuyer(request: { company: string; website: string; titles: readonly string[] }, signal: AbortSignal): Promise<BuyerSearchCandidate | null>
  // Guarded, whole HTML bytes from the exact final HTTPS URL plus visible
  // text. An adapter with flat text only cannot prove person-card ownership.
  readPage(url: string, signal: AbortSignal): Promise<PublicPage | null>
  // Existing trusted corroboration contract only. Absent evidence removes
  // the optional link; never construct a URL or infer identity from its slug.
  corroborateProfile?(exactAlreadyPublishedUrl:string,signal:AbortSignal):Promise<PublicProfileCorroboration|null>
}
type SignalFinding = Extract<Finding, { state: 'signal_verified' }>
type Hold = 'missing_signal_proof' | 'missing_requested_role' | 'contact_scope_unavailable' | 'buyer_not_found' |
  'buyer_title_off' | 'buyer_uncorroborated' | 'read_failed'
export type BuyerSearchResult =
  | { status: 'held'; reason: Hold }
  | { status: 'buyer_proof'; buyer: { name: string; title: string; linkedin: string | null; proofUrls: string[] } }

const MAX_PAGES = 5
const held = (reason: Hold): BuyerSearchResult => ({ status: 'held', reason })
const fold = (v: string) => v.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
const sane = (x: unknown, max = 120): x is string => typeof x === 'string' && x.length <= max && !!x.trim() && !/[\p{C}]/u.test(x)
const former = /\b(?:former|formerly|previously|retired|emeritus|past|resigned|ex[- ]|until|interim)\b/i
const personName = (n: unknown): n is string => sane(n) &&
  /^\p{L}[\p{L}\p{M}'’.\-]*(?: +\p{L}[\p{L}\p{M}'’.\-]*)+$/u.test(n.normalize('NFKC'))
const LINKEDIN = /^https:\/\/(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/in\/([a-zA-Z0-9_-]{3,100})\/?$/
const ascii = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z]/g, '')

function httpsUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 500 || /[\s\\]/u.test(value)) return null
  try {
    const u = new URL(value)
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && u.href === value ? u : null
  } catch { return null }
}

// The role must be one the user reviewed. A combined title ("Founder & CEO")
// is split into its roles; each role may carry only a trailing scope
// qualifier after a comma, dash or bracket ("Head of Sales, EMEA"). Anything
// in front of the role ("Assistant to", "Deputy") makes it a different role.
const words = (s: string) => fold(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
function roleMatches(found: string, requested: ReadonlySet<string>): boolean {
  const wanted = new Set([...requested].map(words).filter(Boolean))
  const roles = fold(found).split(/\s*(?:&|\/|\band\b|\|)\s*/u)
  return roles.some(role => {
    const core = role.split(/\s*(?:,|\s[-–—]\s|\()/u)[0] ?? ''
    return wanted.has(words(core))
  })
}
// Accept only an explicit static card with one direct literal name heading and
// one distinct direct literal role. Never join sibling cards, inline fragments,
// prose, or model names/links. Static checks do not establish computed CSS.
// This is candidate proof only; it does not replace the canonical final verifier.
type HtmlNode=DefaultTreeAdapterMap['node']
type HtmlElement=DefaultTreeAdapterMap['element']
const kids=(x:HtmlNode):readonly HtmlNode[]=>'childNodes' in x?x.childNodes:[]
const element=(x:HtmlNode):x is HtmlElement=>'tagName' in x
const attribute=(x:HtmlElement,k:string)=>x.attrs.find(a=>a.name===k)?.value
const heading=/^h[1-6]$/
const stale=/\b(?:archive[ds]?|alumni|history|historical|past leadership|past team|former team)\b/i
const historical=(value:string)=>stale.test(value.replace(/[^\p{L}\p{N}]+/gu,' '))
const historicalContainer=(n:HtmlElement)=>['class','id','aria-label','data-status'].some(k=>historical(attribute(n,k)??''))
const opaque=(n:HtmlElement)=>/^(?:head|template|script|style|noscript|textarea|iframe|dialog|details|svg|math|object|embed|select|option|plaintext|xmp|noembed|noframes|del|s|strike)$/.test(n.tagName)||
  ['hidden','inert','style'].some(k=>attribute(n,k)!==undefined)||attribute(n,'aria-hidden')?.trim().toLowerCase()==='true'||
  /(?:^|\s)(?:hidden|invisible|sr-only|visually-hidden|screen-reader-only|d-none)(?:\s|$)/i.test(attribute(n,'class')??'')
function literalText(n:HtmlElement):string{
  const loc=n.sourceCodeLocation, contents=kids(n)
  if(!loc?.startTag||!loc.endTag||contents.length!==1||contents[0].nodeName!=='#text'||!('value' in contents[0]))return ''
  return contents[0].value.trim()
}
type RoleCard={name:string;title:string;linkedin:string|null}
const identityFold=(s:string)=>s.normalize('NFC').trim().replace(/\s+/g,' ').toLowerCase()
function cardContradiction(roots:readonly HtmlElement[]):boolean{
  // Direct semantic attributes and anchor contents can explicitly say the
  // displayed title is former. They can veto evidence, never supply proof.
  const work:HtmlNode[]=[...roots]
  let seen=0
  const contradicts=(v:string)=>former.test(v)||historical(v)
  while(work.length){
    if(++seen>128)return true
    const n=work.pop()!
    if(element(n)){
      if(opaque(n))continue
      if(['alt','title','aria-label','data-status'].some(k=>contradicts(attribute(n,k)??'')))return true
    }else if(n.nodeName==='#text'&&'value' in n&&contradicts(n.value))return true
    if(work.length+kids(n).length>128)return true
    for(const child of kids(n))work.push(child)
  }
  return false
}
function ownedRoleCard(html:unknown,name:string,title:string):RoleCard|null{
  if(typeof html!=='string'||html.length>128_000||Buffer.byteLength(html)>128_000)return null
  const doc=parse(html,{sourceCodeLocationInfo:true,scriptingEnabled:true})
  const wanted=identityFold(name), role=identityFold(title), matches:RoleCard[]=[]
  const walk:{node:HtmlNode;body:boolean}[]=[{node:doc,body:false}]
  let seen=0, conflicts=0
  while(walk.length){
    if(++seen>10_000)return null
    const {node,body}=walk.pop()!
    if(element(node)){
      if(node.tagName==='meta'&&attribute(node,'http-equiv')?.trim().toLowerCase()==='refresh')return null
      if(node.tagName==='base')return null
      if((opaque(node)&&node.tagName!=='head')||historicalContainer(node))continue
      if((node.tagName==='title'||(body&&heading.test(node.tagName)))&&historical(literalText(node)))return null
      if(body&&(node.tagName==='article'||node.tagName==='li')){
        const direct=kids(node).filter(element).filter(n=>!opaque(n))
        const names=direct.filter(n=>heading.test(n.tagName))
        if(names.some(n=>identityFold(literalText(n))===wanted)){
          conflicts++
          const values=direct.filter(n=>n.tagName==='p'||n.tagName==='span')
          // Contradictory or additional narrative about the named person is
          // not authority for current employment in this intentionally small lane.
          if(names.length===1&&values.length===1&&identityFold(literalText(values[0]))===role){
            const nonCardChildren=kids(node).some(n=>element(n)?!opaque(n)&&!heading.test(n.tagName)&&!/^(?:p|span|a|img)$/.test(n.tagName):
              n.nodeName==='#text'&&'value' in n&&!!n.value.trim())
            if(!nonCardChildren&&!cardContradiction(direct)){
              const links=new Set<string>()
              for(const link of direct.filter(n=>n.tagName==='a')){
                const label=identityFold(literalText(link)), href=attribute(link,'href'), loc=link.sourceCodeLocation?.attrs?.href
                if(label!==wanted&&label!==wanted+' on linkedin')continue
                if(!href||!loc||!LINKEDIN.test(href))continue
                const raw=html.slice(loc.startOffset,loc.endOffset)
                if(/^href\s*=\s*(["'])([^"'&<>]+)\1$/i.exec(raw)?.[2]===href)links.add(href)
              }
              matches.push({name:literalText(names[0]),title:literalText(values[0]),linkedin:links.size===1?[...links][0]:null})
            }
          }
        }
      }
    }
    const inBody=body||(element(node)&&node.tagName==='body')
    if(walk.length+kids(node).length>10_000)return null
    for(const child of kids(node))walk.push({node:child,body:inBody})
  }
  return conflicts===1&&matches.length===1?matches[0]:null
}

const FAILED = Symbol('read_failed')
// Like bounded, but a rejected or aborted dispatched read is a distinct
// failure: usage may be uncertain, so the stage stops instead of moving on.
function dispatched<T>(signal: AbortSignal, op: () => Promise<T>): Promise<T | typeof FAILED> {
  if (signal.aborted) return Promise.resolve(FAILED)
  return new Promise(resolve => {
    const abort = () => finish(FAILED)
    const finish = (v: T | typeof FAILED) => { signal.removeEventListener('abort', abort); resolve(v) }
    signal.addEventListener('abort', abort, { once: true })
    void Promise.resolve().then((): Promise<T | typeof FAILED> | typeof FAILED => signal.aborted ? FAILED : op()).then(finish, () => finish(FAILED))
  })
}
function bounded<T>(signal: AbortSignal, op: () => Promise<T>): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise(resolve => {
    const abort = () => finish(undefined)
    const finish = (v: T | undefined) => { signal.removeEventListener('abort', abort); resolve(v) }
    signal.addEventListener('abort', abort, { once: true })
    void Promise.resolve().then(() => signal.aborted ? undefined : op()).then(finish, () => finish(undefined))
  })
}

export async function proveCompanyFirstBuyerBySearch(
  finding: Finding | null,
  requestedTitles: readonly string[],
  scope: Scope,
  readers: BuyerSearchReaders,
  signalFromCaller?: AbortSignal,
): Promise<BuyerSearchResult> {
  if (!finding || finding.state !== 'signal_verified') return held('missing_signal_proof')
  const { name: company, site } = finding
  const origin = httpsUrl(site?.website + '/') ? new URL(site.website) : null
  if (!sane(company) || !origin || site.website!==origin.origin) return held('missing_signal_proof')
  if (!Array.isArray(requestedTitles) || requestedTitles.length > 12) return held('missing_requested_role')
  const roles = new Set(requestedTitles.filter((x): x is string => sane(x) && !former.test(x)).map(fold))
  if (!roles.size) return held('missing_requested_role')
  if (!sane(scope?.tenant) || !sane(scope?.job) || !sane(scope?.attempt)) return held('contact_scope_unavailable')
  const snap = Object.freeze({ tenant: scope.tenant, job: scope.job, attempt: scope.attempt })
  const deadline = AbortSignal.timeout(30_000)
  const abort = signalFromCaller ? AbortSignal.any([signalFromCaller, deadline]) : deadline
  const current = () => bounded(abort, () => readers.isCurrent(snap, finding))
  const permit = async (stage: BuyerSearchStage) => await current() === true &&
    await bounded(abort, () => readers.reserveBeforeDispatch({ scope: snap, stage, signal: abort })) === true

  if (!await permit('buyer_search')) return held('contact_scope_unavailable')
  const c = await dispatched(abort, () => readers.searchBuyer({ company, website: site.website, titles: [...roles] }, abort))
  if (await current() !== true) return held('contact_scope_unavailable')
  if (c===FAILED) return held('read_failed')
  if (!c || !personName(c.name) || fold(c.name) === fold(c.title ?? '')) return held('buyer_not_found')
  if (!sane(c.title) || former.test(c.title) || !roleMatches(c.title, roles)) return held('buyer_title_off')

  // Snapshot model proposal while reading untrusted public bytes asynchronously.
  const name=c.name,title=c.title
  const urls:URL[]=[]
  for(const s of Array.isArray(c.sources)?c.sources.slice(0,50):[]){
    const u=httpsUrl(s)
    if(!u||u.origin!==origin.origin||u.hash||urls.some(r=>r.href===u.href))continue
    urls.push(u)
    if(urls.length>=MAX_PAGES)break
  }
  for(const u of urls){
    if(!await permit('buyer_page'))return held('contact_scope_unavailable')
    const page=await dispatched(abort,()=>readers.readPage(u.href,abort))
    if(page===FAILED)return held('read_failed')
    if(await current()!==true)return held('contact_scope_unavailable')
    if(!page||page.url!==u.href)continue
    const card=ownedRoleCard(page.html,name,title)
    if(!card)continue
    let linkedin:string|null=null
    const proposed=card.linkedin, corroborate=readers.corroborateProfile
    if(proposed&&corroborate&&await permit('buyer_profile')){
      const profile=await dispatched(abort,()=>corroborate.call(readers,proposed,abort))
      if(profile!==FAILED&&profile&&profile.url===proposed&&profile.current===true&&
        sane(profile.name)&&identityFold(profile.name)===identityFold(card.name)&&
        sane(profile.title)&&identityFold(profile.title)===identityFold(card.title)&&
        sane(profile.company)&&identityFold(profile.company)===identityFold(company))linkedin=proposed
    }
    if(await current()!==true)return held('contact_scope_unavailable')
    return {status:'buyer_proof',buyer:{...card,linkedin,proofUrls:[u.href]}}
  }
  return held('buyer_uncorroborated')
}

// Shared/departmental mailboxes: never shown as a person's email.
const ROLE_LOCAL = new Set(['info', 'hello', 'hi', 'contact', 'contactus', 'enquiries', 'enquiry', 'inquiries', 'inquiry', 'sales',
  'business', 'office', 'admin', 'administrator', 'general', 'mail', 'team', 'support', 'help', 'agent', 'agents', 'helpdesk',
  'customerservice', 'customercare', 'care', 'service', 'services', 'assistance', 'press', 'media', 'pr', 'partnerships', 'partners',
  'bookings', 'booking', 'reservations', 'noreply', 'donotreply', 'donotrespond', 'careers', 'career', 'jobs', 'job', 'hiring',
  'recruiting', 'recruitment', 'talent', 'hr', 'people', 'billing', 'invoices', 'invoice', 'accounts', 'accounting', 'finance',
  'payments', 'orders', 'privacy', 'legal', 'compliance', 'security', 'abuse', 'webmaster', 'postmaster', 'hostmaster', 'feedback',
  'newsletter', 'news', 'marketing', 'events', 'community', 'social', 'investors', 'ir', 'founders', 'staff', 'all', 'inbox'])
export function isRoleMailbox(local: string): boolean {
  const base = local.toLowerCase().split('+', 1)[0]
  const key = base.replace(/[._-]/g, '').replace(/\d+$/, '')
  if (ROLE_LOCAL.has(key)) return true
  const segments = base.split(/[._-]+/)
  // A role plus a tag/branch/department does not become a person's mailbox.
  return segments.some((_, i) => i + 1 < segments.length && ROLE_LOCAL.has(segments.slice(0, i + 1).join('')))
}

const MAIL_LOCAL = String.raw`[a-z0-9]+(?:[._-][a-z0-9]+)*`
const MAIL_DOMAIN = String.raw`(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}`
const ADDRESS = new RegExp(String.raw`(?<![\p{L}\p{N}._%+@-])${MAIL_LOCAL}@${MAIL_DOMAIN}(?![\p{L}\p{N}_%+@-])`, 'giu')
const ADDRESS_LINE = new RegExp(String.raw`^(?:e-?mail[ \t]*:[ \t]*)?(${MAIL_LOCAL}@${MAIL_DOMAIN})$`, 'i')
function namedLocal(local: string, name: string): boolean {
  const words = name.trim().split(/\s+/).map(ascii)
  const first = words[0], last = words.at(-1)
  if (words.length < 2 || !first || !last || first.length < 2 || last.length < 2 || first === last) return false
  const key = local.toLowerCase().replace(/[._-]/g, '')
  return [first + last, last + first, first[0] + last, first + last[0], last + first[0]].includes(key)
}

// No forward scan: unknown text, a blank line, or a different card ends the
// association. A title may bridge one line only if it was independently
// verified for exactly this buyer. An address also published outside their
// own card is ambiguous, including a shared/footer address or a namesake.
export function findPublishedOwnDomainEmail(buyerName: string, ownPages: readonly PublicPage[], siteOrigin: string,
  verifiedTitle?: string): string | null {
  if (!personName(buyerName)) return null
  const site = httpsUrl(siteOrigin) ?? httpsUrl(siteOrigin + '/')
  if (!site) return null
  const hostDomain = getDomain(site.hostname, { allowPrivateDomains: true })
  if (!hostDomain || !Array.isArray(ownPages) || ownPages.length > MAX_PAGES) return null
  const found = new Map<string, string>(), outside = new Set<string>()
  const n = fold(buyerName)
  const title = sane(verifiedTitle) && !former.test(verifiedTitle) ? fold(verifiedTitle) : null
  for (const p of ownPages) {
    const u = httpsUrl(p?.url)
    if (!u || u.origin !== site.origin || typeof p.text !== 'string' || p.text.length > 200_000) continue
    const lines: string[] = p.text.split(/\r?\n/).map((l:string) => l.trim())
    const slots = new Set<number>()
    lines.forEach((line, i) => {
      const label = fold(line)
      if (label === n) slots.add(title && fold(lines[i + 1] ?? '') === title ? i + 2 : i + 1)
      else if (title && [',', '|', '-', '–', '—', ':'].some(sep => {
        const parts = label.split(sep).map(x => x.trim())
        return parts.length === 2 && parts[0] === n && parts[1] === title
      })) slots.add(i + 1)
    })
    lines.forEach((line, i) => {
      const approved = slots.has(i) ? ADDRESS_LINE.exec(line)?.[1] : undefined
      for (const literal of line.match(ADDRESS) ?? []) {
        const key = literal.toLowerCase()
        const [local, domain] = key.split('@')
        if (!local || !domain || getDomain(domain, { allowPrivateDomains: true }) !== hostDomain ||
            isRoleMailbox(local) || !namedLocal(local, buyerName)) continue
        if (approved === literal) found.set(key, literal)
        else outside.add(key)
      }
    })
  }
  const survivor = found.size === 1 ? [...found.entries()][0] : undefined
  return survivor && !outside.has(survivor[0]) ? survivor[1] : null
}
