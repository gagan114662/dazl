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
  'buyer_title_off' | 'buyer_uncorroborated'
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

// The role must be one the user reviewed: equal, or the reviewed role appears
// as whole words inside the found title (e.g. "VP Sales" in "VP Sales, EMEA").
function roleMatches(found: string, requested: ReadonlySet<string>): boolean {
  const f = ` ${fold(found).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `
  for (const r of requested) {
    const w = fold(r).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    if (w && (f.trim() === w || f.includes(` ${w} `))) return true
  }
  return false
}
// A page proves the person+role only if both appear in the visible text.
function pageNames(text: string, name: string, title: string, company: string | null): boolean {
  if (typeof text !== 'string' || text.length > 200_000) return false
  const t = fold(text)
  return t.includes(fold(name)) && t.includes(fold(title)) && (company === null || t.includes(fold(company)))
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
  const urls: URL[] = []
  for (const s of Array.isArray(c.sources) ? c.sources : []) {
    const u = httpsUrl(s)
    if (!u || /(^|\.)linkedin\.com$/i.test(u.hostname) || urls.some(x => x.href === u.href)) continue
    urls.push(u)
    if (urls.length >= MAX_PAGES) break
  }
  // Own-site pages first: one is enough.
  urls.sort((a, b) => Number(registrable(b) === ownDomain) - Number(registrable(a) === ownDomain))
  const outside = new Map<string, string>()
  for (const u of urls) {
    if (!await permit('buyer_page')) return held('contact_scope_unavailable')
    const page = await bounded(abort, () => readers.readPage(u.href, abort))
    if (await current() !== true) return held('contact_scope_unavailable')
    if (!page || page.url !== u.href) continue
    const dom = registrable(u)
    if (!dom) continue
    if (dom === ownDomain) {
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
function namedLocal(local: string, name: string): boolean {
  const words = name.trim().split(/\s+/).map(ascii)
  const first = words[0], last = words.at(-1)
  if (words.length < 2 || !first || !last || first.length < 2 || last.length < 2 || first === last) return false
  const key = local.toLowerCase().replace(/[._-]/g, '')
  return [first + last, last + first, first[0] + last, first + last[0], last + first[0], first].includes(key) && key.length >= 3
}

// Returns an address only if it is literally published on a page of the
// company's own site, on the company's own domain, is not a role mailbox, and
// clearly belongs to the named person. Ambiguity (two candidates) is held.
export function findPublishedOwnDomainEmail(buyerName: string, ownPages: readonly PublicPage[], siteHost: string): string | null {
  if (!personName(buyerName) || !sane(siteHost, 253)) return null
  const host = siteHost.toLowerCase().replace(/^www\./, '')
  const hostDomain = getDomain(host, { allowPrivateDomains: true })
  const found = new Set<string>()
  for (const p of Array.isArray(ownPages) ? ownPages : []) {
    const u = httpsUrl(p?.url)
    if (!u || !hostDomain || getDomain(u.hostname, { allowPrivateDomains: true }) !== hostDomain || typeof p.text !== 'string') continue
    for (const raw of p.text.match(ADDRESS) ?? []) {
      const addr = raw.toLowerCase().replace(/\.$/, '')
      const [local, domain] = addr.split('@')
      if (!local || !domain || getDomain(domain, { allowPrivateDomains: true }) !== hostDomain) continue
      if (isRoleMailbox(local) || !namedLocal(local, buyerName)) continue
      found.add(addr)
    }
  }
  return found.size === 1 ? [...found][0] : null
}
