// Company-first buyer proof by search (ported from the research runner).
// The search adapter (Claude Haiku web search through the existing client and
// spend reservation) only PROPOSES a person; nothing it says is trusted. A
// buyer is proven only by public pages we read ourselves: one page on the
// company's own site, or two pages on two independent outside domains, each
// naming the person, the requested role and (outside pages) the company.
// Email is separate and optional: a missing published email never holds a buyer.
import { getDomain } from 'tldts'
import type { Finding, Scope } from './company-first-evidence.ts'

export type BuyerSearchStage = 'buyer_search' | 'buyer_page'
export interface BuyerSearchCandidate {
  name: string
  title: string
  linkedin: string | null
  sources: readonly string[]
}
export interface PublicPage { url: string; text: string }
export interface BuyerSearchReaders {
  isCurrent(scope: Scope, finding: SignalFinding): Promise<boolean>
  reserveBeforeDispatch(request: { scope: Scope; stage: BuyerSearchStage; signal: AbortSignal }): Promise<boolean>
  // Proposal only. Must use the existing Claude client under the scan budget.
  searchBuyer(request: { company: string; website: string; titles: readonly string[] }, signal: AbortSignal): Promise<BuyerSearchCandidate | null>
  // Plain public page text for an exact https URL, or null.
  readPage(url: string, signal: AbortSignal): Promise<PublicPage | null>
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
const registrable = (u: URL) => getDomain(u.hostname, { allowPrivateDomains: true })

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
// A page proves the person+role only through one person-specific assertion:
// the name's own line, or the name line plus the line right after it (a team
// card "Name / Title"). Outside pages must name the company in that same
// assertion. Name and title in unrelated sections never count.
function pageNames(text: string, name: string, title: string, company: string | null): boolean {
  if (typeof text !== 'string' || text.length > 200_000) return false
  const lines = text.split(/\r?\n/).map(l => fold(l)).filter(Boolean)
  const n = fold(name), t = fold(title), c = company === null ? null : fold(company)
  return lines.some((line, i) => {
    if (!line.includes(n)) return false
    const own = line.includes(t) && (c === null || line.includes(c))
    // Team card on the company's own site: a line that is just the name,
    // followed by a line that starts with the title.
    const bare = line.replace(/[^\p{L}\p{M}\p{N}' .-]/gu, '').trim()
    const card = c === null && bare === n && (lines[i + 1] ?? '').startsWith(t)
    return own || card
  })
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
  if (!sane(company) || !origin) return held('missing_signal_proof')
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
  const c = await bounded(abort, () => readers.searchBuyer({ company, website: site.website, titles: [...roles] }, abort))
  if (await current() !== true) return held('contact_scope_unavailable')
  if (!c || !personName(c.name) || fold(c.name) === fold(c.title ?? '')) return held('buyer_not_found')
  if (!sane(c.title) || former.test(c.title) || !roleMatches(c.title, roles)) return held('buyer_title_off')

  const ownDomain = registrable(origin)
  // Own-site means the exact verified origin, not any host under its domain.
  const isOwn = (u: URL) => u.origin === origin.origin
  const all: URL[] = []
  for (const s of Array.isArray(c.sources) ? c.sources.slice(0, 50) : []) {
    const u = httpsUrl(s)
    if (!u || /(^|\.)linkedin\.com$/i.test(u.hostname) || all.some(x => x.href === u.href)) continue
    // Other hosts under the company domain are neither own-site nor independent.
    if (!isOwn(u) && registrable(u) === ownDomain) continue
    all.push(u)
  }
  // Prioritize own-site pages over the whole list, then cap the paid reads.
  const urls = [...all.filter(isOwn), ...all.filter(u => !isOwn(u))].slice(0, MAX_PAGES)
  const outside = new Map<string, string>()
  for (const u of urls) {
    if (!await permit('buyer_page')) return held('contact_scope_unavailable')
    const page = await dispatched(abort, () => readers.readPage(u.href, abort))
    if (page === FAILED) return held('read_failed')
    if (await current() !== true) return held('contact_scope_unavailable')
    if (!page || page.url !== u.href) continue
    const dom = registrable(u)
    if (!dom) continue
    if (isOwn(u)) {
      if (pageNames(page.text, c.name, c.title, null)) return proven(c, [u.href])
    } else if (!outside.has(dom) && pageNames(page.text, c.name, c.title, company)) {
      outside.set(dom, u.href)
      if (outside.size >= 2) return proven(c, [...outside.values()].slice(0, 2))
    }
  }
  return held('buyer_uncorroborated')
}

function proven(c: BuyerSearchCandidate, proofUrls: string[]): BuyerSearchResult {
  // LinkedIn is shown only when its slug carries the person's first or last name.
  let linkedin: string | null = null
  const m = typeof c.linkedin === 'string' ? LINKEDIN.exec(c.linkedin) : null
  if (m) {
    const slug = ascii(m[1]), words = c.name.trim().split(/\s+/).map(ascii).filter(w => w.length >= 2)
    if (words.some(w => slug.includes(w))) linkedin = c.linkedin
  }
  return { status: 'buyer_proof', buyer: { name: c.name, title: c.title, linkedin, proofUrls } }
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
  return ROLE_LOCAL.has(local.toLowerCase().replace(/[._+-]/g, ''))
}

const ADDRESS = /(?<![\p{L}\p{N}._%+@-])[a-z0-9]+(?:[._-][a-z0-9]+)*@[a-z0-9.-]+\.[a-z]{2,}(?![\p{L}\p{N}_%+@-])/giu
const HAS_ADDRESS = new RegExp(ADDRESS.source, 'iu')
function namedLocal(local: string, name: string): boolean {
  const words = name.trim().split(/\s+/).map(ascii)
  const first = words[0], last = words.at(-1)
  if (words.length < 2 || !first || !last || first.length < 2 || last.length < 2 || first === last) return false
  const key = local.toLowerCase().replace(/[._-]/g, '')
  return [first + last, last + first, first[0] + last, first + last[0], last + first[0]].includes(key)
}

// Returns an address only if it is literally published on a page of the
// company's exact verified origin, on the company's own domain, is not a role
// mailbox, matches the person's full name, and sits in the buyer's own block
// (the name line and the few lines after it, before another person). A
// mailbox that could belong to a namesake on the same page is held.
export function findPublishedOwnDomainEmail(buyerName: string, ownPages: readonly PublicPage[], siteOrigin: string): string | null {
  if (!personName(buyerName)) return null
  const site = httpsUrl(siteOrigin) ?? httpsUrl(siteOrigin + '/')
  if (!site) return null
  const hostDomain = getDomain(site.hostname, { allowPrivateDomains: true })
  if (!hostDomain) return null
  const found = new Set<string>()
  const n = fold(buyerName)
  for (const p of Array.isArray(ownPages) ? ownPages : []) {
    const u = httpsUrl(p?.url)
    if (!u || u.origin !== site.origin || typeof p.text !== 'string' || p.text.length > 200_000) continue
    const text: string = p.text
    const lines: string[] = text.split(/\r?\n/).map((l: string) => l.normalize('NFKC').trim()).filter(Boolean)
    const people: string[] = lines.map((l: string) => (l.split(/[,|–—-]/)[0] ?? '').trim()).filter((l: string) => personName(l) && l.length <= 60)
    lines.forEach((line: string, i: number) => {
      if (!fold(line).includes(n)) return
      for (let j = i; j < Math.min(lines.length, i + 4); j++) {
        // Stop at the next person's card.
        if (j > i && fold(lines[j]) !== n && people.includes(lines[j]) && lines.slice(j + 1, j + 2).some(x => !HAS_ADDRESS.test(x) && x.length <= 60)) break
        for (const raw of lines[j].match(ADDRESS) ?? []) {
          const addr = raw.toLowerCase().replace(/\.$/, '')
          const [local, domain] = addr.split('@')
          if (!local || !domain || getDomain(domain, { allowPrivateDomains: true }) !== hostDomain) continue
          if (isRoleMailbox(local) || !namedLocal(local, buyerName)) continue
          // Held if any other named person on the page could own this mailbox.
          if (people.some(other => fold(other) !== n && namedLocal(local, other))) continue
          found.add(addr)
        }
      }
    })
  }
  return found.size === 1 ? [...found][0] : null
}
