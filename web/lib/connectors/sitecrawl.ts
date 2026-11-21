import { COMPANY_FIRST_ROLE_LABEL, recordCompanyFirstPublishedDisplay, withdrawCompanyFirstPublishedDisplay } from '../people/company-first-published-display.ts'
import { hasCompanyFirstBudget } from '../company-first/product-discovery.ts'
import { strictOwnContactCards } from './strict-own-contacts.ts'
import { currentReviewedDomain, domainRelationship } from '../signals/domain-basis.ts'
import { listedProfileLabel, listedProfileUrl, profileFromListedLabel } from '../people/site-profile.ts'
import { looksLikeJobTitle } from '../people/job-title-name.ts'
import {contactContext,contextLabel} from '../outreach/contact-context.ts'
import https from 'node:https'
import zlib from 'node:zlib'
import { Transform, type Readable } from 'node:stream'
import type Database from 'better-sqlite3'
import robotsParser from 'robots-parser'
import { getDomain } from 'tldts'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { social } from '@crawlee/utils'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { guardedLookup, isPublicIp } from '../scan/fetch-page.ts'
import { audit, addEnrichment, recordCrawlPage, type Enrichment } from './store.ts'
import { DOMAIN_UNRESOLVED_KIND, DOMAIN_UNRESOLVED_TOKEN } from './domain-unresolved.ts'
export { DOMAIN_UNRESOLVED_KIND, DOMAIN_UNRESOLVED_TOKEN, domainUnresolvedWords } from './domain-unresolved.ts'
import { detectTech, observability, type Observability, type TechHit } from './techstack.ts'
import { TECH_SCAN_KIND, TECH_CHANGE_KIND, encodeScan, decodeScan, techChanges, changeRow, scanOf, isScanDomain, type TechScan } from '../signals/tech-observations.ts'
import { publishedDisplayCountry, recordPublishedDisplay, withdrawPublishedDisplay } from '../people/published-display.ts'
import { qaClaudeOnlyJob } from '../scan/qa-provider-policy.ts'
import { personalAddresses, publishedCandidateFor, recordEmailGuesses, usEvidence, type AddressContext } from '../people/email-pattern.ts'
import { revealEmails } from '../people/email-reveal.ts'
import { SEARCHABLE_HOLDS } from '../people/searchable-holds.ts'
import { jobBoardSlugs, slugDomains, EVENT_OVER_HOLDS } from './job-board-slug.ts'
import { atsPostingRef } from '../sources/ats-posting.ts'
import { atsGtmBoard } from '../signals/ats-gtm.ts'
import { roleContradicted, roleEndedByDate, titleMatches } from '../people/rank.ts'
import { placeAgreement, cityScoped, geoTerms, ownProbePlace, US_STATES } from '../scan/place-agreement.ts'
import { isCountryOrRegion, resolveSegment, regionOf, trimCanadianPostalTail } from '../scan/countries.ts'
import { candidateDomainSuffixes, countryDomainHints } from './country-domain-hints.ts'
import { addressAgreement, streetKeys, firstPlaceLabel, leadPlaceLabel, recordContactRejection } from '../scan/contact-agreement.ts'

// Contact-page crawl. No key. For a verified lead it finds the company's own website, reads a handful of
// contact/about pages and keeps only business contacts the company itself published there.
// Rules: https only; robots.txt is obeyed (unreachable robots = do not crawl); one request per 2 s per host;
// at most 5 pages per site; the site is linked from the page that evidenced the lead, or probed from the
// company name and accepted only when the homepage itself names the company (never trusted by guess alone);
// no guessed or pattern-built addresses; only role mailboxes (info@, sales@...) on the company's own domain;
// every contact stores the exact page URL it came from and the retrieval date, so the basis is auditable.
export const UA = 'dazl-contact-check/1.0 (+https://dazl.ai/bot)'
const TOKENS = ['dazl-contact-check', 'dazl']
const MAX_PAGES = 5
const MAX_BYTES = 800_000
const TIMEOUT_MS = 10_000
// #1037: 20 (was 8). With the leads read a few at a time (crawlConcurrency), 20 sites fit the same post-finish window that 8 used to fill
// one after another; the 9th-and-later leads of a scan used to get no website check, so no named person, at all.
export const MAX_SITES_PER_SCAN = Number(process.env.SITECRAWL_MAX_SITES || 20)
// #1037: how many leads' sites are read at once. Bounded 1..6; an unparseable value is the default. 1 is the old one-after-another order.
export const CRAWL_CONCURRENCY_DEFAULT = 4
export function crawlConcurrency(explicit?: number, fallback?: number, env: Record<string, string | undefined> = process.env): number {
  const raw = explicit ?? fallback ?? Number(env.SITECRAWL_CONCURRENCY ?? CRAWL_CONCURRENCY_DEFAULT)
  return Number.isFinite(raw) && raw >= 1 ? Math.min(6, Math.floor(raw)) : CRAWL_CONCURRENCY_DEFAULT
}
const GAP_MS = Number(process.env.SITECRAWL_GAP_MS ?? 2000)
// Intrinsic per-site crawl bound (#871): robots + home + up to MAX_PAGES pages under the polite gap must fit.
const CRAWL_BUDGET_MS = (() => { const n = Number(process.env.SITECRAWL_CRAWL_BUDGET_MS ?? 45_000); return Number.isFinite(n) && n > 0 ? n : 45_000 })()
// The crawl budget is ALWAYS a finite positive bound (#871): an invalid or non-positive value is the default, never a disable.
export const crawlBudgetBound = (ms: number): number => Number.isFinite(ms) && ms > 0 ? ms : CRAWL_BUDGET_MS

export const sitecrawlEnabled = (env: Record<string, string | undefined> = process.env) => env.SITECRAWL_ENABLED !== '0'

// opts.signal: the caller's abort (and the crawl's own deadline, #871) handed to the fetch itself, so a timed-out or
// aborted crawl CANCELS the native operation instead of abandoning a running socket. A Get that ignores it is still
// bounded by the crawl's own race, but production Gets (rawGet, crawl4ai) honor it.
type GetResult = { status: number; body: string; finalUrl: string; text?: string; redirect?: string }
export type Get = (url: string, opts?: { signal?: AbortSignal; noRedirect?: boolean }) => Promise<GetResult | null>

// #1122: a page's visible text, in ONE linear pass (no backtracking pattern: a page of unclosed "<script" or "<" must not cost quadratic time,
// as /<(script|style)[\s\S]*?<\/\1>/ and /<[^>]+>/ do - measured 22 s and 53 s on 800 KB of "<script "). Script, style, noscript, svg and
// template blocks and HTML comments are dropped; every tag becomes a space; whitespace is collapsed.
const SKIP_BLOCK = new Set(['script', 'style', 'noscript', 'svg', 'template'])
export function plainText(html: string, max = 200_000): string {
  const out: string[] = []; let len = 0, i = 0; const unclosed = new Set<string>()
  const low = html.replace(/[A-Z]/g, c => c.toLowerCase())   // same length (ASCII only), so offsets match
  while (i < html.length && len < max) {
    const lt = html.indexOf('<', i)
    const end = lt < 0 ? html.length : lt
    if (end > i) { const piece = html.slice(i, end); out.push(piece); len += piece.length }
    if (lt < 0) break
    if (low.startsWith('<!--', lt)) { const c = html.indexOf('-->', lt + 4); i = c < 0 ? html.length : c + 3; out.push(' '); continue }
    const gt = html.indexOf('>', lt + 1)
    if (gt < 0) break
    const name = /^<\/?\s*([a-z0-9-]+)/.exec(low.slice(lt, Math.min(gt + 1, lt + 40)))?.[1] ?? ''
    i = gt + 1
    // a block is skipped only when it is OPENED (not "<svg .../>", not a closing tag) AND closed later; an unclosed one keeps the rest of the page
    // (council: a self-closing <svg/> used to swallow everything after it, hiding a namesake's out-of-state address from the place check)
    if (SKIP_BLOCK.has(name) && low[lt + 1] !== '/' && html[gt - 1] !== '/' && !unclosed.has(name)) { const close = low.indexOf(`</${name}`, i); if (close >= 0) i = html.indexOf('>', close) + 1 || html.length; else unclosed.add(name) }   // a name never closed later is not searched for again (linear)
    out.push(' ')
  }
  return out.join('').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, max)
}
// A page larger than MAX_BYTES (a site builder's homepage can be 2 MB of inline styling, with the address in its footer) is still read for its
// TEXT up to TEXT_BYTES: the stored body stays capped at MAX_BYTES (what every extractor reads, unchanged), and its visible text, from the whole
// read, is returned beside it (`text`) for the homepage name and place checks.
const TEXT_BYTES = 4_000_000

// timeoutMs/lookup are injectable for tests only; production callers use the
// defaults. Lookup defaults to the SSRF-guarded resolver (private IPs refused).
// 'deflate' is zlib-wrapped by the spec, but some servers send raw deflate under that name (review): the first two bytes tell them apart (a zlib header is a
// multiple of 31 with method 8). Decided on the first chunk; either way the same limits and handlers apply.
function inflateEitherWay(): Transform {
  let inner: zlib.Inflate | zlib.InflateRaw | null = null
  const t: Transform = new Transform({
    transform(chunk: Buffer, _e, cb) {
      if (!inner) {
        const wrapped = chunk.length >= 2 && (chunk[0] & 0x0f) === 8 && ((chunk[0] << 8) | chunk[1]) % 31 === 0
        inner = wrapped ? zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH }) : zlib.createInflateRaw({ finishFlush: zlib.constants.Z_SYNC_FLUSH })
        inner.on('data', (d: Buffer) => t.push(d)); inner.on('error', (e: Error) => t.destroy(e))
      }
      inner.write(chunk, () => cb())
    },
    flush(cb) { if (!inner) return cb(); inner.once('end', () => cb()); inner.end() },
    destroy(err, cb) { inner?.destroy(); cb(err) },
  })
  return t
}
export function rawGet(rawUrl: string, hops = 0, timeoutMs = TIMEOUT_MS, lookup: typeof guardedLookup = guardedLookup, signal?: AbortSignal, noRedirect = false): Promise<GetResult | null> {
  return new Promise(resolveRaw => {
    // Absolute per-request timer (the socket timeout below is inactivity-only: a slow drip never trips it).
    let hard: NodeJS.Timeout | undefined = undefined
    const resolve = (v: GetResult | null | Promise<GetResult | null>) => { clearTimeout(hard); resolveRaw(v as never) }
    let u: URL
    try { u = new URL(rawUrl) } catch { return resolve(null) }
    if (u.protocol !== 'https:' || u.username || u.password || hops > 2) return resolve(null)
    const chunks: Buffer[] = []; let n = 0, readSoFar: () => { status: number; body: string; finalUrl: string; text?: string } | null = () => null
    const req = https.request(u, { method: 'GET', lookup: lookup as never, timeout: timeoutMs, headers: { 'user-agent': UA, accept: 'text/html,text/plain;q=0.9', 'accept-encoding': 'identity' } }, res => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        if (noRedirect) {
          const location = String(res.headers.location)
          return resolve({ status, body: '', finalUrl: u.href, ...(location.length <= 500 ? { redirect: location } : {}) })
        }
        let next: URL
        try { next = new URL(String(res.headers.location), u) } catch { return resolve(null) }
        if (next.hostname.replace(/^www\./, '') !== u.hostname.replace(/^www\./, '')) return resolve(null) // stay on the same site
        return resolve(rawGet(next.toString(), hops + 1, timeoutMs, lookup, signal))
      }
      if (!/^text\/(html|plain)|application\/xhtml/i.test(String(res.headers['content-type'] ?? ''))) { res.destroy(); return resolve({ status, body: '', finalUrl: u.toString() }) }
      const done = () => { const all = Buffer.concat(chunks); const body = all.subarray(0, MAX_BYTES).toString('utf8'); return all.length > MAX_BYTES ? { status, body, finalUrl: u.toString(), text: plainText(all.toString('utf8')) } : { status, body, finalUrl: u.toString() } }
      readSoFar = () => (n >= MAX_BYTES ? done() : null)
      // Some servers compress the body even though this request asks for 'identity' (prod mxprod5: ogletree.com answers gzip). Read raw, those bytes reached the
      // company-name check as binary, the company's own site was refused (name_mismatch) and a lead with a proven day was held at no_domain. The body is decoded
      // here, and the same limits count DECODED bytes, so a small compressed body cannot expand past them. An unknown encoding is not read.
      const enc = String(res.headers['content-encoding'] ?? '').trim().toLowerCase()
      const decoder = !enc || enc === 'identity' ? null : enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH }) : enc === 'deflate' ? inflateEitherWay() : enc === 'br' ? zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH }) : undefined
      if (decoder === undefined) { res.destroy(); return resolve({ status, body: '', finalUrl: u.toString() }) }
      const src: Readable = decoder ? res.pipe(decoder) : res
      const stop = () => { res.destroy(); decoder?.destroy() }
      src.on('data', (c: Buffer) => { n += c.length; if (n > TEXT_BYTES) { stop(); resolve(done()) } else chunks.push(c) })
      src.on('end', () => resolve(done()))
      src.on('error', () => { const kept = chunks.length ? done() : null; stop(); resolve(kept) })   // a truncated compressed tail keeps what was decoded; the socket is closed (review)
      res.on('error', () => { stop(); resolve(null) })
      res.on('close', () => { if (!decoder) resolve(null) }) // no-op once already settled; with a decoder, its own end/error settles
    })
    hard = setTimeout(() => { req.destroy(new Error('timeout')); resolve(readSoFar()) }, timeoutMs)   // past the stored-body cap, a slow tail never costs the page (council)
    // Destroy WITH an error: relying on plain destroy() to surface an 'error'
    // event is observed Node behavior, not a documented guarantee - a silent
    // destroy would leave this promise pending forever, and the caller's
    // caller (runJob) holds a runner slot until this settles.
    req.on('timeout', () => req.destroy(new Error('timeout')))
    // Cooperative cancellation: an aborted signal destroys the socket with an
    // error, so the promise settles NOW - the slot budget can then be released
    // with no uncancelled request still in flight behind it.
    if (signal?.aborted) { resolve(null); req.destroy(new Error('aborted')); return }
    signal?.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
    req.on('error', () => resolve(null))
    req.end()
  })
}


// ---- optional Crawl4AI sidecar (Apache-2.0 + attribution, see NOTICE). Renders JavaScript pages. ----
// Set CRAWL4AI_URL (e.g. http://127.0.0.1:11235). Page requests go to its POST /crawl with check_robots_txt on; we still
// run our own robots.txt check first, and we only ever send it hostnames that resolve to public addresses.
async function publicHost(host: string): Promise<boolean> {
  try { const a = await dnsLookup(host, { all: true }); return a.length > 0 && a.every(x => isPublicIp(x.address)) } catch { return false }
}
export function crawl4aiGet(base: string, fetchImpl: typeof fetch = fetch, hostOk: (h: string) => Promise<boolean> = publicHost): Get {
  const endpoint = base.replace(/\/$/, '') + '/crawl'
  return async (url, opts) => {
    if (opts?.noRedirect) return null // renderer cannot provide this guarantee
    let u: URL; try { u = new URL(url) } catch { return null }
    if (u.protocol !== 'https:' || !(await hostOk(u.hostname))) return null
    if (u.pathname === '/robots.txt') return rawGet(url, 0, TIMEOUT_MS, guardedLookup, opts?.signal) // plain text, no rendering needed
    try {
      const res = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ urls: [url], crawler_config: { type: 'CrawlerRunConfig', params: { check_robots_txt: true, page_timeout: 20000 } } }), signal: opts?.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(40_000)]) : AbortSignal.timeout(40_000) })
      if (!res.ok) return null
      const j = (await res.json()) as { results?: { url?: string; html?: string; status_code?: number; success?: boolean; redirected_url?: string }[] }
      const r = j.results?.[0]; if (!r) return null
      const status = r.status_code ?? (r.success ? 200 : 0)
      const hasSource = Object.hasOwn(r, 'url')
      // Crawl4AI serializes an ordinary unredirected result with null here.
      const hasRedirect = Object.hasOwn(r, 'redirected_url') && r.redirected_url !== null
      const validRendererUrl = (value: unknown): value is string => {
        if (typeof value !== 'string' || !value || value !== value.trim()) return false
        try {
          const target = new URL(value)
          return target.protocol === 'https:' && !target.username && !target.password && !target.port &&
            target.hostname.replace(/^www\./, '') === u.hostname.replace(/^www\./, '')
        } catch { return false }
      }
      if ((hasSource && !validRendererUrl(r.url)) || (hasRedirect && !validRendererUrl(r.redirected_url))) return null
      // Legacy ordinary readers may omit both fields. Never infer the final
      // URL when they report a redirect without usable redirect metadata.
      if (status >= 300 && status < 400 && !hasRedirect) return null
      const finalUrl = r.redirected_url ?? r.url ?? url
      return { status, body: String(r.html ?? '').slice(0, MAX_BYTES), finalUrl }
    } catch { return null }
  }
}
export const defaultGet = (env: Record<string, string | undefined> = process.env, nativeOnly = false): Get => {
  const sidecar = !nativeOnly && env.CRAWL4AI_URL ? crawl4aiGet(env.CRAWL4AI_URL) : null
  return (url, opts) => sidecar && !opts?.noRedirect ? sidecar(url, opts)
    : rawGet(url, 0, TIMEOUT_MS, guardedLookup, opts?.signal, opts?.noRedirect)
}

// ---- robots.txt: parsed by robots-parser (MIT, the parser Crawlee uses). We obey the group for our own token and for "dazl". ----
export interface Robots { allows: (path: string, site?: string) => boolean; delayMs: number }
export function parseRobots(text: string, site = 'example.com'): Robots {
  const rp = robotsParser(`https://${site}/robots.txt`, text)
  const delay = Math.min(10, Math.max(Number(rp.getCrawlDelay(TOKENS[0]) ?? 0), Number(rp.getCrawlDelay(TOKENS[1]) ?? 0), Number(rp.getCrawlDelay('*') ?? 0)))
  return { delayMs: (Number.isFinite(delay) ? delay : 0) * 1000, allows: (path, s = site) => TOKENS.every(t => rp.isAllowed(`https://${s}${path}`, t) !== false) }
}

// ---- finding the company's own site: a domain linked from the evidence page whose name matches the company ----
const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and').replace(/\b(inc|ltd|llc|limited|gmbh|ag|sa|sl|corp|corporation|co|company|plc|pty|group|holdings|the)\b/g, ' ').replace(/[^a-z0-9]+/g, '')
const SOCIAL = /(^|\.)(facebook|instagram|linkedin|twitter|x|youtube|tiktok|wikipedia|google|bing|apple|medium|github|crunchbase|pitchbook|glassdoor|indeed|bloomberg|reuters|techcrunch|forbes|yelp|tripadvisor|eventbrite|wa|t|bit|goo|lnkd)\.[a-z.]+$/i

const registrable = (host: string) => { const h = host.toLowerCase().replace(/^www\./, ''); return getDomain(h) ?? h }
const nameLabel = (host: string) => registrable(host).split('.').slice(0, -1).join('')
// A host that can be a company's website: a DNS name with at least two labels. Never an IP literal (the resolver guard that refuses private
// addresses only runs for names: https.request skips `lookup` for an IP), never a single label ("localhost").
export const siteHostOk = (host: string) => { const h = host.replace(/^\[|\]$/g, ''); return !!h && isIP(h) === 0 && h.includes('.') && !/^\d+(\.\d+)*$/.test(h) && !h.endsWith('.') && !/[^a-z0-9.-]/i.test(h) && !/(^|\.)0x[0-9a-f]*(\.|$)/i.test(h) && !h.split('.').every(p => /^(0x[0-9a-f]+|0[0-7]*|\d+)$/i.test(p)) }   // also no hex / octal / numeric label forms of an address, whatever the caller normalised
const labelMatches = (label: string, want: string) => label.length >= 4 && (label === want || (want.startsWith(label) && label.length >= 6) || (label.startsWith(want) && want.length >= 6))

// One uninterrupted, directly visible publisher text block, not a company name
// at the end of a larger name or markup spanning unrelated directory entries.
const tidyCitationText = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
type CitationClaim = { company: string; evidence_excerpt?: string | null }
function citationClaim(row: CitationClaim): { host: string; quote: string } | null {
  const quote = tidyCitationText(row.evidence_excerpt ?? '')
  const name = tidyCitationText(row.company)
  const prefix = name + ' ('
  if (name.length < 4 || quote.length < 30 || quote.length > 1000 || !quote.startsWith(prefix)) return null
  const close = quote.indexOf(')', prefix.length)
  return close > prefix.length ? { host: quote.slice(prefix.length,close).replace(/^www\./,''), quote } : null
}
function publisherNamesCitedSite(html: string, quote: string): boolean {
  // Use only the full bounded body captured by the same existing site crawl.
  // No JS rendering or unbudgeted retrieval of styling/other subresources.
  if (Buffer.byteLength(html) >= MAX_BYTES) return false
  type Node = DefaultTreeAdapterMap['node']
  type Element = DefaultTreeAdapterMap['element']
  const attr = (n: Element, name: string) => n.attrs.find(a => a.name === name)?.value
  const hidden = (n: Element) =>
    ['hidden','inert','style'].some(a => attr(n,a) !== undefined) ||
    attr(n,'aria-hidden')?.trim().toLowerCase() === 'true' ||
    /(?:^|\s)(?:hidden|invisible|sr-only|visually-hidden|screen-reader-only|d-none|is-hidden)(?:\s|$)/i.test(attr(n,'class') ?? '')
  const inline = /^(?:span|b|strong|i|em|small|abbr|mark|sub|sup|code|u|s|br)$/
  const blockMatches = (block: Element) => {
    if (block.childNodes.length > 128) return false
    const pending: Node[] = [...block.childNodes].reverse()
    let chunks = '', traversed = 0
    while (pending.length) {
      if (++traversed > 128 || pending.length > 128) return false
      const n = pending.pop()!
      if ('value' in n) {
        if (n.value.length + chunks.length > 1500) return false
        chunks += n.value
      } else if ('tagName' in n && inline.test(n.tagName) && !hidden(n)) {
        if (n.tagName === 'br') chunks += ' '
        for (let i=n.childNodes.length-1;i>=0;i--) pending.push(n.childNodes[i])
      } else return false // never join across a nested block, unknown or concealed content
    }
    return tidyCitationText(chunks) === quote
  }
  const pending: { node: Node; blocked: boolean; body: boolean }[] = [{ node:parse(html), blocked:false, body:false }]
  let seen = 0, matched = false
  while (pending.length) {
    if (++seen > 12_000 || pending.length > 12_000) return false
    const { node, blocked, body } = pending.pop()!
    let excluded = blocked, inBody = body
    if ('tagName' in node) {
      const tag = node.tagName
      inBody ||= tag === 'body'
      // Inline/global CSS can hide any chosen node; external/global dynamic
      // rules are not inspectable from a bounded HTML-only capture. Refuse
      // unknown visibility, including styles declared AFTER the quote.
      if (node.attrs.some(a => /^on[a-z]/i.test(a.name)) || tag === 'style' || (tag === 'link' && /(?:^|\s)stylesheet(?:\s|$)/i.test(attr(node,'rel') ?? '')) ||
        (tag === 'script' && !/^(?:application\/(?:json|ld\+json))$/i.test(attr(node,'type') ?? ''))) return false
      excluded ||= hidden(node) || /^(?:head|script|style|noscript|template|svg|iframe|textarea|select|button|details|dialog)$/.test(tag)
      if (!excluded && inBody && /^(?:p|li|td|dd)$/.test(tag) && blockMatches(node)) matched = true
    }
    if ('childNodes' in node) for (const child of node.childNodes) pending.push({ node:child, blocked:excluded, body:inBody })
  }
  return matched
}

// Candidate company websites, strongest first. All come from evidence we already hold, never from guessing:
// (1) the evidence page is itself on the company's domain; (2) a link on it whose domain name matches the company;
// (3) a link whose visible text names the company. The crawl then checks the homepage really names the company.
export type DomainBasis = 'evidence_own_domain' | 'evidence_link_domain_label' | 'evidence_link_text' | 'name_probe'
export function findCompanySitesWithBasis(company: string, evidenceHtml: string, evidenceUrl: string): { site: string; basis: DomainBasis; structured?: boolean }[] {
  const want = norm(company); if (want.length < 4) return []
  let base: URL; try { base = new URL(evidenceUrl) } catch { return [] }
  const own = registrable(base.hostname)
  const out: { site: string; basis: DomainBasis; structured?: boolean }[] = []
  const push = (site: string, basis: DomainBasis) => { if (!out.some(o => o.site === site)) out.push({ site, basis }) }
  if (!SOCIAL.test(own) && labelMatches(nameLabel(base.hostname), want)) push(own, 'evidence_own_domain')
  const byText: string[] = []
  for (const m of evidenceHtml.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    let u: URL; try { u = new URL(m[1].replace(/&amp;/g, '&'), base) } catch { continue }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue
    const host = registrable(u.hostname)
    if (host === own || SOCIAL.test(host) || !siteHostOk(host)) continue   // never an IP literal or a single label: the private-address guard only runs for names
    if (labelMatches(nameLabel(host), want)) push(host, 'evidence_link_domain_label')
    else if (norm(m[2].replace(/<[^>]+>/g, ' ')).includes(want) && want.length >= 5) byText.push(host)
  }
  for (const h of byText) push(h, 'evidence_link_text')
  // #1122: a job board or directory page often names the employer's site only in its structured data (JobPosting.hiringOrganization,
  // Organization / LocalBusiness: url or sameAs). Such a host is a CANDIDATE, not a link the page shows: it is marked `structured`, so its
  // refusal never stops the name guesses or the web search (crawlJob).
  const anchors = out.length
  for (const h of jsonLdCompanySites(company, evidenceHtml, own)) push(h, labelMatches(nameLabel(h), want) ? 'evidence_link_domain_label' : 'evidence_link_text')
  // main's cap of 2 applies to the page's own links; a structured-data site keeps its own slot after them (review of #1219: with 2 anchored
  // company-named links it was cut off), so a lead tries at most 2 linked sites and 1 structured one
  return [...out.slice(0, Math.min(anchors, 2)), ...out.slice(anchors, anchors + 1).map(o => ({ ...o, structured: true }))]
}
// The JSON-LD blocks of a page, found by a linear scan (never a backtracking pattern over the whole page: a page of unclosed "<script" tags
// must not cost quadratic time). At most 20 blocks; a block is at most the page (the crawl caps a page at 800 KB).
export function ldJsonBlocks(html: string): string[] {
  // ASCII-only lower-casing: String.toLowerCase can change the LENGTH ("İ"), which would shift every offset used to slice the original
  const out: string[] = []; const low = html.length <= 2_000_000 ? html.replace(/[A-Z]/g, c => c.toLowerCase()) : ''
  let i = 0
  while (out.length < 20 && (i = low.indexOf('<script', i)) >= 0) {
    const tagEnd = low.indexOf('>', i)
    if (tagEnd < 0) break
    if (tagEnd - i > 400) { i += 7; continue }
    const tag = low.slice(i, tagEnd)
    i = tagEnd + 1
    if (!/type\s*=\s*["']application\/ld\+json["']/.test(tag)) continue
    const close = low.indexOf('</script', i)
    if (close < 0) break
    if (close - i <= 1_000_000) out.push(html.slice(i, close))
    i = close + 8
  }
  return out
}
// Only a node that IS an organisation (or is given as one: a bare hiringOrganization object) names a company's site. A JobPosting / Article /
// WebPage node's own url is the posting or the story, not the employer, whatever its title says.
const ORG_TYPE = /(organization|business|corporation|company|dentist|physician|clinic|hospital|pharmacy|restaurant|bakery|cafe|bar|hotel|store|shop|dealer|salon|spa|gym|contractor|plumber|electrician|roofer|locksmith|attorney|notary|agency|service|ngo|brand|school|studio)$/i
const NOT_ORG_TYPE = /^(jobposting|article|newsarticle|blogposting|webpage|website|event|product|offer|person|breadcrumblist|listitem|imageobject|videoobject|place|postaladdress)$/i
const NOT_A_COMPANY_TLD = /\.(gov|edu|mil)(\.[a-z]{2})?$|(^|\.)gc\.ca$|(^|\.)gov\.[a-z]{2,3}(\.[a-z]{2})?$/i
export function jsonLdCompanySites(company: string, html: string, pageHost = ''): string[] {
  const want = norm(company); if (want.length < 4) return []
  const out: string[] = []
  for (const block of ldJsonBlocks(html)) {
    let root: unknown; try { root = JSON.parse(block) } catch { continue }
    const stack = [root]; let guard = 0
    while (stack.length && guard++ < 2000) {
      const node = stack.pop()
      if (!node || typeof node !== 'object') continue
      if (Array.isArray(node)) { for (const x of node) { if (stack.length >= 5000) break; if (x && typeof x === 'object') stack.push(x) } continue }   // bounded: a huge array never overflows the call stack or the walk
      const rec = node as Record<string, unknown>
      for (const v of Object.values(rec)) if (v && typeof v === 'object' && stack.length < 5000) stack.push(v)
      const types = [rec['@type']].flat().filter((x): x is string => typeof x === 'string')
      if (types.some(t => NOT_ORG_TYPE.test(t)) || (types.length > 0 && !types.some(t => ORG_TYPE.test(t)))) continue
      const name = typeof rec.name === 'string' ? norm(rec.name) : ''
      if (!name || !(name === want || (name.includes(want) && want.length >= 5))) continue   // the node is this company (or names it in full); a shorter name inside ours ("Canada" for "Canada Goose") is someone else
      for (const u of [rec.url, rec.sameAs].flat().filter((x): x is string => typeof x === 'string')) {
        let host: string; try { const x = new URL(u); if (x.protocol !== 'https:' && x.protocol !== 'http:') continue; host = registrable(x.hostname) } catch { continue }
        if (!host || !siteHostOk(host) || host === pageHost || SOCIAL.test(host) || NOT_OWN_SITE.has(nameLabel(host)) || NOT_A_COMPANY_TLD.test(host) || out.includes(host)) continue
        out.push(host)
      }
    }
  }
  return out.slice(0, 2)
}
// #1122: the registrable host of a site a STRUCTURED public record gives for a business (OpenStreetMap's website tag for a place named like the
// company in the request's place), or null for a platform, social, directory, government or address-literal host. Unlike a web-search hit,
// the record names the business itself, so the host label need not carry the name ("qsdc.ca" for Queen Street Dental Centre); the crawl's
// homepage name check and place check still decide, as for any name_probe site.
export function ownSiteHost(url: string): string | null {
  let host: string
  try { const u = new URL(url); if (u.protocol !== 'https:' && u.protocol !== 'http:') return null; host = registrable(u.hostname.toLowerCase().replace(/\.$/, '')) } catch { return null }
  if (!host || !siteHostOk(host) || SOCIAL.test(host) || NOT_OWN_SITE.has(nameLabel(host)) || NOT_A_COMPANY_TLD.test(host)) return null
  return host
}
// Stable machine token stored in the label. Trust decisions read only this token (never display text).
export const DOMAIN_BASIS_TOKEN = 'domain-basis-v1:'
export const DOMAIN_BASES: DomainBasis[] = ['name_probe', 'evidence_link_text', 'evidence_link_domain_label', 'evidence_own_domain']
export const domainBasisToken = (b: DomainBasis) => DOMAIN_BASIS_TOKEN + b
export const findCompanySites = (company: string, evidenceHtml: string, evidenceUrl: string): string[] => findCompanySitesWithBasis(company, evidenceHtml, evidenceUrl).map(o => o.site)
export const findCompanySite = (company: string, html: string, url: string) => findCompanySites(company, html, url)[0] ?? null

// When the evidence page does not link the company's site (aggregator/news evidence), probe the
// obvious domains built from the company name. A probed domain is never trusted on its own: the
// crawl still fetches the homepage and rejects it unless the company is named there (name_mismatch),
// and robots.txt stays a hard rule. Key-free; no search API involved.
// #1036 4b: a lead whose evidence page links no company site (an Instagram post, a LinkedIn job, a jobleads listing, a news article) used
// to get only name-guessed domains ("moss.com" is not the Berlin fintech). Web-search results for "<company> <place>" name the real host.
// Pure: which hosts in the results can be the company's OWN site. Hosts of directories, social networks, job boards and news are never
// a company's own site; the host label must carry the company's name (norm(company) inside the label, or the label inside it) so a
// result that merely mentions the company is dropped. The homepage name check and the place check in crawlJob still decide, exactly as
// for a name-guessed domain (basis 'name_probe').
// Registrable names that are never a company's OWN site: social networks, job boards and applicant-tracking hosts, directories, review
// and booking sites, news and press wires, blog / site-builder / code hosts (a page there may name the company, but the host belongs
// to the platform, and a platform host must never become a company's domain or the base of a guessed address).
const NOT_OWN_SITE = new Set(['linkedin', 'instagram', 'facebook', 'twitter', 'x', 'youtube', 'tiktok', 'pinterest', 'yelp', 'indeed', 'glassdoor', 'jobleads', 'ziprecruiter', 'crunchbase', 'wikipedia', 'bloomberg', 'reuters', 'forbes', 'medium', 'reddit', 'google', 'bing', 'yellowpages', 'bbb', 'mapquest', 'tripadvisor', 'clutch', 'capterra', 'zoominfo', 'owler', 'pitchbook', 'builtin', 'wellfound', 'sesamers', 'finovate', 'businesswire', 'prnewswire', 'globenewswire', 'substack', 'wordpress', 'blogspot', 'github', 'trustpilot', 'doordash', 'ubereats', 'opentable', 'booking', 'expedia', 'healthgrades', 'zocdoc', 'ratemds', 'canpages', 'manta', 'sortlist', 'upwork', 'fiverr', 'goodfirms', 'designrush',
  'bamboohr', 'personio', 'greenhouse', 'lever', 'workable', 'ashbyhq', 'recruitee', 'teamtailor', 'smartrecruiters', 'breezy', 'jobvite', 'icims', 'myworkdayjobs', 'wixsite', 'wix', 'squarespace', 'myshopify', 'webflow', 'weebly', 'godaddysites', 'carrd', 'notion', 'linktr', 'site', 'page'])
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu'])
// German-style transliteration: "Mueller Baeckerei" for "Müller Bäckerei" (norm() folds the umlaut to its base letter instead).
const translit = (s: string) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
// Words a company's own domain commonly adds around its name, none of which is another business's name.
const HOST_AFFIX = new Set(['get', 'try', 'use', 'go', 'my', 'the', 'we', 'hello', 'join', 'meet', 'visit', 'team', 'hq', 'app', 'inc', 'llc', 'ltd', 'co', 'group', 'online', 'official', 'global', 'usa', 'us', 'uk', 'ca', 'au', 'de', 'nz', 'eu'])
// Trailing words of a company's name its domain often leaves out ("Queen Street Dental Centre" at queenstreetdental.ca).
const NAME_TAIL = /\s+(centre|center|clinic|office|offices|practice|studio|studios|agency|group|partners|associates|company|co|inc|llc|llp|ltd|limited|gmbh|pty|plc)\.?$/i
// The names a searched host may carry for this company: its normalised name, the transliterated form, and each with one or two
// trailing type words dropped. Empty when the name is too short to tell one company's host from another's (under 4 letters).
export function hostNamesFor(company: string): string[] {
  const out = new Set<string>()
  for (const form of [company, translit(company)]) {
    let name = form.trim()
    for (let i = 0; i < 3; i++) { const n = norm(name); if (n.length >= 4) out.add(n); const cut = name.replace(NAME_TAIL, ''); if (cut === name) break; name = cut }
  }
  return [...out]
}
// Which hosts in a web search's results can be THIS company's own site. Strict on purpose (council review): the homepage name check
// that follows only looks for the company's name as a substring, so "lakeharbordental" must never be offered for "Harbor Dental" - a
// different business with the name inside its own would pass that check. The REGISTRABLE label (letters and digits only) must be the
// company's name exactly, or the name with one generic affix ("getmoss", "harbordentalgroup") or with one of the lead's place words
// ("harbordentalaustin"). Never a label that adds another word, never a fragment of the name, never a platform or subdomain host.
// The registrable host is returned ("group.integral.de" -> "integral.de"). `places`: the lead's place words (scan geography).
export function companyHostsFromSearch(company: string, hits: { url: string }[], max = 3, places: string[] = []): string[] {
  const wants = hostNamesFor(company)
  if (wants.length === 0) return []
  const affixes = new Set([...HOST_AFFIX, ...places.flatMap(pl => pl.toLowerCase().split(/[^a-z0-9]+/)).filter(w => w.length >= 3)])
  const carries = (label: string) => wants.some(want => {
    if (label === want) return true
    if (label.startsWith(want) && affixes.has(label.slice(want.length))) return true
    return label.endsWith(want) && affixes.has(label.slice(0, label.length - want.length))
  })
  const out: string[] = []
  for (const h of hits) {
    let host: string; try { const u = new URL(h.url); if (u.protocol !== 'https:' && u.protocol !== 'http:') continue; host = u.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '') } catch { continue }
    const parts = host.split('.')
    if (parts.length < 2 || /^\d+$/.test(parts[parts.length - 1])) continue // not a host name (an IP address)
    // the public suffix: the last label, plus a second-level one before a country code ("co.uk", "com.au")
    const suffix = parts.length >= 3 && parts[parts.length - 1].length === 2 && SECOND_LEVEL.has(parts[parts.length - 2]) ? 2 : 1
    if (parts.slice(-suffix).some(l => l === 'gov' || l === 'edu')) continue
    const registrable = parts[parts.length - suffix - 1]
    if (!registrable || NOT_OWN_SITE.has(registrable)) continue
    if (!carries(registrable.replace(/[^a-z0-9]/g, ''))) continue
    const own = parts.slice(-(suffix + 1)).join('.')
    if (!out.includes(own)) out.push(own)
    if (out.length >= max) break
  }
  return out
}
// Keep prior explicit regional qualifiers only for compatibility. These match a whole
// place segment, never a country-like phrase embedded in prose or a city alone.
const LEGACY_COUNTRY_QUALIFIERS: readonly [RegExp, string][] = [
  [/^(?:ontario|quebec|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland(?: and labrador)?|prince edward island)$/, 'CA'],
  [/^(?:england|scotland|wales|northern ireland|great britain)$/, 'GB'],
  [/^(?:new south wales|nsw|queensland|western australia|south australia|tasmania)$/, 'AU'],
]
const US_STATE_NAMES = new Set(Object.values(US_STATES))
function probeCountry(where: readonly string[]): string | null {
  let country: string | null = null
  for (const place of where) {
    if (!place.trim()) continue
    const segments = place.split(',').map(s => s.trim())
    // Strip a Canadian postal suffix only when attached to (or immediately
    // following) a recognized Canadian province, not an arbitrary place.
    for (let i = 1; i < segments.length; i++) {
      const prefix = trimCanadianPostalTail(segments[i])
      if (prefix !== segments[i] && regionOf(prefix)?.startsWith('CA-')) segments[i] = prefix
      else if (prefix !== segments[i] && !prefix && regionOf(segments[i - 1])?.startsWith('CA-')) segments.splice(i--, 1)
    }
    if (segments.some(s => !s)) return null
    const matches = new Set<string>()
    let terminal = false
    for (const [i, segment] of segments.entries()) {
      const name = segment.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\.$/, '')
      // US qualifiers can disqualify a conflicting foreign hint, not supply a suffix.
      const us = i > 0 && (Object.hasOwn(US_STATES, name.toUpperCase()) || US_STATE_NAMES.has(name) || name === 'calif')
      const ca = i > 0 && /^(?:ON|BC|AB|QC|MB|SK|NS|NL|PE)$/.test(segment)
      const legacy = (i > 0 || !/^(?:ontario|new brunswick)$/.test(name))
        ? LEGACY_COUNTRY_QUALIFIERS.find(([re]) => re.test(name))?.[1] : undefined
      const code = us ? 'US' : ca ? 'CA' : resolveSegment(segment, true) ?? legacy
      if (code) { matches.add(code); terminal = i === segments.length - 1 }
    }
    if (!terminal || matches.size !== 1) return null
    const only = matches.values().next().value!
    if (country !== null && country !== only) return null
    country = only
  }
  return country
}
export function countryTlds(where: string[]): string[] {
  return countryDomainHints([probeCountry(where)])
}
export function probeDomains(company: string, where: string[] = []): string[] {
  const want = norm(company)
  if (want.length < 4 || want.length > 30) return []
  const out = candidateDomainSuffixes([probeCountry(where)]).map(t => `${want}.${t}`)
  // Brands named "<word> AI" usually live at <word>.ai (seen live: "Wavee Ai" at wavee.ai);
  // norm() flattens the space, so the plain probes above would only try waveeai.*.
  const words = company.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (words.length > 1 && words[words.length - 1] === 'ai') {
    const stem = norm(words.slice(0, -1).join(' '))
    if (stem.length >= 3) out.unshift(`${stem}.ai`)
  }
  return out
}

// Most leads per scan that get domain probes, so a big scan cannot turn into hundreds of fetches.
export const MAX_PROBES_PER_SCAN = 20   // #1037: matches MAX_SITES_PER_SCAN, so every lead the crawl picks may have its site found by name

// ---- extraction ----
export const ROLE = /^(info|hello|hi|contact|contactus|enquiries|enquiry|inquiries|inquiry|sales|business|office|admin|general|mail|team|support|help|press|media|partnerships|partners|bookings|booking|reservations|hola|contacto|kontakt|bonjour|ciao|ola|connect)$/i
export const sameSite = (emailDomain: string, site: string) => { const a = emailDomain.toLowerCase(); return a === site || a.endsWith('.' + site) }

export interface Found { kind: 'email' | 'phone' | 'person'; value: string; label: string; url: string }

// JSON-LD blocks name contact emails in structured form (Organization/Person/contactPoint).
// They live inside <script>, which the visible-text pass strips, so read them first.
function jsonLdEmails(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let root: unknown; try { root = JSON.parse(m[1]) } catch { continue }
    const stack = [root]
    while (stack.length) {
      const node = stack.pop()
      if (!node || typeof node !== 'object') continue
      if (Array.isArray(node)) { stack.push(...node); continue }
      const rec = node as Record<string, unknown>
      if (typeof rec.email === 'string') out.push(rec.email.replace(/^mailto:/i, ''))
      for (const v of Object.values(rec)) if (v && typeof v === 'object') stack.push(v)
    }
  }
  return out
}

// Common obfuscations: "info [at] company.com", "sales(at)company dot com". Deobfuscated
// candidates go through the same role + same-site filter as everything else.
function deobfuscatedEmails(body: string): string[] {
  const out: string[] = []
  const re = /\b([a-z0-9][a-z0-9._%+-]{0,63})\s*(?:\[at\]|\(at\)|\sat\s)\s*([a-z0-9][a-z0-9.-]{0,251})(?:\.|\s*(?:\[dot\]|\(dot\)|\sdot\s)\s*)([a-z]{2,24})(?![a-z]|\.[a-z])/gi
  for (const m of body.matchAll(re)) out.push(`${m[1]}@${m[2]}.${m[3]}`)
  return out
}

export function extractContacts(html: string, pageUrl: string, site: string): Found[] {
  html = revealEmails(html) // #1036: Cloudflare-protected and [at]/[dot] addresses read as a visitor sees them
  const out = new Map<string, Found>()
  const body = html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
  const add = (f: Found) => { if (!out.has(f.kind + f.value)) out.set(f.kind + f.value, f) }
  // Crawlee's parser finds mailto: links and addresses in visible text; JSON-LD and
  // deobfuscation cover the two forms it misses. The filters below decide what is kept.
  const emails: string[] = [...social.parseHandlesFromHtml(body).emails, ...jsonLdEmails(html), ...deobfuscatedEmails(body)]
  for (const e of emails) {
    const m = /^([^@\s]+)@([^@\s]+)$/.exec(e.trim().toLowerCase()); if (!m) continue
    if (!sameSite(m[2], site) || !ROLE.test(m[1].replace(/[._-]/g, '')) ) continue
    if (/\.(png|jpe?g|gif|svg|webp)$/i.test(m[2])) continue
    add({ kind: 'email', value: `${m[1]}@${m[2]}`, label: contextLabel(contactContext(html, `${m[1]}@${m[2]}`,pageUrl)), url: pageUrl })
  }
  for (const m of body.matchAll(/href\s*=\s*["']tel:([^"'>\s]+)/gi)) {
    let v = ''; try { v = decodeURIComponent(m[1]) } catch { continue }
    const digits = v.replace(/\D/g, ''); if (digits.length >= 8 && digits.length <= 15) add({ kind: 'phone', value: v.replace(/[^\d+()\-.\s]/g, '').trim().slice(0, 40), label: 'phone published on the company site', url: pageUrl })
  }
  return [...out.values()].slice(0, 6)
}

// ---- named people the company itself lists (name + title, no address) ----
// The company site is the only source. No email is built from a name, and a listed person is never an
// address or a mailbox association: this gives the user a "who runs this" fact with its page, nothing the sender can mail.
// Credibility rules (structure, not a growing blacklist):
//  - the whole title must be a leadership title and nothing else ("Director, Other Corp" is rejected);
//  - the page must be an about/team/leadership/contact page, and testimonial/review/quote blocks are cut out first;
//  - the page needs real prose (15+ distinct lower-case words) or nothing is judged;
//  - a name-shaped phrase is rejected when one of its words also appears in lower case in the page text
//    (trade and service words such as "Roof Repair" do; surnames and first names almost never do) or is a link label;
//  - JSON-LD Person counts only under employee/founder/member of a node typed as an organisation/business, never inside review/author/comment nodes;
//  - a blockquote/cite/q or testimonial-marked element that never closes makes the whole page unjudged (fail closed).
// B2B decision-maker titles join the owner-style ones: the person who buys a sales/ops/engineering tool is rarely "owner". Each
// addition is a WHOLE title with no free text after it ("Director, Other Corp" still fails): C-suite, "Chief X Officer", and
// "VP/Head/Director of <1-2 words>". Names still pass every name-shape and prose check below, so a wider title list admits no new kind of name.
// "Head/Director/VP of" takes up to two words ("Human Resources"). Titles specific to the seller's buyers are not listed
// here: they come from each scan's own ICP roles (buyerTitle), so this works for any business and any language.
const EXEC = `c[a-z]o|chief [a-z]+ officer|(?:vp|svp|evp|vice president|head|director) of [a-z]+(?: [a-z]+)?(?: (?:&|and) [a-z]+)?|(?:vp|svp|evp|vice president) [a-z]+`
export const PAGE_PEOPLE = 8
const T = `(?:founder|co-?founder|owner|co-?owner|ceo|president|principal|proprietor|managing director|general manager|director|managing partner|partner|practice manager|office manager|broker|dentist|doctor|${EXEC})`
const TITLE_FULL = new RegExp(`^${T}(?: (?:&|and) ${T})?$`, 'i')
const PEOPLE_PAGE = /(about|team|leadership|management|executives|people|staff|our-story|who-we-are|meet|contact|company|owner|doctor|dentist)/i
const NAME_LINE = /^(?:(?:Dr|Mr|Ms|Mrs)\.?\s+)?[A-Z][a-z'\u2019-]{1,20}(?:\s+[A-Z]\.?)?\s+[A-Z][A-Za-z'\u2019-]{2,24}$/ // both names 3+ letters: two-letter surnames (Li, Ng) are skipped on purpose, "Us" in "Contact Us" is not a surname
// Remove balanced elements whose tag (blockquote/cite/q) or class/id (any element) marks quoted third-party content.
// Returns null when a marked region is malformed (never closed): the page is then not judged at all.
// #1183: a search/filter control (a datalist or dropdown of job titles) is page chrome, never a person card: its options are cut by CONTEXT, so an
// unlisted title ("Managing Member") next to a listed one cannot pair into a fake person the way a word list alone would let it.
const MARK = '(?:testimonial|review|quote|client|customer|partner|sponsor|press|award|feedback|rating|datalist|dropdown|facet|refine|filter-?(?:option|list|menu|bar|group|panel))'
function cutBlocks(html: string): string | null {
  let out = html
  const open = new RegExp(`<(blockquote|cite|q|select|datalist)\\b[^>]*>|<([a-z][a-z0-9]*)\\b[^>]*\\b(?:class|id)\\s*=\\s*["'][^"']*${MARK}[^"']*["'][^>]*>`, 'i')
  for (let guard = 0; guard < 200; guard++) {
    const m = open.exec(out); if (!m) return out
    const tag = (m[1] ?? m[2]).toLowerCase()
    if (/\/\s*>$/.test(m[0]) || /^(?:br|img|hr|input|meta|link)$/.test(tag)) { out = out.slice(0, m.index) + ' ' + out.slice(m.index + m[0].length); continue }
    const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi'); re.lastIndex = m.index + m[0].length
    let depth = 1, end = -1, t: RegExpExecArray | null
    while ((t = re.exec(out))) { depth += t[1] ? -1 : 1; if (depth === 0) { end = t.index + t[0].length; break } }
    if (end < 0) return null
    out = out.slice(0, m.index) + ' ' + out.slice(end)
  }
  return null
}
function jsonLdPeople(html: string): { name: string; title: string }[] {
  const ORG = /^(Organization|Corporation|LocalBusiness|Dentist|Physician|MedicalBusiness|ProfessionalService|LegalService|RealEstateAgent|Store|Restaurant|HomeAndConstructionBusiness|Attorney|Accountant|FinancialService)$/
  const typesOf = (n: Record<string, unknown>) => ([] as unknown[]).concat(n['@type'] ?? []).map(String)
  const flat = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.flatMap(flat) : v && typeof v === 'object' ? [v as Record<string, unknown>] : []
  // The page's company: an organisation node at the top level of a block, in @graph, or the mainEntity of a non-organisation page node. An organisation reached through any other edge (worksFor, parentOrganization, subOrganization, member...) is another company and has no authority here.
  const orgs: Record<string, unknown>[] = []
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let root: unknown; try { root = JSON.parse(m[1]) } catch { continue }
    const seen = new Set<unknown>()
    const top = (v: unknown) => {
      for (const n of flat(v)) {
        if (seen.has(n)) continue; seen.add(n)
        if (typesOf(n).some(t => ORG.test(t))) orgs.push(n)
        else { if (n['@graph']) top(n['@graph']); if (n.mainEntity) top(n.mainEntity) }
      }
    }
    top(root)
  }
  // Page level: one organisation, or several that name themselves identically (the same company repeated across blocks). Anything else, including an organisation with no name, is conflicting or unknown, so no one is listed. No fuzzy matching.
  if (orgs.length === 0) return []
  const key = (o: Record<string, unknown>) => typeof o.name === 'string' && o.name.trim() ? 'n:' + o.name.trim().replace(/\s+/g, ' ').toLowerCase() : typeof o['@id'] === 'string' && o['@id'] ? 'i:' + o['@id'] : ''
  if (orgs.length > 1) { const k0 = key(orgs[0]); const ids = new Set(orgs.map(o => typeof o['@id'] === 'string' ? o['@id'] : '').filter(Boolean)) // supplied identifiers that conflict outrank a shared name
    if (!k0 || orgs.some(o => key(o) !== k0) || ids.size > 1) return [] }
  const out: { name: string; title: string }[] = []
  for (const org of orgs) for (const k of ['employee', 'employees', 'founder', 'founders', 'member', 'members']) {
    for (const p of flat(org[k])) {
      // only the person node itself; nothing nested under it (spouse, knows, worksFor...) is read
      if (typesOf(p).includes('Person') && typeof p.name === 'string' && typeof p.jobTitle === 'string') out.push({ name: p.name.trim(), title: p.jobTitle.trim() })
    }
  }
  return out
}
// A title that is one of the scan's own buyer roles ("Practice Manager", "Gerente de Vendas") counts as a whole title even
// when it is not a generic executive title: it contains a full ICP role, or shares 2+ of its words. Same guards as
// before: short, no comma, and nothing naming another employer ("at", "@", "for").
// Word-preserving, any alphabet (this file's norm() drops spaces and company words, which suits domains, not titles).
const titleNorm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
export function buyerTitle(title: string, buyerRoles?: string): boolean {
  if (!buyerRoles || roleContradicted(title, buyerRoles) || title.length > 60 || title.split(/\s+/).length > 6 || /,|\s(?:at|@|for|bei|chez|em|en|presso)\s/i.test(title)) return false
  const t = titleNorm(title)
  if (buyerRoles.split(';').map(titleNorm).some(r => r.length >= 3 && (` ${t} `).includes(` ${r} `))) return true
  return titleMatches(title, buyerRoles).length >= 2
}
const HEAD_MARK = '\u0001H'
const FORMER_SECTION = /\b(?:alumni|alumnae|former\s+(?:team|staff|members?|employees?|leadership|colleagues)|past\s+(?:team|staff|members?|employees?|leadership)|previous\s+(?:team|staff|members?)|in\s+memoriam|emeriti)\b/i
const TITLE_STOP = new Set(['chief', 'head', 'vice', 'with', 'from', 'that', 'this', 'your', 'team'])
export function extractPeople(html: string, pageUrl: string, buyerRoles?: string): Found[] {
  const found = new Map<string, Found>()
  let path = ''; try { path = new URL(pageUrl).pathname } catch { return [] }
  const clean = cutBlocks(html)
  if (clean === null) return [] // a quoted/testimonial region that never closes cannot be separated from the page: fail closed
  const visible = clean.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
  const linkText = new Set([...visible.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()))
  // Headings are kept as marked lines so a person can be judged against the section they sit in (alumni, former staff).
  const marked = visible.replace(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, t: string, inner: string) => `\n${HEAD_MARK}${t.slice(1)} ${inner.replace(/<[^>]+>/g, ' ')}\n`)
  const text = marked.replace(/<\/?(p|div|li|ul|ol|h[1-6]|br|section|article|tr|td|th|figure|figcaption|header|footer|span|strong|b|em)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, "'").replace(/&nbsp;/g, ' ')
  const rawLines = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
  // A heading names a section of former people (alumni, past team, in memoriam) for everything under it until the next
  // heading of the same or a higher level that is not itself a person's name. Advisory boards and the like stay current.
  const lines: string[] = [], inFormer: boolean[] = []
  let formerLevel = 0
  for (const l of rawLines) {
    if (l.startsWith(HEAD_MARK)) {
      const level = Number(l[HEAD_MARK.length]), head = l.slice(HEAD_MARK.length + 1).trim()
      if (FORMER_SECTION.test(head)) { formerLevel = formerLevel === 0 ? level : Math.min(formerLevel, level) }
      else if (formerLevel && level <= formerLevel && !NAME_LINE.test(head)) formerLevel = 0
      if (!NAME_LINE.test(head) || FORMER_SECTION.test(head)) continue
      lines.push(head); inFormer.push(formerLevel > 0); continue
    }
    lines.push(l); inFormer.push(formerLevel > 0)
  }
  // Email addresses are not prose: their lower-case local parts (dana.lee@...) would otherwise reject the very person
  // listed beside them, so they are removed before the lower-case word test.
  const body = lines.join(' ').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ' ')
  const lowerWords = new Set(body.match(/\b[a-z][a-z'\u2019-]{1,}\b/g) ?? [])
  const titleWords = new Set<string>()
  const addWords = (t: string) => { for (const w of titleNorm(t).split(' ')) if (w.length >= 4 && !TITLE_STOP.has(w)) titleWords.add(w) }
  for (const r of (buyerRoles ?? '').split(';')) addWords(r)
  for (const l of lines) if (l.length < 45 && (TITLE_FULL.test(l) || buyerTitle(l, buyerRoles))) addWords(l)
  const reusesTitleWord = (name: string) => titleNorm(name).split(' ').some(w => titleWords.has(w))
  const add = (name: string, title: string, viaJson = false): boolean => {
    name = name.replace(/\s+/g, ' ').trim(); title = title.replace(/\s+/g, ' ').trim()
    if (roleEndedByDate(title) || roleContradicted(title, buyerRoles)) return false // an explicit past end date or a past-tense title: not current staff
    if (!NAME_LINE.test(name) || looksLikeJobTitle(name) || !(TITLE_FULL.test(title) || buyerTitle(title, buyerRoles))) return false // #1183: "Litigation Specialist" is a title, not a person
    if (!viaJson) {
      if (!PEOPLE_PAGE.test(path)) return false
      if (lowerWords.size < 15) return false // no prose on the page: nothing to judge a name-shaped phrase against, fail closed
      if (linkText.has(name.toLowerCase())) return false
      if (name.replace(/^(Dr|Mr|Ms|Mrs)\.?\s+/, '').split(/\s+/).some(w => lowerWords.has(w.toLowerCase().replace(/\.$/, '')))) return false
    }
    if (!found.has(name.toLowerCase())) found.set(name.toLowerCase(), { kind: 'person', value: `${name}, ${title}`.slice(0, 120), label: 'listed with this title on this company page, not verified as current staff', url: pageUrl })
    return true
  }
  for (const p of jsonLdPeople(clean)) add(p.name, p.title, true)
  const isTitleLine = (l: string) => l.length < 45 && (TITLE_FULL.test(l) || buyerTitle(l, buyerRoles))
  const paired: boolean[] = [] // paired[j]: line j was accepted as the title of the person on line j-1
  for (let i = 0; i < lines.length; i++) {
    const same = /^([^,\u2013\u2014|]{3,45}?)\s*(?:,|\u2013|\u2014|-|\|)\s*([^,\u2013\u2014|]{3,40})$/.exec(lines[i])
    if (inFormer[i]) continue
    if (same) add(same[1], same[2])
    // #1183: an adjacent "Name" + "Title" pair is refused when the "name" reuses a word the page's OWN titles and the scan's buyer roles use
    // ("Managing Member" beside "Managing Partner"): that is an unmarked title list, whatever markup it sits in. Learned from the page, not a vocabulary.
    // #1183 (multilingual): "Diretor Comercial" beside a buyer role "Gerente de Vendas" shares no word with any collected title, so the check above
    // cannot see it. Structure does: a title line that no accepted person precedes is an orphan, and a "name" straight after an orphan title is the next
    // item of a title list, not a person (on a real team page every title follows an accepted name). Fail closed: if the person before was dropped for
    // another reason, the next one is dropped too (recall cost, never a fabricated person).
    const afterOrphan = i >= 1 && isTitleLine(lines[i - 1]) && !paired[i - 1] && !inFormer[i - 1]
    if (i + 1 < lines.length && lines[i].length < 45 && lines[i + 1].length < 45 && !inFormer[i + 1] && !reusesTitleWord(lines[i]) && !afterOrphan && add(lines[i], lines[i + 1])) paired[i + 1] = true
  }
  // Up to PAGE_PEOPLE per page, most senior first; crawlSite makes the final choice of 3 (buyer roles first when known).
  return [...found.values()].sort(bySeniority).slice(0, PAGE_PEOPLE)
}

// Which listed person to keep when a page lists many: whoever can sign off on a purchase first. Pure ordering of what
// extractPeople already accepted; it never adds or invents a person. Ties keep page order (stable sort).
export function seniority(title: string): number {
  const t = title.toLowerCase()
  if (/\b(founder|owner|proprietor|ceo|president|principal|managing (?:director|partner)|chief executive)\b/.test(t)) return 4
  if (/\b(c[a-z]o|chief|vp|svp|evp|vice president|head|general manager)\b/.test(t)) return 3
  if (/\b(director|partner|broker)\b/.test(t)) return 2
  return 1
}
const titleOf = (f: Found) => f.value.slice(f.value.indexOf(', ') + 2)
export const byBuyerThenSeniority = (buyerRoles: string) => (a: Found, b: Found) => titleMatches(titleOf(b), buyerRoles).length - titleMatches(titleOf(a), buyerRoles).length || bySeniority(a, b)
export const bySeniority = (a: Found, b: Found) => seniority(b.value.slice(b.value.indexOf(', ') + 2)) - seniority(a.value.slice(a.value.indexOf(', ') + 2))

const PAGE_HINT = /(contact|about|impressum|kontakt|contacto|contato|nous-contacter|contactez|chi-siamo|company|team|leadership|management|people|reach|locations?|offices?|careers?|our-practice|meet-the|providers|doctors|staff)/i
const BUYER_DIRECTORY_PATH = /\/(?:[^/]*-)?(?:team|leadership|management|people|staff|executives)(?:[-/]|$)/i
function sameCompanyPage(target: URL, base: URL): boolean {
  return target.protocol === 'https:' && !target.username && !target.password && !target.port && target.hostname.replace(/^www\./, '') === base.hostname.replace(/^www\./, '')
}
// A company-published about/leadership link is a discovery hint only. Give one
// such document an early slot without adding a read or changing the proof gates.
function linkedBuyerAboutPath(html: string, home: URL): string | null {
  const clean = cutBlocks(html)
  if (!clean) return null
  const about = /^\/(?:[^/]+\/){0,2}(?:about(?:-us)?|company|our-story|who-we-are)\/?$/i
  for (const m of clean.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi)) {
    let u: URL
    try { u = new URL(m[1].replace(/&amp;/g, '&'), home) } catch { continue }
    if (u.origin === home.origin && sameCompanyPage(u, home) && !u.search && !u.hash &&
        u.pathname.length < 60 && about.test(u.pathname)) return u.pathname
  }
  return null
}
// Search provides discovery URLs, never authority or a person record. Keep
// these paths out of the runner's separate website-identity candidate list.
export function buyerSourceCitation(raw: string): URL | null {
  try {
    const u = new URL(raw)
    return raw === u.href && u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      !u.search && !u.hash && u.pathname.length < 120 &&
      /^\/(?:[a-z0-9-]+\/){0,2}(?:about(?:-us)?|company|team|our-team|leadership|management|people|staff|executives|our-story|who-we-are)\/?$/i.test(u.pathname)
      ? u : null
  } catch { return null }
}
export function contactPaths(homeHtml: string, home: URL, preferBuyers = false): string[] {
  const set = new Set<string>(['/contact', '/contact-us', '/about', '/team', '/leadership'])
  const linkedLocations = new Set<string>(), linkedBuyers = new Set<string>()
  for (const m of homeHtml.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi)) {
    let u: URL; try { u = new URL(m[1].replace(/&amp;/g, '&'), home) } catch { continue }
    if (u.protocol !== 'https:' || u.hostname.replace(/^www\./, '') !== home.hostname.replace(/^www\./, '')) continue
    if (!PAGE_HINT.test(u.pathname) || u.pathname.length >= 60 || /\.(pdf|jpg|png|zip)$/i.test(u.pathname) || u.search) continue
    set.add(u.pathname)
    if (sameCompanyPage(u, home) && BUYER_DIRECTORY_PATH.test(u.pathname)) linkedBuyers.add(u.pathname)
    if (/\/(?:locations?|offices?)(?:\/|$)/i.test(u.pathname)) linkedLocations.add(u.pathname)
  }
  for (const extra of ['/locations', '/our-team', '/careers']) set.add(extra) // after the page's own links: same cap, never ahead of them
  return [...new Set([...(preferBuyers ? [...linkedBuyers].slice(0, 1) : []), '/contact', '/contact-us', ...linkedLocations, ...set])].slice(0, 8)
}

// Follow one named person's exact first-party bio link, from a directory that the company
// listed itself. Never treat the directory link as proof of a role.
type BuyerBio = { path: string; name: string; expectedValue?: string }
function linkedBuyerBio(html: string, page: URL, listed: Map<string, string> | null = null): BuyerBio | null {
  const clean = cutBlocks(html)
  if (!clean || !BUYER_DIRECTORY_PATH.test(page.pathname)) return null
  // A directory that mixes former/current people is ambiguous without a scoped DOM section.
  if (FORMER_SECTION.test(plainText(clean))) return null
  for (const m of clean.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{1,250}?)<\/a\s*>/gi)) {
    const name = plainText(m[2], 80)
    if (!NAME_LINE.test(name) || looksLikeJobTitle(name)) continue
    const expectedValue = listed?.get(name)
    if (listed && !expectedValue) continue
    let u: URL; try { u = new URL(m[1].replace(/&amp;/g, '&'), page) } catch { continue }
    if (!sameCompanyPage(u, page) || u.search || u.hash || u.pathname.length > 140) continue
    const directory = page.pathname.replace(/\/+$/, '')
    if (!u.pathname.startsWith(directory + '/') || u.pathname.slice(directory.length + 1).replace(/\/+$/, '').includes('/')) continue
    const slug = name.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (slug.split('-').length < 2 || u.pathname.slice(directory.length + 1).replace(/\/+$/, '').toLowerCase() !== slug) continue
    return { path: u.pathname, name, ...(expectedValue ? { expectedValue } : {}) }
  }
  return null
}

// A profile is metadata for an already accepted bio, never identity/title proof by
// itself. Scope to one article with one exact heading and an explicitly named link;
// no page-wide social icons, cross-card links, guessed slugs, or LinkedIn fetch.
function linkedBioProfile(html: string, name: string): string | null {
  // This optional extraction never processes an oversized/ambiguous document.
  if (html.length > 32_768) return null
  const stripped = cutBlocks(html)
  if (!stripped) return null
  const clean = stripped.replace(/<!--[^]*?(?:-->|$)|<(script|style|noscript|template)\b[^>]*>[^]*?(?:<\/\1\s*>|$)/gi, '')
  const articles = [...clean.matchAll(/<article\b[^>]*>((?:(?!<article\b)[\s\S])*?)<\/article\s*>/gi)]
  if (articles.length !== 1 || (clean.match(/<article\b/gi)?.length ?? 0) !== 1) return null
  const body = articles[0][1]
  const headings = [...body.matchAll(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]\s*>/gi)]
  if (headings.length !== 1 || plainText(headings[0][1], 120) !== name) return null
  const anchors = [...body.matchAll(/<a\b([^>]+)>([\s\S]*?)<\/a\s*>/gi)]
  const profiles: { url: string; named: boolean }[] = []
  for (const a of anchors) {
    const href = /(?:^|\s)href\s*=\s*["']([^"']+)["']/i.exec(a[1])?.[1]
    const url = href && listedProfileUrl(href)
    if (!url) continue
    const aria = /(?:^|\s)aria-label\s*=\s*["']([^"']+)["']/i.exec(a[1])?.[1]
    const explicit = `${name} on LinkedIn`
    const text = plainText(a[2], 160)
    const label = aria ? plainText(aria, 160) : ''
    profiles.push({ url, named: text === explicit || ((text === '' || text === 'LinkedIn') && label === explicit) })
  }
  return profiles.length === 1 && profiles[0].named ? listedProfileLabel(profiles[0].url) : null
}

// Abort-aware sleep: resolves early (to false) when the signal fires, so the
// polite per-host gap does not outlive a post-processing deadline.
const sleepAbort = (ms: number, signal?: AbortSignal) => new Promise<boolean>((resolve) => {
  if (signal?.aborted) return resolve(false)
  const t = setTimeout(() => resolve(true), ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(false) }, { once: true })
})
const lastHit = new Map<string, number>()

type LocationPage = { url: string; statements: string[]; offices: { heading: string; address: string; ownSection: boolean }[]; footerOffices: { heading: string; address: string }[]; hiringMarkets: { heading: string; employer: string }[] }
type LocationProof = { url: string; excerpt: string }

function subpageLocationFacts(url: string, body: string): LocationPage {
  // Keep prose statements and office entries separate. A page can list several offices or quote a customer.
  const visibleMarkup = body.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style|noscript|svg|template|blockquote)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
  const statements = [...visibleMarkup.matchAll(/<(p|address)\b[^>]*>([\s\S]{1,800}?)<\/\1\s*>/gi)]
    .map(m => plainText(m[2], 300)).filter(Boolean)
  const offices: LocationPage['offices'] = []
  const footerOffices: LocationPage['footerOffices'] = []
  const hiringMarkets: LocationPage['hiringMarkets'] = []
  const locationPath = /\/(?:contact(?:-us)?|locations?|offices?)(?:\/|$)/i.test(new URL(url).pathname)
  const careerPath = /\/(?:careers?|jobs)(?:\/|$)/i.test(new URL(url).pathname)
  if (locationPath || careerPath) {
    const headings = [...visibleMarkup.matchAll(/<h([1-6])\b[^>]*>([\s\S]{1,500}?)<\/h\1\s*>/gi)]
    let ownSectionLevel = 0
    for (const [index, heading] of headings.entries()) {
      const level = Number(heading[1])
      if (ownSectionLevel && level <= ownSectionLevel) ownSectionLevel = 0
      const title = plainText(heading[2], 300)
      if (/^we are (?:conveniently )?located (?:in|at|on)\b/i.test(title)) statements.push(title)
      if (/^(?:where we are|our (?:offices|locations))$/i.test(title)) ownSectionLevel = level
      const start = heading.index + heading[0].length
      const block = visibleMarkup.slice(start, Math.min(headings[index + 1]?.index ?? visibleMarkup.length, start + 2500))
      const address = plainText(block, 200)
      if (locationPath && address) offices.push({ heading: title, address, ownSection: ownSectionLevel > 0 })
      if (careerPath && /^[\p{L} .’'-]+,\s*[\p{L} .’'-]+$/u.test(title)) {
        for (const link of block.matchAll(/<a\b[^<>]*\bhref\s*=\s*["'](https:\/\/[^"']+)["']/gi)) {
          const employer = atsPostingRef(link[1])?.org
          if (employer) hiringMarkets.push({ heading: title, employer })
        }
      }
    }
  }
  if (new URL(url).pathname === '/') {
    // A company footer may list each office as adjacent city and postal-address blocks.
    const footer = /<footer\b[^<>]*>/i.exec(visibleMarkup)
    if (footer) {
      const start = footer.index + footer[0].length
      const end = visibleMarkup.toLowerCase().indexOf('</footer', start)
      const body = end < 0 ? '' : visibleMarkup.slice(start, Math.min(end, start + 50_000))
      const blocks = [...body.matchAll(/<(p|h[1-6]|address)\b[^<>]*>([\s\S]{1,800}?)<\/\1\s*>/gi)].map(m => plainText(m[2], 200))
      const officeStart = blocks.findIndex(block => /^(?:corporate hq|head office|our offices|our locations)$/i.test(block))
      if (officeStart >= 0) for (let i = officeStart + 1; i + 1 < blocks.length; i++) {
        if (FOREIGN_SUBJECT.test(blocks[i]) || FOREIGN_FOOTER_SECTION.test(blocks[i])) break
        if (POSTAL_ADDRESS.test(blocks[i + 1]) && streetKeys(blocks[i + 1]).length) footerOffices.push({ heading: blocks[i], address: blocks[i + 1] })
      }
    }
  }
  return { url, statements, offices, footerOffices, hiringMarkets }
}

const OFFICE_CLAIM = /^(?:is |are )?(?:(?:headquartered|based|located) (?:in|at)|(?:office|headquarters)\s*[:,-])\s+/i
const FIRST_PERSON_OFFICE = /^(?:our (?:[\p{L}-]+ )?(?:office|headquarters) (?:is|are) (?:in|at)|we are (?:conveniently )?located (?:in|at|on))\s+/iu
const HOME_BASE_CLAIM = /^we (?:are|work) remote-first with (?:a|our) ([\p{L} ,.'’-]{2,64}) home base[.!]?$/iu
const FOREIGN_SUBJECT = /\b(?:customer|client|partner|testimonial|service area)\b/i
// Footer category headings often use the plural; they end the first-party office block.
const FOREIGN_FOOTER_SECTION = /\b(?:customers|clients|partners|testimonials|service areas)\b/i
const POSTAL_ADDRESS = /\b(?:[A-Z]\d[A-Z]\s?\d[A-Z]\d|[A-Z]{2}\s+\d{5}(?:-\d{4})?)\b/i

const UK_POSTCODE = /\b(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/i

// Display-only named email needs the issuer's own matching postal office, not a service-area mention
// or a job-vacancy market. Keep this gate separate from the ordinary domain-identity discovery.
function publishedDisplayOffice(pages: LocationPage[], where: string[], company: string, country: 'CA' | 'GB'): boolean {
  const ca = /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i
  const postal = country === 'CA' ? ca : UK_POSTCODE
  const key = norm(company)
  const placeNames = new Set(geoTerms(where).map(norm))
  const regionGroups = country === 'CA' ? [
    ['AB', 'Alberta'], ['BC', 'British Columbia'], ['MB', 'Manitoba'], ['NB', 'New Brunswick'],
    ['NL', 'Newfoundland and Labrador'], ['NS', 'Nova Scotia'], ['NT', 'Northwest Territories'], ['NU', 'Nunavut'],
    ['ON', 'Ontario'], ['PE', 'Prince Edward Island'], ['QC', 'Quebec', 'Québec'], ['SK', 'Saskatchewan'], ['YT', 'Yukon'],
  ] : [['England'], ['Northern Ireland'], ['Scotland'], ['Wales']]
  const regionOf = (value: string) => regionGroups.findIndex(names => names.some(name => norm(name) === norm(value)))
  const preciseRegions = (value: string) => new Set(value.split(',').map(part => regionOf(part.trim())).filter(i => i >= 0))
  const requestedRegions = preciseRegions(where.join(','))
  const officeHeading = (heading: string, address: string) => {
    const qualified = /^([^,]+),\s*([^,]+)$/.exec(heading)
    if (!qualified) return placeNames.has(norm(heading))
    if (!placeNames.has(norm(qualified[1])) || placeAgreement(heading, where, company) !== 'agrees') return false
    const region = regionOf(qualified[2])
    // Postal shape establishes country, not province or nation. Require an unambiguous region in the
    // postal address itself rather than treating the heading as a second standalone place match.
    if (region < 0) return placeNames.has(norm(heading))
    const addressRegions = preciseRegions(address.replace(postal, ','))
    return addressRegions.size === 1 && addressRegions.has(region) &&
      (requestedRegions.size === 0 || (requestedRegions.size === 1 && requestedRegions.has(region)))
  }
  const office = (text: string) => !FOREIGN_SUBJECT.test(text) && postal.test(text) && streetKeys(text).length > 0 &&
    placeAgreement(text, where, company) === 'agrees' && !ownAddressElsewhere(text, where)
  const declaresOwner = (text: string) => {
    if (FIRST_PERSON_OFFICE.test(text)) return true
    const comma = /^([^,:]+)[,:]\s*(\d)/.exec(text)
    if (comma && norm(comma[1]) === key) return true
    const words = text.trim().split(/\s+/)
    return words.slice(0, Math.min(10, words.length)).some((_, i) => norm(words.slice(0, i+1).join(' ')) === key &&
      OFFICE_CLAIM.test(words.slice(i+1).join(' ')))
  }
  return key.length >= 3 && pages.some(p => p.statements.some(s => office(s) && declaresOwner(s)) ||
    p.offices.some(o => o.ownSection && officeHeading(o.heading, o.address) && office(o.address)))
}

function siteLocationProof(pages: LocationPage[], where: string[], company: string, alternateOfficeOnly: boolean, guessed: boolean): LocationProof | undefined {
  if (!where.length) return undefined
  const key = norm(company)
  if (key.length < 3 || company.length > 160) return undefined
  const requestedPlaces = new Set(geoTerms(where).map(norm))
  const ukScope = guessed && probeCountry(where) === 'GB'
  const agrees = (fragment: string, alreadyBound = false) => (guessed
    ? probeScopeAgreement(fragment, where, company, alreadyBound) : placeAgreement(fragment, where, company)) === 'agrees' &&
    !ownAddressElsewhere(fragment, where)
  for (const { url, statements, offices, footerOffices, hiringMarkets } of pages) {
    const footer = footerOffices.find(({ heading, address }) => requestedPlaces.has(norm(heading)) && !FOREIGN_SUBJECT.test(address) && agrees(address, true))
    if (footer) return { url, excerpt: `${footer.heading}: ${footer.address}` }
    // The existing exact same-company ATS link binds the hiring heading.
    // It still has to name the asked locality, not just the country.
    const market = hiringMarkets.find(({ heading, employer }) => norm(employer) === key && agrees(heading, true))
    if (market) return { url, excerpt: `employer's own hiring page lists ${market.heading}` }
    if (alternateOfficeOnly || new URL(url).pathname === '/') continue
    for (const paragraph of statements) {
      for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
        if (FOREIGN_SUBJECT.test(sentence)) continue
        const words = sentence.trim().split(/\s+/)
        const matchesCompany = words.slice(0, Math.min(10, words.length)).some((_, index) =>
          norm(words.slice(0, index + 1).join(' ')) === key && OFFICE_CLAIM.test(words.slice(index + 1).join(' ')))
        const homeBase = HOME_BASE_CLAIM.exec(sentence)?.[1]
        const postalOwner = /^([^,:]{3,160}),\s*\d/.exec(sentence)?.[1]
        const ownPostalName = !!postalOwner && norm(postalOwner) === key
        const hadPostalAddress = (POSTAL_ADDRESS.test(sentence) || (ukScope && ownPostalName && UK_POSTCODE.test(sentence))) &&
          streetKeys(sentence).length > 0
        // A standalone own-name postal line on the contact page, or an explicit
        // first-person invitation to that place, can supply a missing homepage
        // location. The same precise scope and conflict checks still apply.
        const ownContactPlace = guessed && /\/(?:contact(?:-us)?|locations?|offices?)(?:\/|$)/i.test(new URL(url).pathname) &&
          (/^visit us (?:in|at)\s+/i.test(sentence) || (hadPostalAddress &&
            (/^LOCATION\s*:?\s+\d/.test(sentence) || ownPostalName)))
        if (((matchesCompany || FIRST_PERSON_OFFICE.test(sentence) || ownContactPlace) && agrees(sentence)) ||
            (homeBase && requestedPlaces.has(norm(homeBase)) && agrees(sentence, true))) return { url, excerpt: sentence }
      }
    }
    for (const { heading, address, ownSection } of offices) {
      if (FOREIGN_SUBJECT.test(`${heading} ${address}`) || !POSTAL_ADDRESS.test(address) || !/^\d{1,5}\s+[\p{L}\d]/u.test(address)) continue
      const words = heading.split(/\s+/)
      const companyAndPlace = words.some((_, index) => norm(words.slice(0, index + 1).join(' ')) === key && requestedPlaces.has(norm(words.slice(index + 1).join(' '))))
      // An office directory heading must be the place alone or the exact company followed by the place.
      if (!(companyAndPlace || (ownSection && requestedPlaces.has(norm(heading)))) || !agrees(address, true)) continue
      return { url, excerpt: `${heading}: ${address}` }
    }
  }
  return undefined
}

// onPage (optional) sees the raw HTML of every own-site page read; used only by the email finder (EMAIL_GUESS_ENABLED).
// buyerRoles (optional): the scan ICP's "who" roles. Listed people whose title shares ICP words are kept first, so for a
// payroll seller "Head of HR" is not crowded out by a CTO; seniority breaks ties. Without it, seniority only (as before).
// budgetMs: an intrinsic wall-clock bound for the WHOLE crawl (#871) - robots, home, every polite wait, every own-site page and the
// social branch. A fetch never starts once the budget is spent, a polite gap that would outlive it is not waited out, and every fetch
// is handed a combined caller-abort + deadline signal so a bound or aborted crawl CANCELS the in-flight native fetch. The value is
// always finite and positive (crawlBudgetBound): invalid or non-positive inputs become CRAWL_BUDGET_MS, never an unbounded crawl.
// The return names which bound stopped the crawl (stoppedBy); a budget stop before the homepage reads reason 'time_budget', a caller
// abort reads reason 'aborted', and both are treated as unread.
export async function crawlSite(site: string, get: Get = (url, opts) => rawGet(url, 0, TIMEOUT_MS, guardedLookup, opts?.signal, opts?.noRedirect), gapMs = GAP_MS, expectName?: string, social = false, signal?: AbortSignal, onPage?: (html: string, url: string, status: number) => void, buyerRoles?: string, budgetMs: number = CRAWL_BUDGET_MS, buyerDiscovery: { ownAbout: boolean; authorizedHints?: readonly string[] } | null = null): Promise<{ found: Found[]; reason: string; pages: number; tech?: TechHit[]; homeObs?: Observability; homeNorm?: string; homeText?: string; locationPages?: LocationPage[]; stoppedBy?: 'pages' | 'time' | 'aborted'; buyerPages?: number; withoutHint?: { url: string; found: Found[]; reason: string } }> {
  const origin = `https://${site}`
  const stopped = () => signal?.aborted ?? false
  const deadline = Date.now() + crawlBudgetBound(budgetMs)
  let stoppedBy: 'pages' | 'time' | 'aborted' | undefined
  let timeStop = false
  let abortStop = false
  // One controller fires at the deadline; every fetch gets caller-abort + deadline combined, so a bound crawl
  // CANCELS the in-flight native fetch (signal-honoring Gets) instead of abandoning it.
  const ctrl = new AbortController()
  const deadlineTimer = setTimeout(() => ctrl.abort(), Math.max(1, deadline - Date.now())); deadlineTimer.unref?.()
  try {
    const fetchSignal = (): AbortSignal | undefined => (signal ? (AbortSignal as unknown as { any(s: AbortSignal[]): AbortSignal }).any([signal, ctrl.signal]) : ctrl.signal)
    const polite = async (url: string, delay: number, noRedirect = false) => {
      const h = new URL(url).hostname
      if (stopped()) { abortStop = true; return null } // a pre-aborted caller starts nothing
      if (Date.now() >= deadline) { timeStop = true; return null } // never start a fetch after the budget
      const wait = (lastHit.get(h) ?? 0) + Math.max(gapMs, delay) - Date.now()
      if (wait > 0) {
        if (Date.now() + wait >= deadline) { timeStop = true; return null } // the polite gap itself would outlive the budget
        if (!(await sleepAbort(wait, signal))) { abortStop = true; return null }
        if (stopped()) { abortStop = true; return null }
        if (Date.now() >= deadline) { timeStop = true; return null }
      }
      lastHit.set(h, Date.now())
      // The race bounds the WAIT for any Get; the combined signal CANCELS the operation for signal-honoring Gets.
      // A caller abort interrupts immediately; it never waits out the deadline.
      const left = Math.max(1, deadline - Date.now())
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      const interrupted = new Promise<null>(res => {
        // The deadline's OWN interruption: it marks the time stop and cancels the fetch BEFORE the race can resolve,
        // so the label and the cancel never depend on timer-jitter against Date.now().
        timer = setTimeout(() => { timeStop = true; ctrl.abort(); res(null) }, left)
        if (signal) { onAbort = () => { abortStop = true; res(null) }; if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }) }
      })
      try {
        const r = await Promise.race([get(url, { signal: fetchSignal(), ...(noRedirect ? { noRedirect } : {}) }), interrupted])
        if (stopped()) abortStop = true
        // ctrl is aborted ONLY by the deadline (its timer or the per-fetch race timer), so an interrupted fetch under an
        // aborted ctrl is the deadline's own act - no Date.now() jitter decides the label. A self-failing get keeps neither flag.
        else if (r === null && ctrl.signal.aborted) timeStop = true
        else if (r === null && Date.now() >= deadline) timeStop = true // backstop: the fetch outlived the budget (and was handed the cancel signal)
        return r
      } finally {
        clearTimeout(timer) // cleared on resolve, throw AND reject: a settled race never leaves its budget timer or listener behind
        if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      }
    }
    const rob = await polite(`${origin}/robots.txt`, 0)
    if (!rob) return timeStop ? { found: [], reason: 'time_budget', pages: 0, stoppedBy: 'time' } : (abortStop || stopped()) ? { found: [], reason: 'aborted', pages: 0, stoppedBy: 'aborted' } : { found: [], reason: 'robots_unreachable', pages: 0 }
    if (rob.status >= 500) return { found: [], reason: 'robots_error', pages: 0 }
    const robots: Robots = rob.status >= 400 ? { allows: () => true, delayMs: 0 } : parseRobots(rob.body, site)
    if (!robots.allows('/')) return { found: [], reason: 'robots_disallow', pages: 0 }
    const home = await polite(`${origin}/`, robots.delayMs)
    if (!home || home.status >= 400) return timeStop ? { found: [], reason: 'time_budget', pages: 0, stoppedBy: 'time' } : (abortStop || stopped()) ? { found: [], reason: 'aborted', pages: 0, stoppedBy: 'aborted' } : { found: [], reason: 'site_unreachable', pages: 0 }
    // The normalised homepage text is returned so a later lead on the same domain is checked against it without a second fetch.
    const homePlain = home.text ?? plainText(home.body)   // #1122: the whole page's text (beyond the stored body's cap), in one linear pass
    const homeNorm = norm(homePlain)
    // Case-preserved text (capped) for the place-agreement check: an address like "Rome, NY 13440" needs its capitals.
    const homeText = homePlain.replace(/\s+/g, ' ').trim().slice(0, 30_000)
    if (expectName && !homeNorm.includes(norm(expectName))) return { found: [], reason: 'name_mismatch', pages: 1, homeNorm, homeText }
    const found = new Map<string, Found>(); let pages = 1, buyerPages = 0
    const locationPages: LocationPage[] = [subpageLocationFacts(home.finalUrl, home.body)]
    onPage?.(home.body, home.finalUrl, home.status)
    for (const f of [...extractContacts(home.body, home.finalUrl, site), ...extractPeople(home.body, home.finalUrl, buyerRoles)]) found.set(f.kind + f.value, f)
    const homePage = new URL(home.finalUrl)
    const paths: ({ path: string } & Partial<Pick<BuyerBio, 'name' | 'expectedValue'>>)[] = contactPaths(home.body, homePage, !!buyerRoles).map(path => ({ path }))
    // The public robots response only authorizes this exact origin. A home
    // redirect to a www alias (or redirected robots response) is not authority
    // for direct exact buyer reads there. Ordinary crawl paths are unchanged.
    const exactBuyerOrigin = homePage.origin === origin && rob.finalUrl === `${origin}/robots.txt`
    const linkedAbout = exactBuyerOrigin && buyerDiscovery?.ownAbout && buyerRoles ? linkedBuyerAboutPath(home.body, homePage) : null
    // The caller supplies hints only after an independent exact owned-origin
    // observation. Recheck origin after the normal homepage name check above.
    const citedAbout = exactBuyerOrigin && expectName && buyerRoles
      ? buyerDiscovery?.authorizedHints?.map(buyerSourceCitation).find(u => u?.origin === homePage.origin)?.pathname ?? null : null
    const buyerPaths = [...new Set([linkedAbout, citedAbout].filter((p): p is string => !!p))]
    if (buyerPaths.length) {
      for (const p of buyerPaths) {
        const existing = paths.findIndex(x => x.path === p)
        if (existing >= 0) paths.splice(existing, 1)
      }
      // Preserve the first directory; a cited source is a fallback, not an
      // extra read beyond the existing site page and time bounds.
      paths.splice(paths[0] && BUYER_DIRECTORY_PATH.test(paths[0].path) ? 1 : 0, 0, ...buyerPaths.map(path => ({ path })))
    }
    let linkedBuyerProved = false
    let parsedLinkedTarget: string | undefined
    let citedOnlyUrl: string | undefined
    let queuedBio = false
    for (const { path: p, name, expectedValue } of paths) {
      if (stopped()) { stoppedBy = 'aborted'; break }
      if (pages >= MAX_PAGES) { stoppedBy = 'pages'; break }
      if (deadline && Date.now() >= deadline) { stoppedBy = 'time'; break }
      if (p === citedAbout && p !== linkedAbout && linkedBuyerProved) continue
      if (!robots.allows(p)) continue
      const exactBuyerRead = buyerPaths.includes(p)
      let requested = exactBuyerRead ? new URL(p, homePage).href : origin + p
      // Do not spend another ordinary page slot on an exact target we already
      // parsed. A directory-bound bio retains its separate identity checks.
      if (!exactBuyerRead && !name && !expectedValue && requested === parsedLinkedTarget) continue
      let followedLinkedRedirect = false
      let r = await polite(requested, robots.delayMs, exactBuyerRead)
      // Independently homepage-linked pages may redirect once to a supported
      // own About/team path. Check exact origin and robots before transport.
      // A designated citation never gets this exception.
      if (p === linkedAbout && p !== citedAbout && r?.redirect &&
          [301, 302, 307, 308].includes(r.status) && r.finalUrl === requested) {
        let target: URL | null
        try { target = new URL(r.redirect, requested) } catch { target = null }
        if (!target || target.origin !== origin || target.href === requested || !buyerSourceCitation(target.href) || !robots.allows(target.pathname)) continue
        requested = target.href
        followedLinkedRedirect = true
        r = await polite(requested, robots.delayMs, true)
      }
      if (!r || r.status >= 400) continue
      pages++
      if (exactBuyerRead && (r.status !== 200 || r.finalUrl !== requested)) continue
      let page: URL
      try { page = new URL(r.finalUrl) } catch { continue }
      const buyerPage = sameCompanyPage(page, homePage) && PEOPLE_PAGE.test(page.pathname)
      // A redirected bio provides no contact, location or person evidence.
      if (name && (!buyerPage || page.pathname.replace(/\/+$/, '') !== p.replace(/\/+$/, ''))) continue
      const citedOnly = p === citedAbout && p !== linkedAbout
      if (citedOnly) citedOnlyUrl = r.finalUrl
      onPage?.(r.body, r.finalUrl, r.status)
      if (!citedOnly && r.finalUrl.length <= 500 && page.hostname.replace(/^www\./, '') === site.replace(/^www\./, '')) locationPages.push(subpageLocationFacts(r.finalUrl, r.body))
      if (buyerPage) buyerPages++
      // Require the exact directory name, and preserve extractPeople's role/anti-quote rules.
      const people = extractPeople(r.body, r.finalUrl, buyerRoles)
      if (followedLinkedRedirect && buyerPage && r.body.trim()) parsedLinkedTarget = requested
      const boundPeople = people.filter(f => !name || f.value.split(', ')[0] === name)
      if (p === linkedAbout && buyerRoles) {
        const cards = strictOwnContactCards(r.body, page.hostname.replace(/^www\./, ''))
        linkedBuyerProved = people.some(f => buyerTitle(titleOf(f), buyerRoles) &&
          cards.some(c => `${c.name}, ${c.quote}`.replace(/\s+/g, ' ') === f.value))
      }
      // When a directory already named the buyer, the bio cannot change their role or add a second identity.
      if (expectedValue && (boundPeople.length !== 1 || boundPeople[0].value !== expectedValue)) continue
      if (name && buyerRoles && boundPeople.length === 1 && buyerTitle(titleOf(boundPeople[0]), buyerRoles)) {
        const label = linkedBioProfile(r.body, name)
        if (label) boundPeople[0] = { ...boundPeople[0], label }
      }
      for (const f of [...extractContacts(r.body, r.finalUrl, site), ...boundPeople]) {
        const key = (citedOnly ? 'cited:' : '') + f.kind + f.value
        if (!found.has(key) || (expectedValue === f.value && f.kind === 'person' && profileFromListedLabel(f.label))) found.set(key, f)
      }
      if (p !== citedAbout && buyerRoles && buyerPage && !name && !queuedBio) {
        // With a populated directory, spend the one bio slot only on an existing role match with a unique exact name.
        const listed = new Map<string, string>()
        for (const person of people) {
          const listedName = person.value.split(', ')[0]
          if (buyerTitle(titleOf(person), buyerRoles) && people.filter(x => x.value.split(', ')[0] === listedName).length === 1) listed.set(listedName, person.value)
        }
        const bio = linkedBuyerBio(r.body, page, people.length === 0 ? null : listed)
        if (bio && !paths.some(x => x.path === bio.path)) {
          // Reserve at most one slot, without exceeding MAX_PAGES or the existing deadline.
          queuedBio = true
          paths.splice(paths.findIndex(x => x.path === p) + 1, 0, bio)
        }
      }
    }
    // Social bio adapter (flag SITECRAWL_SOCIAL=1). Same hard robots rule, per host. In practice x.com, facebook.com, linkedin.com and
    // instagram.com disallow our user agent, so this fetches nothing from them; it exists for smaller platforms that allow it.
    if (social) {
      const links = new Set<string>()
      for (const m of home.body.matchAll(/href\s*=\s*["'](https:\/\/(?:www\.)?(?:x\.com|twitter\.com|facebook\.com|linkedin\.com\/company|instagram\.com)\/[^"'#?\s]{1,80})["']/gi)) links.add(m[1])
      for (const link of [...links].slice(0, 3)) {
        const u = new URL(link)
        const rr = await polite(`https://${u.hostname}/robots.txt`, 0)
        if (!rr || rr.status >= 500) continue
        const rob2 = rr.status >= 400 ? { allows: () => true, delayMs: 0 } : parseRobots(rr.body, u.hostname)
        if (!rob2.allows(u.pathname, u.hostname)) continue // hard rule
        const pg = await polite(link, rob2.delayMs)
        if (!pg || pg.status >= 400) continue
        for (const f of extractContacts(pg.body, pg.finalUrl, site)) if (!found.has(f.kind + f.value)) found.set(f.kind + f.value, { ...f, label: 'published on the company social profile' })
      }
    }
    // Addresses and phones keep their cap; listed people ride separately so they never crowd an address out, and never turn 'none_published' into 'ok'.
    const select = (omit?: string) => {
      const unique = new Map<string, Found>()
      for (const f of found.values()) if (f.url !== omit && !unique.has(f.kind + f.value)) unique.set(f.kind + f.value, f)
      const all = [...unique.values()], contacts = all.filter(f => f.kind !== 'person'), people = all.filter(f => f.kind === 'person')
      return { found: [...contacts.slice(0, 6), ...people.sort(buyerRoles ? byBuyerThenSeniority(buyerRoles) : bySeniority).slice(0, 3)], reason: contacts.length ? 'ok' : 'none_published' }
    }
    const sb = stoppedBy ?? (timeStop ? 'time' as const : abortStop ? 'aborted' as const : undefined)
    return { ...select(), ...(citedOnlyUrl ? { withoutHint: { url: citedOnlyUrl, ...select(citedOnlyUrl) } } : {}), buyerPages, pages, tech: detectTech(home.body), homeObs: observability(home.status, home.body), homeNorm, homeText, locationPages, ...(sb ? { stoppedBy: sb } : {}) }
  } finally {
    clearTimeout(deadlineTimer) // cleared on EVERY exit - return, throw or reject (#871 CI: a rejecting Get leaked the 45s budget timer and held the child past the 60s spawn timeout)
  }
}

// #389: one dated tech_scan row per crawl of a confirmed company homepage, and a tech_change row on this lead for every adoption / removal
// that this tenant's comparable observations of the same domain confirm (rules: lib/signals/tech-observations.ts). Reads only rows this
// crawler wrote; a crawl without an observability verdict records no row. Returns what it did, for the branch ledger (TECH_AUDIT).
export type TechRecord = { status: string; rows: number }
export function recordTechObservation(db: Database.Database, tenantId: string, leadId: string, site: string, r: { tech?: TechHit[]; homeObs?: Observability; pages?: number }, at: number): TechRecord {
  const pages = typeof r.pages === 'number' && Number.isSafeInteger(r.pages) && r.pages >= 0 ? r.pages : 0
  if (!r.homeObs) return { status: `no_observation: no homepage verdict; pages ${pages}`, rows: 0 }
  if (!isScanDomain(site)) return { status: `no_observation: not a comparable domain; pages ${pages}`, rows: 0 }
  const scan = scanOf(site, at, r.homeObs, (r.tech ?? []).map(t => t.name))
  const enc = encodeScan(scan)
  if (!enc) return { status: `no_observation: observation not recordable; pages ${pages}`, rows: 0 }
  const date = new Date(at * 1000).toISOString().slice(0, 10)
  addEnrichment(db, tenantId, leadId, { connector: 'sitecrawl', kind: TECH_SCAN_KIND, value: enc.value, label: enc.label, confidence: null, source_url: scan.url, source_date: date, retrieved_at: at })
  const rows = db.prepare("SELECT value, label, source_url FROM lead_enrichments WHERE tenant_id = ? AND connector = 'sitecrawl' AND kind = ? AND value LIKE ?").all(tenantId, TECH_SCAN_KIND, `${site}|%`) as { value: string; label: string | null; source_url: string }[]
  const history = rows.map(x => decodeScan(x.value, x.label, x.source_url)).filter((s): s is TechScan => !!s)
  const changes = techChanges(history, site)
  for (const c of changes) {
    const row = changeRow(c)
    addEnrichment(db, tenantId, leadId, { connector: 'sitecrawl', kind: TECH_CHANGE_KIND, value: row.value, label: row.label, confidence: null, source_url: row.source_url, source_date: row.source_date, retrieved_at: at })
  }
  return { status: `observed ${r.homeObs}: ${scan.present.length} technologies, ${changes.length} changes; pages ${pages}`, rows: 1 + changes.length }
}

// #389 branch ledger: one connector_audit row per crawled site under this connector, so a crawl that ran the technology branch is always
// told apart from one that did not. 'observed <verdict>' (a tech_scan row was written; results = rows written), 'no_observation: <why>'
// (the crawl ran, the homepage gave nothing comparable), 'error: <name>' (the branch itself failed: never read as zero rows) or 'disabled'
// (TECH_SCAN_ENABLED=0: the branch did not run, and wrote nothing). Read by the run report's 'tech' stage (runner.ts).
export const TECH_AUDIT = 'sitecrawl:tech'
export const techScanEnabled = (env: Record<string, string | undefined> = process.env) => env.TECH_SCAN_ENABLED !== '0'
// A closed code, never the message: an error's own text can echo a value (a URL, a token, a provider body), and this status is stored
// and shown in the run report. Only an error class name of plain letters passes; anything else is 'unknown'.
const errName = (e: unknown) => { const n = e instanceof Error ? e.name : ''; return typeof n === 'string' && /^[A-Za-z]{1,40}$/.test(n) ? n : 'unknown' }
export function techBranch(db: Database.Database, tenantId: string, jobId: string, leadId: string, site: string, r: { tech?: TechHit[]; homeObs?: Observability; pages?: number }, at: number, env?: Record<string, string | undefined>): void {
  let out: TechRecord
  if (!techScanEnabled(env ?? process.env)) out = { status: 'disabled', rows: 0 }
  else {
    try { out = recordTechObservation(db, tenantId, leadId, site, r, at) } catch (e) { out = { status: `error: ${errName(e)}`, rows: 0 } }
  }
  // the ledger write itself never blocks the crawl (an old schema without connector_audit)
  try { audit(db, { tenantId, connector: TECH_AUDIT, jobId, lookup: site, status: out.status.slice(0, 180), results: out.rows }) } catch { /* nothing to record into */ }
}

// Runs for one finished scan. Never throws, never touches the lead row, one audit row per site.
// deps.leads overrides the lead selection (commenter import: imported rows carry no
// confidence); deps.skipEvidenceFetch skips fetching the lead's source_url (commenter
// import again: the URL is stored provenance that must never be fetched - the crawl
// goes straight to name-derived domain probing, confirmed by the homepage name check).

// Location consistency for GUESSED (name_probe) domains (issue #197): a same-name business in another city passed the
// homepage name check ("Smile Avenue Dental" is inside "Smile Avenue Dental Group", Pico Rivera CA, for a lead in
// Sunnyside NY) and its phones and people were attached. A guessed domain now also needs its homepage to name a place
// the lead is about: a place from the scan's own geography (ICP "where"), or a place the lead's evidence names after
// "in/at/on" (and the same prepositions in other languages). No known place, or no match: the domain is refused.
// Nothing here is a fixed list of places; the places come from the scan and the evidence.
const PLACE_SUFFIX = /\s+(city|metro|metropolitan area|area|region|county|state|province|district)$/i
const PLACE_AFTER = /\b(?:in|at|on|em|en|no|na|à|au|bei|im|nel|nella|op|w|в)\s+((?:[A-Z][\p{L}'’.-]+)(?:\s+[A-Z][\p{L}'’.-]+){0,2})/gu
// Words the evidence puts after "on / in / at" that are NOT places: weekdays, months and the company's own name ("open on Monday", "founded in March", "book at Smile Avenue Dental"). Any business page
// mentions them, so counting them as places let a same-name site in another city look "consistent".
const NOT_PLACE = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'today', 'tomorrow', 'yesterday', 'the', 'our', 'your', 'this', 'that', 'twitter', 'facebook', 'instagram', 'linkedin', 'youtube', 'google'])
// A phrase that starts with a determiner or pronoun ("at Your Convenience", "in Our Offices", "on This Page") is a phrase, not a place.
const NOT_PLACE_LEAD = new Set(['your', 'our', 'my', 'their', 'his', 'her', 'its', 'this', 'that', 'these', 'those', 'any', 'every', 'each', 'all', 'some', 'no', 'one', 'both', 'the'])
export function placeTerms(where: string[], evidenceText: string, company = ''): string[] {
  const own = norm(company).split(' ').filter(Boolean), out = new Set<string>()
  const add = (s: string) => { const t = norm(s); if (t.length >= 4) out.add(t) }
  for (const w of where) {
    const clean = w.replace(/[()"]/g, ' ').replace(/\s+/g, ' ').trim()
    add(clean); add(clean.replace(PLACE_SUFFIX, ''))
    for (const part of clean.split(',')) { add(part); add(part.trim().replace(PLACE_SUFFIX, '')) }
  }
  // 1289-P1: a capture stops at a sentence end ("at Mercury. Apply now" is "Mercury", not the made-up place "Mercury Apply"); a short abbreviation ("St. Louis") does not end it.
  const toSentenceEnd = (s: string) => { const out: string[] = []; for (const w of s.split(/\s+/)) { if (w.endsWith('.') && w.replace(/\.+$/, '').length > 2) { out.push(w.replace(/\.+$/, '')); break } out.push(w) } return out.join(' ') }
  for (const m0 of evidenceText.slice(0, 6000).matchAll(PLACE_AFTER)) { const m = [m0[0], toSentenceEnd(m0[1])]; const t = norm(m[1]); const ws = t.split(' ').filter(Boolean); if (ws.length === 0 || ws.every(w => NOT_PLACE.has(w) || own.includes(w)) || NOT_PLACE_LEAD.has(ws[0])) continue; add(m[1]) }
  return [...out]
}
// A domain taken from a NAME-ONLY guess (probeDomains) is not an identity: any same-name business anywhere passes the homepage name check, and its contacts sit on that same domain, so the domain and the
// contacts "agree" with each other. Only the site's OWN location can tell the lead's company from a namesake: the homepage must state a place that POSITIVELY agrees with the scan's geography, or a street
// address that is the lead's own (from its evidence). Words the lead's evidence merely puts after "on / in / at" ("on Monday", "in March", "at Smile Avenue Dental") are not places and no longer count.
// With no scan geography, a place the lead's own evidence names (filtered as below) that the homepage repeats, or an address match, accepts the guess. Anything else: the domain is not saved and no contact is attached.
// A homepage that prints a full "City, ST 12345" address is giving the SITE OWNER's own address (that is what an address line on a company's own page is). When none of those addresses is in the asked state
// and the asked place does not appear in one, the page belongs to a business somewhere else - however many times it also names the asked city as an area it serves.
const ZIP_ADDRESS = /([A-Z][\p{L}'.-]+(?: [A-Z][\p{L}'.-]+){0,2}),\s*([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/gu
export function ownAddressElsewhere(home: string, where: string[]): boolean {
  const terms = geoTerms(where)
  const ours = new Set(Object.entries(US_STATES).filter(([ab, name]) => terms.some(x => x === name || x === ab.toLowerCase() || x.endsWith(`, ${ab.toLowerCase()}`))).map(([ab]) => ab))
  let elsewhere = false, here = false
  for (const m of home.matchAll(ZIP_ADDRESS)) { if (!(m[2] in US_STATES)) continue; if (ours.has(m[2])) here = true; else elsewhere = true }
  return elsewhere && !here
}
const CITY_STATE = /([A-Z][\p{L}'.-]+(?: [A-Z][\p{L}'.-]+){0,2}),?\s+([A-Z]{2})\b/gu
function writtenAsCityState(home: string, place: string): boolean {
  for (const m of home.matchAll(CITY_STATE)) { if (m[2] in US_STATES && norm(m[1]) === place) return true }
  return false
}
// All guessed domains use this same verification regardless of public suffix.
function probeScopeAgreement(text: string, where: string[], company: string, alreadyBound = false) {
  const verdict = placeAgreement(text, where, company)
  if (verdict === 'mismatch' || verdict === 'no_geography') return verdict
  const scopes = where.map(w => w.split(',').map(s => s.trim()).filter(Boolean)).filter(parts => parts.length)
  const qualified = scopes.some(parts => parts.some(isCountryOrRegion))
  const separated = scopes.flatMap(([head, ...tail]) => !isCountryOrRegion(head) && (tail.some(isCountryOrRegion) || qualified) ? [head] : [])
  const regions = scopes.flatMap(([head]) => regionOf(head) ? [trimCanadianPostalTail(head)] : [])
  const narrow = separated.length ? separated : regions
  if (!narrow.length) return verdict
  if (verdict === 'agrees' && ownProbePlace(text, narrow, company, alreadyBound)) return verdict
  return 'scope_unconfirmed'
}
export function probeLocationAgrees(home: string | undefined, where: string[], lead: { company: string; signal?: string | null; evidence_excerpt?: string | null }, evidence?: { homeNorm: string | undefined; places: string[] }): boolean {
  const text = home ?? ''
  if (!text) return false
  if (where.length > 0 && ownAddressElsewhere(text, where)) return false   // the site's own address is in another state
  if (where.length > 0) {
    const verdict = probeScopeAgreement(text, where, lead.company)
    if (verdict === 'agrees') return true
    if (verdict === 'mismatch' || verdict === 'scope_unconfirmed') return false
  }
  // A scan that declares NO geography has only the lead's evidence to say where it is: a place that evidence names (weekdays, months, social names and the company's own name excluded) and the site's homepage repeats.
  // ...and with no declared geography the repeated place must be written as a place on the homepage ("City, ST"), not merely appear in running text.
  if (where.length === 0 && evidence && placeConsistent(evidence.homeNorm, evidence.places) && evidence.places.some(p => writtenAsCityState(text, p))) return true
  return addressAgreement(text, `${lead.evidence_excerpt ?? ''} ${lead.signal ?? ''}`) === 'agrees'
}
function locationRefusal(probe: boolean, havePlaces: boolean, home: string | undefined, where: string[]): string {
  if (probe) {
    const label = firstPlaceLabel(home ?? '')
    return (where.length > 0 && home && placeAgreement(home, where) === 'mismatch' ? `contact rejected: location mismatch ${label ?? 'another place'} vs ${leadPlaceLabel(where)}` : where.length > 0 ? `contact rejected: location unconfirmed ${label ?? 'no place stated'} vs ${leadPlaceLabel(where)} (a guessed domain needs the site's own location)` : 'contact rejected: no location to confirm the company').slice(0, 180)
  }
  return havePlaces ? `contact rejected: location mismatch ${firstPlaceLabel(home ?? '') ?? 'another place'} vs ${leadPlaceLabel(where)}` : 'contact rejected: no location to confirm the company'
}
export const placeConsistent = (homeNorm: string | undefined, places: string[]) => !!homeNorm && places.some(p => homeNorm.includes(p))

// #1036: where a printed address sits on the page, for single-name addresses (email-pattern.ts singleNamePairing). Up to 12 places per
// page (#1173). tight: the attribute value holding the address, or its own text node; wide: the text around it (markup characters turned into
// spaces, attribute values kept; a mailto href is never a pairing). `at`: the places personalAddresses recorded in its single pass; the page is never searched again here.
export function addressContexts(html: string, at: { i: number; len: number }[]): AddressContext[] {
  const out: AddressContext[] = []
  for (const { i, len } of at.slice(0, 12)) {
    const end = i + len
    const back = html.slice(Math.max(0, i - 300), i), fwd = html.slice(end, end + 300)
    let tight = '', attrName = ''
    const q = Math.max(back.lastIndexOf('"'), back.lastIndexOf("'"))
    const quote = q >= 0 ? back[q] : ''
    const inAttr = q >= 0 && !/[<>]/.test(back.slice(q)) && /=\s*$/.test(back.slice(0, q)) && fwd.includes(quote) && !/[<>]/.test(fwd.slice(0, fwd.indexOf(quote)))
    if (inAttr) { tight = back.slice(q + 1) + html.slice(i, end) + fwd.slice(0, fwd.indexOf(quote)); attrName = (/([A-Za-z_:][-\w:.]*)\s*=\s*$/.exec(back.slice(0, q))?.[1] ?? '').toLowerCase() }
    else {
      const gt = back.lastIndexOf('>'), lt = fwd.indexOf('<')
      if (gt >= 0 && lt >= 0 && !back.slice(gt).includes('<')) tight = back.slice(gt + 1) + html.slice(i, end) + fwd.slice(0, lt)
    }
    // #1173. `tight` is never cut (it is bounded by the two 300-character windows): a cut could hide a second person named later in
    // the same attribute. Whitespace is treated as the page shows it: inside an attribute value or a <pre>, a tab or newline is kept
    // (it separates records: "Ana Maya<tab>Thornton Lee" is two people); in ordinary text it is a space, as a browser renders it.
    let pre = false
    if (!inAttr) { const b2 = html.slice(Math.max(0, i - 2000), i); pre = Math.max(b2.lastIndexOf('<pre'), b2.lastIndexOf('<PRE')) > Math.max(b2.lastIndexOf('</pre'), b2.lastIndexOf('</PRE')) }
    tight = inAttr || pre ? tight.replace(/ {2,}/g, ' ') : tight.replace(/\s+/g, ' ')
    // Only a data-* attribute can pair an address with a person on its own (a team card's own record). Any other attribute - a
    // mailto href whose subject names someone, a title, a share link - is judged with the text around it; a mailto is never a pairing.
    const mailto = inAttr && /^\s*mailto:/i.test(tight)
    // `wide`: the text around the place as a reader meets it. Tags become spaces; of a tag's attributes only the name-bearing ones
    // (alt, title, aria-label, data-*) are kept, so another person named only in an img alt is seen while URL slugs, file names and
    // class names ("/agent/nora-wall", "nora.jpg") are not mistaken for a second person.
    let win = html.slice(Math.max(0, i - 400), end + 400)
    const firstGt = win.indexOf('>'), firstLt = win.indexOf('<')
    if (firstGt >= 0 && (firstLt < 0 || firstGt < firstLt)) win = win.slice(firstGt + 1)   // a tag cut in half at the window's start
    const lastLt = win.lastIndexOf('<'); if (lastLt > win.lastIndexOf('>')) win = win.slice(0, lastLt) // ... and at its end
    const wide = win.replace(/<[^>]*>/g, tag => tag.length < 12 || !/alt=|title=|aria-label=|data-/i.test(tag) ? ' ' : ` ${[...tag.matchAll(/\b(?:alt|title|aria-label|data-[\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map(m => m[1] ?? m[2] ?? '').join(' | ')} `)
      .replace(/\s+/g, ' ').slice(0, 900)
    out.push({ tight: mailto ? '' : tight, wide, attr: inAttr && !mailto && attrName.startsWith('data-'), ...(inAttr ? {} : { text: true }) })
  }
  return out
}

// ---- #1122: why a lead has no company website, and following a guessed domain that only forwards to the real one ----
// A forwarding target is offered only when its OWN name is the company's: the same test a searched host passes (companyHostsFromSearch: the
// name, with at most one generic affix or place word), or the company's initials ("qsdc" for "Queen Street Dental Centre", three letters or
// more). A company-named domain that was sold and now forwards to a chain's portal, a directory or a marketplace ("123dentist.com") fails
// this, however clearly that portal's homepage lists the company and its city: that page is about the company, not the company's (council).
export function redirectTargetIsCompanys(target: string, company: string, places: string[] = []): boolean {
  if (!siteHostOk(target)) return false
  if (companyHostsFromSearch(company, [{ url: `https://${target}/` }], 1, places).length > 0) return true
  const initials = company.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^A-Za-z0-9]+/).filter(w => w && !/^(the|and|of|inc|llc|ltd|co)$/i.test(w)).map(w => w[0].toLowerCase()).join('')
  return initials.length >= 3 && nameLabel(target).replace(/[^a-z0-9]/g, '') === initials && !NOT_OWN_SITE.has(initials)
}

// The named reason beside the lead (one row, replaced on a re-run, removed once a site is confirmed): no domain was kept, and why. Never a
// contact, never a domain row. A lead that already has a confirmed domain keeps it: one failed re-read is not "no website".
function recordDomainUnresolved(db: Database.Database, tenantId: string, l: { id: string; source_url: string }, code: string, today: string, now: number): void {
  try {
    if ((db.prepare('SELECT l.company_domain FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(l.id, tenantId) as { company_domain: string | null } | undefined)?.company_domain) return
    db.prepare('DELETE FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = ? AND kind = ?').run(l.id, tenantId, 'sitecrawl', DOMAIN_UNRESOLVED_KIND)
    addEnrichment(db, tenantId, l.id, { connector: 'sitecrawl', kind: DOMAIN_UNRESOLVED_KIND, value: 'No company website confirmed', label: `${DOMAIN_UNRESOLVED_TOKEN}${code}`.slice(0, 200), confidence: null, source_url: /^https?:\/\//.test(l.source_url) ? l.source_url.slice(0, 500) : 'https://invalid.example/', source_date: today, retrieved_at: now })
  } catch { /* the reason is a note beside the lead; never fails the crawl */ }
}
// Where a host's homepage forwards to when that is ANOTHER site (queenstreetdentalcentre.ca answers 301 -> www.qsdc.ca): the registrable
// host of the target, or null (no redirect, same site, not https, unreachable). One request, the body is never read; same SSRF-guarded
// resolver and timeout as the crawl's own fetch. The crawl's fetch itself refuses to leave a site, so without this a company-named domain
// that only forwards was recorded as unreachable.
export function rawRedirectTarget(host: string, timeoutMs = TIMEOUT_MS, lookup: typeof guardedLookup = guardedLookup, signal?: AbortSignal, hops = 0): Promise<string | null> {
  return new Promise(resolveRaw => {
    const timer: { h?: NodeJS.Timeout } = {}
    const resolve = (v: string | null | Promise<string | null>) => { clearTimeout(timer.h); resolveRaw(v as never) }
    let u: URL
    try { u = new URL(host.includes('://') ? host : `https://${host}/`) } catch { return resolve(null) }
    if (u.protocol !== 'https:' || u.username || u.password || hops > 2 || !siteHostOk(u.hostname)) return resolve(null)
    const req = https.request(u, { method: 'GET', lookup: lookup as never, timeout: timeoutMs, headers: { 'user-agent': UA, accept: 'text/html,text/plain;q=0.9', 'accept-encoding': 'identity' } }, res => {
      const status = res.statusCode ?? 0
      res.destroy()
      if (!(status >= 300 && status < 400 && res.headers.location)) return resolve(null)
      let next: URL
      try { next = new URL(String(res.headers.location), u) } catch { return resolve(null) }
      if (next.protocol !== 'https:') return resolve(null)
      if (next.hostname.replace(/^www\./, '') === u.hostname.replace(/^www\./, '')) return resolve(rawRedirectTarget(next.toString(), timeoutMs, lookup, signal, hops + 1))   // the same site (www, a path): look once more
      return resolve(siteHostOk(next.hostname) && !next.username && !next.password ? registrable(next.hostname) : null)   // never an IP literal, a single label or a URL with credentials
    })
    timer.h = setTimeout(() => { req.destroy(new Error('timeout')); resolve(null) }, timeoutMs)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => resolve(null))
    const onAbort = () => req.destroy(new Error('aborted'))
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }) }
    req.on('close', () => signal?.removeEventListener('abort', onAbort))
    req.end()
  })
}

// #1122/#1037 (#1334-F1): the held-lead reasons a whole-job crawl admits: the holds the people search reads, plus outside_window_undated,
// minus the holds where the event itself is over. Shared by the crawl's lead pick and its unreached-lead note.
export function crawlEligibleHolds(): string[] {
  return [...new Set(['outside_window_undated', ...SEARCHABLE_HOLDS])].filter(r => !EVENT_OVER_HOLDS.has(r))
}

export async function crawlJob(db: Database.Database, tenantId: string, jobId: string, deps: { citedUrls?: string[]; textSites?: { company: string; website: string }[]; buyerCitedUrls?: readonly string[]; atsLookup?: boolean; atsFetch?: typeof fetch; redirectOf?: (host: string) => Promise<string | null>; get?: Get; gapMs?: number; env?: Record<string, string | undefined>; now?: number; leads?: { id: string; company: string; source_url: string; review_reason?: string | null; signal?: string | null; evidence_excerpt?: string | null }[]; skipEvidenceFetch?: boolean; signal?: AbortSignal; concurrency?: number; nativeOnly?: boolean; companyFirstContacts?: boolean; onBuyerRead?: (event: { site: string; pages: number; stored: number }) => void; findSites?: ((company: string, where: string[]) => Promise<string[]>) & { recordSite?: (site: string, company: string) => boolean } } = {}): Promise<void> {
  try {
    if (!sitecrawlEnabled(deps.env)) return
    // Caller-supplied jobs and lead subsets are not an ownership boundary. Fail closed before any network or write.
    let ownedJob: { run_budget: string | null; attempts: number } | undefined
    try {
      ownedJob = db.prepare('SELECT run_budget, attempts FROM scan_jobs WHERE id = ? AND user_id = ?').get(jobId, tenantId) as typeof ownedJob
    } catch (error) {
      // A legacy database without this column cannot contain a flagged job.
      // Keep its ordinary crawl, but do not treat any other read error as unflagged.
      if (!(error instanceof Error) || !/^no such column: (?:run_budget|attempts)$/i.test(error.message)) throw error
      if (db.prepare('SELECT 1 FROM scan_jobs WHERE id = ? AND user_id = ?').get(jobId, tenantId)) ownedJob = { run_budget: null, attempts: -1 }
    }
    if (!ownedJob) return
    const companyFirstContacts = !!deps.companyFirstContacts || hasCompanyFirstBudget(ownedJob.run_budget)
    const nativeOnly = companyFirstContacts || !!deps.nativeOnly
    // The per-site crawl budget resolves per call (env-overridable, #871); an unparseable value falls back to the default bound.
    const crawlBudgetMs = crawlBudgetBound(Number((deps.env ?? process.env).SITECRAWL_CRAWL_BUDGET_MS ?? CRAWL_BUDGET_MS))
    // Signal threads only into the rawGet path; a crawl4ai backend keeps its
    // own 40s per-call bound (outer deadline does not reach it yet - tracked).
    const get = deps.get ?? (deps.signal && (nativeOnly || (!deps.env?.CRAWL4AI_URL && !process.env.CRAWL4AI_URL))
      ? (url, opts) => rawGet(url, 0, TIMEOUT_MS, guardedLookup, opts?.signal ?? deps.signal, opts?.noRedirect)
      : defaultGet(deps.env, nativeOnly))
    // signal and evidence_excerpt feed the location check; a leads table without them (older schema) still crawls.
    // Held leads whose evidence page could not be READ (blocked_by_site / needs_javascript) get the same identity attempt as the
    // date/quote classes: a blocked article says nothing about the company's own site. This never re-fetches the blocked evidence
    // page (below) and never clears the hold: identity/contact discovery only, qualification unchanged. Classes where the hold is
    // the event itself (job_closed, no_event_evidence, counterparty_signal, ...) are NOT selected - identity cannot change them.
    // #1122/#1037: every held lead whose company is still the named one gets a company website (and so a buyer search): the holds the
    // people search reads (searchable-holds.ts), plus outside_window_undated, except the classes where the hold is the event itself being
    // over (a closed job, a stale or out-of-window date, no event at all). Identity/contact discovery only: the hold is never cleared.
    // #1334-F1: ONE list decides both which held leads the crawl picks and, for leads past the top-lead cap, whether the note says
    // "did not reach this company" (eligible) or "the check does not run for this hold" (excluded), so the two can never drift apart.
    const CRAWL_HOLD_LIST = crawlEligibleHolds()
    const CRAWL_HOLDS = CRAWL_HOLD_LIST.map(r => `'${r.replace(/'/g, "''")}'`).join(',')
    const pick = (cols: string) => db.prepare(`SELECT ${cols} FROM leads WHERE scan_job_id = ? AND ((review_reason IS NULL AND confidence IS NOT NULL) OR review_reason IN (${CRAWL_HOLDS})) AND company <> '' ORDER BY (review_reason IS NOT NULL), score DESC LIMIT ?`).all(jobId, MAX_SITES_PER_SCAN)
    const supplied = deps.leads?.filter(l => !!db.prepare('SELECT 1 FROM leads WHERE id = ? AND scan_job_id = ?').get(l.id, jobId))
    const leads = (supplied ?? (() => { try { return pick('id, company, source_url, review_reason, signal, evidence_excerpt') } catch { return pick('id, company, source_url') } })()) as { id: string; company: string; source_url: string; review_reason?: string | null; signal?: string | null; evidence_excerpt?: string | null }[]
    // The scan's geography, for the location check on guessed domains.
    let where: string[] = []
    // Did the request name a place at all? The ICP's where, or (a legacy scan with no ICP) its stored location. Unknown counts as yes.
    let placeRequested = true
    try {
      const j = db.prepare('SELECT icp FROM scan_jobs WHERE id = ? AND user_id = ?').get(jobId, tenantId) as { icp: string | null } | undefined
      const w = j?.icp ? (JSON.parse(j.icp) as { where?: unknown }).where : null
      if (Array.isArray(w)) where = w.filter((x): x is string => typeof x === 'string')
      if (where.some(x => x.trim())) placeRequested = true
      else if (j?.icp) placeRequested = false
      else {   // legacy scan without an ICP: its stored location is the request's place (a schema without the column: unknown = requested)
        try { placeRequested = !!(db.prepare('SELECT location FROM scan_jobs WHERE id = ? AND user_id = ?').get(jobId, tenantId) as { location?: string | null } | undefined)?.location?.trim() } catch { placeRequested = true }
      }
    } catch { /* no ICP: evidence places only */ }
    // The display-only importer is optional. A missing policy must not erase ordinary crawl geography.
    let publishedDisplayOnly = false
    if (!companyFirstContacts && nativeOnly && !deps.leads) publishedDisplayOnly = qaClaudeOnlyJob(ownedJob.run_budget)
    const today = new Date((deps.now ?? Date.now())).toISOString().slice(0, 10)
    // One crawl per site per run. Another lead on the same domain is NOT skipped: its own identity check runs against the cached homepage
    // text (same name test, per lead), and it reuses the pages already read, so no extra fetch and no extra budget. Only when the first lead's
    // name was absent from the homepage but this lead's name is present is the site read once more, because the earlier read stopped at the
    // identity check. Site-level outcomes (robots, unreachable) are the same for every lead and are reused as they are.
    type Crawled = Awaited<ReturnType<typeof crawlSite>>
    const siteRead = new Map<string, Crawled>()
    const strictSeenForRead = new WeakMap<Crawled, Map<string, { cards: ReturnType<typeof strictOwnContactCards>; at: number }>>()
    type SharedReads = { deadline: number; pages: number; responses: Map<string, Awaited<ReturnType<Get>>>; fetchedAt: Map<string, number> }
    const sharedReads = new Map<string, SharedReads>()
    const hintedRead = new Map<string, { key: string; crawl: Crawled }>()
    const scopedBuyerHints = (deps.buyerCitedUrls ?? []).slice(0, 50).map(buyerSourceCitation).filter((u): u is URL => !!u)
    // Email finder part 1 (off by default): personal local parts published on each confirmed site, never shown or sent.
    const localsBySite = new Map<string, Set<string>>()
    const displaySeenBySite = new Map<string, Map<string, { address: string; url: string; ctx: AddressContext[]; literalLocals?: Set<string> }>>()
    const displayCountry = publishedDisplayOnly ? publishedDisplayCountry(where) : null
    if (displayCountry) withdrawPublishedDisplay(db, tenantId, leads.map(l => l.id))
    const seenBySite = new Map<string, Map<string, { address: string; url: string; ctx?: AddressContext[] }>>() // email finder: printed addresses + page
    // The scan's buyer roles (ICP "who"), so the 3 people kept per site are the ones the seller wants to reach.
    let buyerRoles: string | undefined
    try { const j = db.prepare('SELECT icp FROM scan_jobs WHERE id = ?').get(jobId) as { icp: string | null } | undefined; const who = j?.icp ? (JSON.parse(j.icp) as { who?: unknown }).who : null; if (Array.isArray(who) && who.length) buyerRoles = who.filter(x => typeof x === 'string').join('; ').slice(0, 600) } catch { /* no ICP: seniority only */ }
    // #1037: with leads read concurrently, two leads on the same site never crawl it twice at once: the second waits for the first read and
    // then takes the cached path below (same per-lead name check), so per-host politeness and the one-crawl-per-site rule both hold.
    const inflight = new Map<string, Promise<unknown>>()
    const readSite = async (cand: string, company: string, authorizedHints?: readonly string[]): Promise<Crawled> => {
      while (inflight.has(cand)) await inflight.get(cand)!.catch(() => undefined)
      const hintKey = authorizedHints?.join('\n') ?? ''
      const alreadyHinted = hintedRead.get(cand)
      const c = hintKey && alreadyHinted?.key === hintKey ? alreadyHinted.crawl : siteRead.get(cand)
      const canReplay = !!hintKey && !!c && c.reason !== 'name_mismatch' && !alreadyHinted &&
        (sharedReads.get(cand)?.deadline ?? 0) > Date.now()
      if (c) {
        if (c.homeNorm === undefined) return c
        if (!c.homeNorm.includes(norm(company))) return { found: [], reason: 'name_mismatch', pages: 0 }
        if (c.reason !== 'name_mismatch' && !canReplay) return c
      }
      const locals = new Set<string>(); localsBySite.set(cand, locals)
      const seen = new Map<string, { address: string; url: string; ctx?: AddressContext[] }>(); seenBySite.set(cand, seen)
      const displaySeen = new Map<string, { address: string; url: string; ctx: AddressContext[]; literalLocals?: Set<string> }>()
      if (displayCountry) displaySeenBySite.set(cand, displaySeen)
      // Every page the crawl fetches is recorded with its exact URL and its own completion time (#871); the email
      // finder keeps riding the same callback when enabled. The crawl runs under an intrinsic wall-clock budget so a
      // slow host or a polite per-host gap cannot stretch one site's read past CRAWL_BUDGET_MS.
      const strictSeen = new Map<string, { cards: ReturnType<typeof strictOwnContactCards>; at: number }>()
      const onPage = (html: string, url: string, status: number) => {
        const at = sharedReads.get(cand)?.fetchedAt.get(url) ?? Math.floor((deps.now ?? Date.now()) / 1000)
        if (companyFirstContacts) {
          recordCrawlPage(db, tenantId, jobId, cand, url, status, at)
          if (status === 200 && !strictSeen.has(url)) {
            const page = new URL(url)
            if (page.protocol === 'https:' && !page.port && !page.username && !page.password && !page.search && !page.hash &&
                page.href === url && page.hostname.replace(/^www\./, '') === cand) {
              strictSeen.set(url, { cards: strictOwnContactCards(html, page.hostname.replace(/^www\./, '')), at })
            }
          }
          return // no reveal, inferred pattern, guessed or alternative display addresses
        }
        if (displayCountry && status === 200) {
          // Display-only observations require the literal address; do not decode obfuscation here.
          // An opaque token prevents both joining fragments and treating a partial token as a whole address.
          const visible = html.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style|noscript|svg|template|blockquote)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '\uFFFC')
          for (const a of personalAddresses(visible, cand, true)) {
            if (displaySeen.size >= 200) break
            displaySeen.set(`${url}|${a.address}`, { address: a.address, url, ctx: addressContexts(visible, a.at), literalLocals: a.literalLocals })
          }
        }
        html = revealEmails(html) // #1036: decode Cloudflare-protected / bracketed addresses in place, so `at` and contexts line up
        recordCrawlPage(db, tenantId, jobId, cand, url, status, Math.floor((deps.now ?? Date.now()) / 1000))
        // #1036: printed personal addresses are always collected (the published tier is a fact, not a guess); only guessing is flagged.
        for (const a of personalAddresses(html, cand)) {
          locals.add(a.local)
          const had = seen.get(a.address)
          if (!had && seen.size >= 200) continue // full: no context is built for an address that will not be kept
          // Every page's places are kept (12 per page, 72 per site): a later page printing the address beside someone
          // else must be able to refuse it.
          if (had && (had.ctx?.length ?? 0) >= 72) continue
          const ctx = addressContexts(html, a.at)
          if (had) had.ctx = [...(had.ctx ?? []), ...ctx].slice(0, 72)
          else seen.set(a.address, { address: a.address, url, ctx })
        }
      }
      const reading = (async () => {
        const shareSlot = companyFirstContacts && scopedBuyerHints.some(u => u.hostname.replace(/^www\./, '') === cand)
        const shared = shareSlot ? sharedReads.get(cand) ?? { deadline: Date.now() + crawlBudgetMs, pages: 0, responses: new Map(), fetchedAt: new Map() } : null
        if (shared) sharedReads.set(cand, shared)
        const boundedGet: Get = !shared ? hostGet : async (url, opts) => {
          if (opts?.signal?.aborted || deps.signal?.aborted || Date.now() >= shared.deadline) return null
          const key = String(!!opts?.noRedirect) + ' ' + url
          if (shared.responses.has(key)) return shared.responses.get(key) ?? null
          // Replaying an authorized variant shares the first crawl's physical
          // count and deadline. No slot is held back: if an earlier unhinted
          // lead already used all MAX_PAGES on this host, the cited page is not
          // read (the five-page politeness cap is never exceeded; see test 'a
          // late authorized hint cannot exceed the five successful pages...').
          const robot = new URL(url).pathname === '/robots.txt'
          if (canReplay && !opts?.noRedirect) return null
          if (!robot && shared.pages >= MAX_PAGES) return null
          const answer = await hostGet(url, opts)
          if (!robot && answer && answer.status < 400 && !answer.redirect) {
            shared.pages++
            if (!shared.fetchedAt.has(answer.finalUrl)) shared.fetchedAt.set(answer.finalUrl, Math.floor((deps.now ?? Date.now()) / 1000))
          }
          shared.responses.set(key, answer)
          return answer
        }
        const remaining = shared ? Math.max(1, shared.deadline - Date.now()) : crawlBudgetMs
        const r = await crawlSite(cand, boundedGet, deps.gapMs, company, !nativeOnly && (deps.env ?? process.env).SITECRAWL_SOCIAL === '1', deps.signal, onPage, buyerRoles, remaining,
          companyFirstContacts ? { ownAbout: true, authorizedHints } : null)
        if (companyFirstContacts) strictSeenForRead.set(r, strictSeen)
        if (hintKey) {
          hintedRead.set(cand, { key: hintKey, crawl: r })
          if (!siteRead.has(cand) && r.homeNorm !== undefined && r.reason !== 'name_mismatch') {
            const { withoutHint, ...rest } = r
            const unhinted = withoutHint ? { ...rest, found: withoutHint.found, reason: withoutHint.reason,
              pages: Math.max(1, rest.pages - 1), buyerPages: Math.max(0, (rest.buyerPages ?? 0) - 1) } : rest
            // The hinted card cannot become eligible (excluded from found),
            // but still vetoes a conflicting role or mailbox on another page.
            strictSeenForRead.set(unhinted, strictSeen)
            siteRead.set(cand, unhinted)
          }
        } else siteRead.set(cand, r)
        return r
      })()
      inflight.set(cand, reading)
      try { return await reading } finally { inflight.delete(cand) }
    }
    // An injected fetch (tests, the crawl4ai backend's callers) never reaches the network for a redirect unless one is injected too.
    const redirectOf = deps.redirectOf ?? (deps.get ? async () => null : (host: string) => rawRedirectTarget(host, TIMEOUT_MS, guardedLookup, deps.signal))
    const redirectSeen = new Map<string, string | null>()   // host -> where it forwards (or null), for the whole scan
    let probed = 0
    // Ziggy review 1290-F2: ONE per-host schedule for every request the crawl makes, evidence reads and site crawls alike. Requests to a host
    // run one at a time, each starts at least the polite gap after the previous start on that host, and the abort (the crawl's deadline or
    // the site read's own budget) is re-checked when a request reaches the FRONT of its host queue (1290-F1), so nothing queued starts late.
    const hostGap = deps.gapMs ?? GAP_MS
    const hostQueue = new Map<string, Promise<unknown>>()
    const hostStart = new Map<string, number>()
    const hostGet: Get = (url, opts) => {
      let host = ''; try { host = new URL(url).hostname.toLowerCase() } catch { /* unparseable: its own queue */ }
      const sig = opts?.signal ?? deps.signal
      const stop = () => !!(deps.signal?.aborted || sig?.aborted)
      const run = (hostQueue.get(host) ?? Promise.resolve()).catch(() => undefined).then(async () => {
        if (stop()) return null
        const wait = (hostStart.get(host) ?? 0) + hostGap - Date.now()
        if (wait > 0 && !(await sleepAbort(wait, sig))) return null
        if (stop()) return null
        hostStart.set(host, Date.now())
        return get(url, sig || opts?.noRedirect ? { signal: sig, ...(opts?.noRedirect ? { noRedirect: true } : {}) } : undefined)
      })
      hostQueue.set(host, run)
      return run
    }
    const evidenceGet = (url: string) => hostGet(url, deps.signal ? { signal: deps.signal } : undefined)
    // Negative only: two persisted verified excerpts claiming the same host
    // are unresolved; a company sharing only the label/prefix is not a claim.
    // Read once, keeping the optional path closed if the lookup exceeds its bound.
    const CLAIM_CAP = 100
    let claimants: Map<string,string[]> | undefined
    const unambiguousCitation = (host: string, leadId: string) => {
      if (!claimants) {
        const rows = db.prepare(`SELECT id, company, evidence_excerpt FROM leads
          WHERE scan_job_id=? AND review_reason IS NULL AND confidence IS NOT NULL LIMIT ?`)
          .all(jobId, CLAIM_CAP + 1) as (CitationClaim & { id: string })[]
        claimants = new Map()
        if (rows.length <= CLAIM_CAP) for (const row of rows) {
          const claim = citationClaim(row)
          if (claim) claimants.set(claim.host,[...(claimants.get(claim.host) ?? []),row.id])
        }
      }
      const matching = claimants.get(host)
      return matching?.length === 1 && matching[0] === leadId
    }
    const readLead = async (l: (typeof leads)[number]): Promise<void> => {
      if (deps.signal?.aborted) return // post-processing deadline: stop starting new sites
      if (companyFirstContacts) {
        await withdrawCompanyFirstPublishedDisplay(db, tenantId, l.id)
        // A selected refresh withdraws stale role/mail proof even when this
        // visit is withheld or cannot re-read the company page.
        db.prepare("DELETE FROM lead_enrichments WHERE tenant_id = ? AND lead_id = ? AND connector = 'sitecrawl' AND kind IN ('person', 'email', 'phone', 'contact')").run(tenantId, l.id)
      }
      // A lead held because its evidence page blocked us (or needs JavaScript) never has that page fetched again here:
      // the block is known, re-hitting it is pressure on a refusing site, and the answer would be the same. Identity is
      // probed from the company name + place instead (strict agreement checks below apply unchanged).
      const ev = (deps.skipEvidenceFetch || l.review_reason === 'blocked_by_site' || l.review_reason === 'needs_javascript') ? null : await evidenceGet(l.source_url)
      if (deps.signal?.aborted) return // the deadline passed while this lead waited for its evidence page: start nothing more for it
      // The blocked-host guard covers EVERY path to a site, not just the evidence URL: when the company name resolves to
      // the very host that refused this lead's fetch (its own blog/docs were the evidence), probing it would re-hit a
      // refusing site by another path. Such candidates are excluded and the skip is audited.
      const blockedHost = (l.review_reason === 'blocked_by_site' || l.review_reason === 'needs_javascript') ? (() => { try { return new URL(l.source_url).hostname.toLowerCase() } catch { return null } })() : null
      const notBlockedHost = (d: string) => { const h = d.toLowerCase(); return !blockedHost || (h !== blockedHost && !h.endsWith('.' + blockedHost) && !blockedHost.endsWith('.' + h)) }
      const basisOf = new Map<string, DomainBasis>()
      const sourceOf = new Map<string, string>()   // 1328-F1: page that linked/named a site, when it is not the lead's original page
      const nowSec = Math.floor((deps.now ?? Date.now()) / 1000)
      let sites: string[] = []
      // A posting link is a candidate, not proof: if local candidates fail identity/read checks,
      // the bounded official-site lookup may still find this company elsewhere (#1122).
      let anchored = false; const structured: string[] = []
      if (ev) for (const o of findCompanySitesWithBasis(l.company, ev.body, ev.finalUrl)) { basisOf.set(o.site, o.basis); if (o.structured) structured.push(o.site); else { sites.push(o.site); anchored = true } }
      // Search citations are scan-wide hints, not lead attribution. A publisher may name a website in plain text
      // ("Full Company Name (company.example)") without linking it. Require that exact pairing in THIS lead's
      // stored verified excerpt and re-read the exact publisher source before treating a matching citation as a
      // candidate. Use the full name here: the crawler's looser domain label and homepage checks cannot distinguish
      // namesakes or entities with overlapping names. Keep the publisher, not the search citation, as provenance.
      const citedSites: string[] = []
      if (!anchored && deps.citedUrls?.length && ev && ev.status === 200 && ev.text === undefined && ev.finalUrl === l.source_url) {
        const verified = !supplied ? (l.review_reason === null ? l : undefined) : db.prepare(`SELECT company, source_url, evidence_excerpt FROM leads
          WHERE id = ? AND scan_job_id = ? AND review_reason IS NULL AND confidence IS NOT NULL`).get(l.id, jobId) as
          { company: string; source_url: string; evidence_excerpt: string | null } | undefined
        if (verified?.company === l.company && verified.source_url === l.source_url && verified.evidence_excerpt) {
          const claim = citationClaim(verified)
          const namedHost = claim?.host ?? ''
          const evOwn = (() => { try { return registrable(new URL(ev.finalUrl).hostname) } catch { return '' } })()
          if (claim && siteHostOk(namedHost) && namedHost === registrable(namedHost) && namedHost !== evOwn &&
              ownSiteHost('https://' + namedHost) === namedHost && notBlockedHost(namedHost) &&
              nameLabel(namedHost) === norm(verified.company) &&
              deps.citedUrls.some(raw => {
                try {
                  const u = new URL(raw)
                  return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
                    u.hostname.replace(/^www\./, '') === namedHost
                } catch { return false }
              }) && publisherNamesCitedSite(ev.body,claim.quote) && unambiguousCitation(namedHost,l.id)) {
            sites.push(namedHost); citedSites.push(namedHost); basisOf.set(namedHost, 'evidence_link_text')
          }
        }
      }
      // Company-first, domainless lead: the employer's own public ATS board, looked up by the company-name slug on the free ATS APIs
      // (atsGtmBoard: a Greenhouse board's own name must agree with the company). It counts only when the board's fresh sales postings
      // name a company website whose label IS the company name; that site is then read and name-checked like any other. A board
      // matched by name alone (no website) gives nothing: same-name boards are the classic wrong-company case.
      if (!anchored && !citedSites.length && deps.atsLookup && !deps.signal?.aborted) {
        // the crawl deadline cancels every board request (listing, board name, details), not just each one's own timeout
        const base = deps.atsFetch ?? fetch, sig = deps.signal
        const atsFetch = (sig ? ((u: string | URL | Request, init?: RequestInit) => base(u, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, sig]) : sig })) : base) as typeof fetch
        const gb = await atsGtmBoard(l.company, null, atsFetch, { now: deps.now }).catch(() => null)
        const d = gb && !gb.contradictory && gb.hiring?.via === 'board_name' ? gb.hiring.domain : null
        const host = d ? registrable(d.replace(/^www\./, '').toLowerCase()) : ''
        if (host && siteHostOk(host) && !SOCIAL.test(host) && notBlockedHost(host) && nameLabel(host) === norm(l.company) && !sites.includes(host)) {
          // found from the company NAME, not a page link: recorded as a name probe, so the strict no-place/location refusals of a guess apply
          sites.push(host); citedSites.push(host); basisOf.set(host, 'name_probe'); sourceOf.set(host, gb!.hiring!.boardUrl)
        }
      }
      // cf_runner stage 1/2: the website the search model named for THIS company (exact normalized name) in its answer. Untrusted: the
      // host must carry the company's name (its full name or its first word of 4+ letters), and it is recorded as a name probe, so the
      // homepage name proof and a guessed domain's location rules decide; a model-named site never counts as a linked one.
      if (!anchored && deps.textSites?.length) {   // after the ATS lookup, so a wrong model hint never stops it
        const want = norm(l.company), stem = norm(l.company.split(/\s+/)[0] ?? '')
        const named = [...new Set(deps.textSites.filter(s => norm(s.company) === want).map(s => { try { return registrable(new URL(/^https?:\/\//i.test(s.website) ? s.website : 'https://' + s.website).hostname.replace(/^www\./, '').toLowerCase()) } catch { return '' } }))]
        if (named.length === 1) {
          const host = named[0], label = host ? nameLabel(host) : ''
          if (host && siteHostOk(host) && !SOCIAL.test(host) && notBlockedHost(host) && (label === want || (stem.length >= 4 && label.includes(stem))) && !sites.includes(host)) {
            sites.push(host); citedSites.push(host); basisOf.set(host, 'name_probe')
          }
        }
      }
      // a site named in the page's structured data is tried too when the page also links one (review at 576f9c8c: it was dropped whenever an
      // anchored link existed): after the linked sites, under the same checks; it never turns into a reason to skip what the page links
      if (anchored) for (const h of structured) if (!sites.includes(h)) sites.push(h)
      // #1122/#1037: a job-board posting that links no company site: the employer's ATS posting it links (same company slug) is read once,
      // and any site IT links or names becomes a candidate; then the slug's own domains join the name guesses below.
      const board = jobBoardSlugs(l.company, ev?.finalUrl ?? l.source_url, ev?.body ?? '')
      for (const a of board.ats) {
        if (anchored || deps.signal?.aborted) break
        let page: Awaited<ReturnType<typeof evidenceGet>> = null
        try { page = await evidenceGet(a) } catch { page = null }
        if (!page) continue
        for (const o of findCompanySitesWithBasis(l.company, page.body, page.finalUrl ?? a)) {
          if (o.basis === 'evidence_own_domain') continue   // the ATS's own host is never the company's
          if (!basisOf.has(o.site)) { basisOf.set(o.site, o.basis); sourceOf.set(o.site, page.finalUrl ?? a) }   // 1328-F1: the ATS page is this site's evidence
          if (!structured.includes(o.site)) structured.push(o.site)
        }
      }
      const fromSlug = board.slug ? slugDomains(board.slug, where).filter(notBlockedHost) : []
      // ATS employer identity is the first source, even when the posting also links a website.
      // Slug-derived hosts remain guesses: every homepage/place/refusal check still applies.
      let lookupPending = false
      if (anchored && probed < MAX_PROBES_PER_SCAN) {
        // Reserve once for both slug probes and the fallback; linking a stale site must not suppress search.
        probed++
        lookupPending = !!deps.findSites
        sites = [...new Set([...fromSlug, ...sites])]
        for (const d of fromSlug) if (!basisOf.has(d)) basisOf.set(d, 'name_probe')
      }
      let unresolved = anchored ? 'linked_site_not_confirmed' : 'not_confirmed'
      let probeGuesses: string[] = []
      if (!anchored) {
        // Evidence page does not link the company site: probe name-derived domains. Wrong guesses
        // are rejected by the homepage name check inside crawlSite.
        if (probed >= MAX_PROBES_PER_SCAN) {
          audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: l.company, status: 'no_site_linked', results: 0 })
          if (citedSites.length === 0 && structured.length === 0) { recordDomainUnresolved(db, tenantId, l, 'probe_limit_reached', today, nowSec); return }
          sites = [...new Set([...citedSites, ...structured])]; unresolved = 'probe_limit_reached'   // no name guess and no search ran for this lead
        } else {
          probed++
          const guesses = probeDomains(l.company, where)   // #1122: the request country's TLD too (a Toronto lead at <name>.ca)
          // #1122 (review at 01140156): the lead's source page is ON the company's own name-built domain and it refused reading. That site is
          // already known and already refused us; a web search could only return it again, so none is made and the reason says what happened.
          const ownBlocked = !!blockedHost && guesses.some(g => !notBlockedHost(g))
          // Check the posting's candidates and employer slug BEFORE an external lookup can consume the deadline.
          // Search remains a fallback, followed by the remaining name guesses, under the same identity/place checks.
          lookupPending = !!deps.findSites && !ownBlocked
          probeGuesses = guesses.filter(notBlockedHost)
          if (blockedHost && probeGuesses.length !== guesses.length) audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: blockedHost, status: 'skipped_site_refused_us', results: 0 })
          sites = [...new Set([...citedSites, ...fromSlug, ...structured])].filter(notBlockedHost)
          if (!lookupPending) sites = [...new Set([...sites, ...probeGuesses])]
          for (const d of sites) if (!basisOf.has(d)) basisOf.set(d, 'name_probe')
          if (blockedHost) { const kept = sites.filter(notBlockedHost); if (kept.length !== sites.length) audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: blockedHost, status: 'skipped_site_refused_us', results: 0 }); sites = kept }
          const ownCode = l.review_reason === 'needs_javascript' ? 'own_site_needs_javascript' : 'own_site_refused_reading'
          if (ownBlocked) unresolved = ownCode
          if (sites.length === 0 && !lookupPending) { audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: l.company, status: 'no_site_linked', results: 0 }); recordDomainUnresolved(db, tenantId, l, ownBlocked ? ownCode : 'no_site_linked', today, nowSec); return }
        }
      }
      let redirects = 0, asks = 0, robotsStopped = false, answered = false
      const followed = new Set<string>()   // hosts that are themselves forwarding targets: never followed further
      let r: Awaited<ReturnType<typeof crawlSite>> = { found: [], reason: 'name_mismatch', pages: 0 }; let site = sites[0]
      let locationProof: LocationProof | undefined
      // Nothing usable was read: wrong company, unreachable, or the time budget stopped the crawl before the homepage (#871).
      const unread = (x: Awaited<ReturnType<typeof crawlSite>>) => x.reason === 'name_mismatch' || x.reason === 'site_unreachable' || x.reason === 'time_budget' || x.reason === 'aborted'
      // Places this lead is about: the scan geography plus places its own evidence names (signal, quote, cited page).
      const places = placeTerms(where, [l.signal ?? '', l.evidence_excerpt ?? '', ev?.body ? (ev.text ?? plainText(ev.body)) : ''].join(' '), l.company)
      for (let i = 0; i < sites.length || lookupPending; i++) {
        if (deps.signal?.aborted) return
        if (i >= sites.length) {
          lookupPending = false
          let found: string[] = []
          try { found = await deps.findSites!(l.company, where) } catch { /* failed lookup: only local guesses remain */ }
          if (deps.signal?.aborted) return
          // A public record can supply new identity provenance for a host already probed. Re-evaluate it
          // against the cached homepage (no extra network), with recordSite now bound to this company.
          for (const d of [...new Set(found)]) {
            if (!notBlockedHost(d)) { audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: blockedHost!, status: 'skipped_site_refused_us', results: 0 }); continue }
            sites.push(d)
            if (!basisOf.has(d)) basisOf.set(d, 'name_probe')
          }
          for (const d of probeGuesses) {
            if (sites.includes(d)) continue
            sites.push(d)
            if (!basisOf.has(d)) basisOf.set(d, 'name_probe')
          }
          if (i >= sites.length) break
        }
        const cand = sites[i]
        site = cand
        // Only a current review or the exact freshly re-read first-party lead
        // source can authorize use of search hints. A cited/homepage guess cannot.
        let hints: readonly string[] | undefined
        if (companyFirstContacts && deps.buyerCitedUrls?.length) {
          const sourceOrigin = basisOf.get(cand) === 'evidence_own_domain' ? (() => {
            try {
              const q = new URL(ev?.finalUrl ?? '')
              return ev?.status === 200 && ev.finalUrl === l.source_url && q.protocol === 'https:' &&
                !q.username && !q.password && !q.port && q.hostname.replace(/^www\./, '') === cand ? q.origin : null
            } catch { return null }
          })() : null
          const reviewed = currentReviewedDomain(db, tenantId, l.id) === cand
          if (sourceOrigin || reviewed) hints = deps.buyerCitedUrls.slice(0, 200).filter(raw => {
            const u = buyerSourceCitation(raw)
            return !!u && (sourceOrigin ? u.origin === sourceOrigin : u.hostname.replace(/^www\./, '') === cand)
          })
        }
        r = await readSite(cand, l.company, hints)
        // #1122: a name-built or searched domain that only FORWARDS to another site (queenstreetdentalcentre.ca -> qsdc.ca). The crawl's fetch
        // never leaves a site, so this read as unreachable. The target is tried as one more guess under the SAME checks (its homepage must name
        // the company and the place must agree), and only when the target's own name is the company's (redirectTargetIsCompanys). Never from a
        // site the page linked, never from a target (no chains), never the host that refused the lead's page, never one already tried; at most
        // 3 lookups and 2 follows per lead; a host's answer is remembered for the rest of the scan.
        if ((r.reason === 'site_unreachable' || r.reason === 'robots_unreachable') && basisOf.get(cand) === 'name_probe' && !followed.has(cand) && redirects < 2 && asks < 3 && !deps.signal?.aborted) {
          let to: string | null = null
          if (redirectSeen.has(cand)) to = redirectSeen.get(cand) ?? null
          else { asks++; try { to = await redirectOf(cand) } catch { to = null } redirectSeen.set(cand, to) }
          if (to && to !== cand && !basisOf.has(to) && notBlockedHost(to) && !SOCIAL.test(to) && !NOT_OWN_SITE.has(nameLabel(to)) && !NOT_A_COMPANY_TLD.test(to) && redirectTargetIsCompanys(to, l.company, where)) {
            redirects++
            audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: cand, status: `redirects_to ${to}`.slice(0, 180), results: 0 })
            basisOf.set(to, 'name_probe'); followed.add(to); sites.push(to)
            r = { found: [], reason: 'name_mismatch', pages: 0 }
            continue
          }
        }
        if (r.homeText !== undefined) answered = true   // some candidate's homepage was read (and then accepted or refused)
        // a guessed site whose robots rules stop the read: remembered, so the lead's reason says the likely site could not be read
        if (r.reason === 'robots_disallow' && basisOf.get(cand) === 'name_probe') robotsStopped = true   // only a site that ANSWERED with rules forbidding it; an unreachable host is just absent
        // #1122: a scan with NO geography has nothing to place a company that is not local (a SaaS company hiring an SDR); a site a public
        // record gives as THIS company's official website (Wikidata P856, the item named exactly like the company, its host carrying the
        // name) is not asked for a place there. Every other check (homepage names the company, address, robots) still applies.
        // 1289-F4: the waiver is for a lead with NO place at all. When the lead's own evidence names a place ("Mercury in Austin, TX"), a same-name
        // public record is not enough: the homepage must still agree with that place, so a Chicago site is refused for an Austin lead.
        const recordNoGeo = where.length === 0 && places.length === 0 && basisOf.get(cand) === 'name_probe' && !!deps.findSites?.recordSite?.(cand, l.company)   // 1289-F2: only THIS company's own public record
        const basis = basisOf.get(cand)
        const guessed = basis === 'name_probe'
        const vHome = r.homeText ? (guessed ? probeScopeAgreement(r.homeText, where, l.company) : placeAgreement(r.homeText, where, l.company)) : 'unconfirmed'
        const homeLocationOk = guessed ? probeLocationAgrees(r.homeText, where, l, { homeNorm: r.homeNorm, places }) : placeConsistent(r.homeNorm, places)
        const homeElsewhere = !!r.homeText && ownAddressElsewhere(r.homeText, where)
        locationProof = !unread(r) && basis !== 'evidence_own_domain' && (!homeLocationOk || vHome === 'mismatch' || homeElsewhere)
          ? siteLocationProof(r.locationPages ?? [], where, l.company, vHome === 'mismatch' || (vHome !== 'scope_unconfirmed' && (vHome !== 'unconfirmed' || !!firstPlaceLabel(r.homeText ?? ''))), guessed)
          : undefined
        // A site the lead's evidence LINKS to, whose domain label is the company's name, is bound to the company by that link. With no
        // requested place there is nothing to compare it against: a place the evidence page happens to name is not the request's (prod
        // run df4f657f refused linked sites "vs the requested place"). Text-only links and guessed (name_probe) sites keep every check.
        if (!unread(r) && !homeLocationOk && !locationProof && ((guessed && !recordNoGeo) || (!guessed && basis !== 'evidence_own_domain' && places.length > 0 && (placeRequested || basis !== 'evidence_link_domain_label')))) {
          // Same name, but the homepage names none of the lead's places (or no place is known): not this company.
          audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: cand, status: (locationRefusal(basisOf.get(cand) === 'name_probe', places.length > 0, r.homeText, where)).slice(0, 180), results: 0 })
          // a refusal is recorded on the lead only when a homepage was actually read (an unreachable probe is not a wrong-company record)
          if (r.homeText) recordContactRejection(db, tenantId, l.id, { connector: 'sitecrawl', reason: ((locationRefusal(basisOf.get(cand) === 'name_probe', places.length > 0, r.homeText, where)).slice(0, 180)).slice(0, 180), sourceUrl: `https://${cand}/` })
          r = { found: [], reason: 'name_mismatch', pages: 0 }
          continue
        }
        // Place agreement against the scan's geography (city-scoped for New York City / London): a same-name practice in another state or
        // another UK city names its own address on its homepage and is refused; a guessed (name_probe) domain must also AGREE for a city ask.
        // A street address in the lead's own evidence: a homepage that lists street addresses and none of them is the lead's is another business with the same name.
        if (!unread(r) && basisOf.get(cand) !== 'evidence_own_domain' && addressAgreement(r.homeText, `${l.evidence_excerpt ?? ''} ${l.signal ?? ''}`) === 'conflict') {
          const reason = `contact rejected: address mismatch ${(streetKeys(r.homeText)[0] ?? 'another address')} vs ${(streetKeys(`${l.evidence_excerpt ?? ''} ${l.signal ?? ''}`)[0] ?? 'the lead\'s address')}`.slice(0, 180)
          audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: cand, status: reason, results: 0 })
          if (r.homeText) recordContactRejection(db, tenantId, l.id, { connector: 'sitecrawl', reason, sourceUrl: `https://${cand}/` })
          r = { found: [], reason: 'name_mismatch', pages: 0 }
          continue
        }
        if (!unread(r) && where.length > 0 && basisOf.get(cand) !== 'evidence_own_domain') {
          const v = locationProof ? 'agrees' : vHome
          if (v === 'mismatch' || (!locationProof && homeElsewhere) || (v !== 'agrees' && v !== 'no_geography' && cityScoped(where) && basisOf.get(cand) === 'name_probe')) {
            // Reason in plain words, e.g. "contact rejected: location mismatch Pico Rivera, CA vs New York, NY".
            audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: cand, status: `contact rejected: location ${v === 'mismatch' ? 'mismatch' : 'unconfirmed'} ${firstPlaceLabel(r.homeText ?? '') ?? 'another place'} vs ${leadPlaceLabel(where)}`.slice(0, 180), results: 0 })
            if (r.homeText) recordContactRejection(db, tenantId, l.id, { connector: 'sitecrawl', reason: (`contact rejected: location ${v === 'mismatch' ? 'mismatch' : 'unconfirmed'} ${firstPlaceLabel(r.homeText ?? '') ?? 'another place'} vs ${leadPlaceLabel(where)}`.slice(0, 180)).slice(0, 180), sourceUrl: `https://${cand}/` })
            r = { found: [], reason: 'name_mismatch', pages: 0 }
            continue
          }
        }
        if (!unread(r)) break
        audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: cand, status: r.reason, results: 0 })
      }
      // A deadline that fired during this crawl leaves a partial read: record nothing (no domain, tech, contacts or audit row) rather than a result that looks complete.
      if (deps.signal?.aborted) return
      if (unread(r)) { recordDomainUnresolved(db, tenantId, l, r.reason === 'time_budget' ? 'time_budget' : robotsStopped && !answered && unresolved === 'not_confirmed' ? 'site_not_readable' : unresolved, today, nowSec); return }
      // The crawl's own time budget stopping it mid-read is the same class of partial read (#871): the pages actually
      // fetched stay recorded in crawl_pages (facts with their own times), but NO derived domain/tech/contact rows.
      if (r.stoppedBy === 'time') return
      // The site answered but its robots rules could not be read, or forbid reading it: nothing is read, no domain is kept, and the lead says so (#1122).
      if (r.reason !== 'ok' && r.reason !== 'none_published') recordDomainUnresolved(db, tenantId, l, r.reason === 'robots_disallow' ? 'site_not_readable' : 'site_not_read', today, nowSec)   // only rules that FORBID reading are a refusal; rules that could not be fetched are just an unread site
      // The homepage named the company: the domain is confirmed as the company's own site, whether
      // or not it publishes contacts. Record it so leads link out and later runs skip the search.
      if (r.reason === 'ok' || r.reason === 'none_published') db.prepare('UPDATE leads SET company_domain = ? WHERE id = ? AND scan_job_id = ? AND EXISTS (SELECT 1 FROM scan_jobs WHERE id = ? AND user_id = ?)').run(site, l.id, jobId, jobId, tenantId)
      if (r.reason === 'ok' || r.reason === 'none_published') { try { db.prepare('DELETE FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = ? AND kind = ?').run(l.id, tenantId, 'sitecrawl', DOMAIN_UNRESOLVED_KIND) } catch { /* note only */ } }
      if (!companyFirstContacts && (r.reason === 'ok' || r.reason === 'none_published')) { try { recordEmailGuesses(db, tenantId, l.id, site, [...(localsBySite.get(site) ?? [])], r.found.filter(f => f.kind === 'person').map(f => f.value), { env: deps.env ?? process.env, homeText: r.homeText, where, seen: [...(seenBySite.get(site)?.values() ?? [])] }) } catch { /* never affects the crawl */ } }
      if (!companyFirstContacts && displayCountry && (r.reason === 'ok' || r.reason === 'none_published') && publishedDisplayOffice(r.locationPages ?? [], where, l.company, displayCountry)) {
        try { recordPublishedDisplay(db, tenantId, l.id, site, where, r.found.filter(f => f.kind === 'person'), [...(displaySeenBySite.get(site)?.values() ?? [])]) } catch { /* never affects the crawl */ }
      }
      let n = 0
      // Provenance of the domain choice. One row per (domain, basis), so a later scan that reaches the same domain a weaker way adds a row
      // instead of being swallowed by the first. For link bases source_url is the cited page holding the link; for name_probe it is only the
      // homepage the crawl read, which did not produce the domain. Not counted in n: a domain row is not a contact.
      // The homepage name check is the only
      // identity test, so a probed or link-selected domain is recorded as such and never as verified ownership.
      if (r.reason === 'ok' || r.reason === 'none_published') {
        const basis = basisOf.get(site) ?? 'name_probe'
        addEnrichment(db, tenantId, l.id, { connector: 'sitecrawl', kind: 'domain', value: `${site}|${basis}`, label: domainBasisToken(basis), confidence: null, source_url: basis === 'name_probe' ? `https://${site}/` : (sourceOf.get(site) ?? ev?.finalUrl ?? l.source_url).slice(0, 500), source_date: today, retrieved_at: Math.floor((deps.now ?? Date.now()) / 1000) })
        // Preserve the page that supplied positive office evidence and its own fetch time.
        const proofPage = locationProof && db.prepare('SELECT fetched_at FROM crawl_pages WHERE tenant_id = ? AND scan_job_id = ? AND site = ? AND url = ?')
          .get(tenantId, jobId, site, locationProof.url) as { fetched_at: number } | undefined
        const checkedAt = proofPage?.fetched_at ?? Math.floor((deps.now ?? Date.now()) / 1000)
        const proofLabel = locationProof ? `identity-check-v2: first-party location evidence: ${locationProof.excerpt}` : 'identity-check-v2: homepage names the company and the place or address agrees'
        addEnrichment(db, tenantId, l.id, { connector: 'sitecrawl', kind: 'domain_check', value: `${site}|identity_checked`, label: proofLabel.slice(0, 200), confidence: null, source_url: locationProof?.url ?? `https://${site}/`, source_date: new Date(checkedAt * 1000).toISOString().slice(0, 10), retrieved_at: checkedAt })
      }
      for (const t of r.tech ?? []) {
        const e: Enrichment = { connector: 'sitecrawl', kind: 'tech', value: t.name.slice(0, 254), label: `seen on the company website (${t.where})`.slice(0, 200), confidence: null, source_url: `https://${site}/`, source_date: today, retrieved_at: Math.floor((deps.now ?? Date.now()) / 1000) }
        addEnrichment(db, tenantId, l.id, e); n++
      }
      // #389: this crawl's dated technology observation (what the homepage showed, and whether it could show absence at all), then any
      // change against this tenant's earlier comparable observations of the same domain. Not counted in n; never affects the crawl.
      techBranch(db, tenantId, jobId, l.id, site, r, Math.floor((deps.now ?? Date.now()) / 1000), deps.env)
      // A guessed site passed the name AND location checks, but the evidence never linked it: say so on every contact.
      const guessed = (basisOf.get(site) ?? 'name_probe') === 'name_probe'
      let named = 0
      if (companyFirstContacts) {
        // The guarded crawl and old verifier still select this exact buyer.
        // Establishing a name/place-matched probe alone cannot authorize proof.
        const basis = basisOf.get(site)
        const ownOrigin = basis === 'evidence_own_domain' ? (() => {
          try {
            const q = new URL(ev?.finalUrl ?? '')
            return ev?.status === 200 && ev.finalUrl === l.source_url && q.protocol === 'https:' &&
              q.hostname.replace(/^www\./, '') === site ? q.origin : null
          } catch { return null }
        })() : null
        const reviewed = currentReviewedDomain(db, tenantId, l.id) === site
        const allowed = (r.reason === 'ok' || r.reason === 'none_published') &&
          domainRelationship(db, tenantId, l.id, site) === 'established' && (ownOrigin || reviewed)
        const strictPages = strictSeenForRead.get(r)
        const strictBuyers: { person: string; quote: string; name: string; email: string | null; source: string; at: number }[] = []
        const cardKey = (v: string) => v.normalize('NFC').toLowerCase().replace(/\s+/g, ' ')
        if (allowed && buyerRoles && strictPages) for (const f of r.found) {
          if (f.kind !== 'person' || !buyerTitle(titleOf(f), buyerRoles) || (ownOrigin && new URL(f.url).origin !== ownOrigin)) continue
          const page = strictPages.get(f.url)
          const exact = page?.cards.filter(c => `${c.name}, ${c.quote}`.replace(/\s+/g, ' ') === f.value)
          if (!page || exact?.length !== 1) continue
          const card = exact[0]
          const observedElsewhere = [...strictPages.values()].flatMap(p => p.cards).filter(c => c !== card)
          if (observedElsewhere.some(c => cardKey(c.name) === cardKey(card.name) && cardKey(c.quote) !== cardKey(card.quote))) continue
          const email = card.email && !observedElsewhere.some(c =>
            (c.email?.toLowerCase() === card.email?.toLowerCase() && cardKey(c.name) !== cardKey(card.name)) ||
            (cardKey(c.name) === cardKey(card.name) && !!c.email && c.email.toLowerCase() !== card.email?.toLowerCase())) ? card.email : null
          strictBuyers.push({ person: f.value, quote: card.quote, name: card.name, email, source: f.url, at: page.at })
        }
        // Current product readiness selects person and route independently.
        // Publish one matched pair (or one buyer only); never mix two cards.
        if (strictBuyers.length === 1) {
          const buyer = strictBuyers[0]
          const dated = { source_url: buyer.source, source_date: new Date(buyer.at * 1000).toISOString().slice(0, 10), retrieved_at: buyer.at }
          addEnrichment(db, tenantId, l.id, { connector: 'sitecrawl', kind: 'person', value: buyer.person,
            label: COMPANY_FIRST_ROLE_LABEL + buyer.quote, confidence: null, ...dated }); n++; named++
          if (buyer.email && hasCompanyFirstBudget(ownedJob.run_budget)) {
            await recordCompanyFirstPublishedDisplay(db, tenantId, l.id, jobId, ownedJob.attempts, { domain: site,
              person: buyer.person, address: buyer.email, source_url: buyer.source, role_quote: buyer.quote, observed_at: buyer.at })
          }
          // Leave the independent pre-existing sender eligibility unchanged.
          if (buyer.email && usEvidence(r.homeText, where).us) {
            addEnrichment(db, tenantId, l.id, { connector: 'sitecrawl', kind: 'email', value: buyer.email,
              label: contextLabel({ excerpt: buyer.name + ' | ' + buyer.email, source_url: buyer.source }), confidence: null, ...dated }); n++
          }
        }
      } else for (const f of r.found) {
        const baseLabel = guessed && profileFromListedLabel(f.label) ? 'listed with this title on this company page, not verified as current staff' : f.label
        const label = guessed ? `${baseLabel}; site found by name search and location match, not linked from the source` : f.label
        const e: Enrichment = { connector: 'sitecrawl', kind: f.kind, value: f.value.slice(0, 254), label: label.slice(0, 200), confidence: null, source_url: f.url.slice(0, 500), source_date: today, retrieved_at: Math.floor((deps.now ?? Date.now()) / 1000) }
        addEnrichment(db, tenantId, l.id, e); n++
        if (f.kind === 'person' && (!buyerRoles || buyerTitle(titleOf(f), buyerRoles))) named++
      }
      if ((r.reason === 'ok' || r.reason === 'none_published') && r.buyerPages) deps.onBuyerRead?.({ site, pages: r.buyerPages, stored: named })
      // #1036: a buyer the crawl named on this site whose OWN personal address the site prints (the published tier recordEmailGuesses
      // just wrote, tied to this person by the page itself: publishedCandidateFor, one address per person or none) is shown on the lead
      // during the scan, as the same published contact the "Find work email" button gives for free. Published, never a guess; on this
      // lead's confirmed site only; the label names the person and says where it was printed.
      if (!companyFirstContacts && (r.reason === 'ok' || r.reason === 'none_published')) {
        const have = new Set(r.found.filter(f => f.kind === 'email').map(f => f.value.toLowerCase()))
        for (const f of r.found) {
          if (f.kind !== 'person') continue
          const pub = publishedCandidateFor(db, tenantId, l.id, f.value.split(',')[0] ?? '')
          if (!pub || !sameSite(pub.address.split('@')[1] ?? '', site) || have.has(pub.address.toLowerCase())) continue
          have.add(pub.address.toLowerCase())
          const excerpt = `${f.value}: their own address, printed on the company website`
          const label = `${contextLabel({ excerpt, source_url: pub.url })}${guessed ? '; site found by name search and location match, not linked from the source' : ''}`
          addEnrichment(db, tenantId, l.id, { connector: 'sitecrawl', kind: 'email', value: pub.address.toLowerCase().slice(0, 254), label: label.slice(0, 200), confidence: null, source_url: pub.url.slice(0, 500), source_date: today, retrieved_at: Math.floor((deps.now ?? Date.now()) / 1000) }); n++
        }
      }
      audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: site, status: r.reason, results: n })
    }
    // #1037: leads are read CONCURRENTLY (a few at a time) instead of one after another, so more of the scan's leads get their own site checked
    // for named people inside the same post-finish window. Each lead's checks are unchanged; per-host politeness still holds (one crawl per site,
    // the crawl's own per-host gap, and evidence pages on the same host fetched one at a time). A deadline stops new leads from starting.
    const width = crawlConcurrency(deps.concurrency, deps.get ? 1 : undefined, deps.env)
    let next = 0, failed: unknown = null
    await Promise.all(Array.from({ length: Math.min(width, leads.length) }, async () => {
      while (next < leads.length && failed === null) {
        if (deps.signal?.aborted) return
        const l = leads[next++]
        try { await readLead(l) } catch (e) { failed ??= e }
      }
    }))
    if (failed !== null) throw failed
    if (deps.signal?.aborted) return
    // #1122 (review at 01140156): a lead this crawl never picks (its hold is about the event itself: a closed opening, someone else's customer,
    // no event evidence) has no website attempt at all. It says so, instead of showing nothing. Whole-job crawls only; never beside a domain.
    if (!deps.leads && !deps.signal?.aborted) {
      try {
        const picked = new Set(leads.map(l => l.id))
        const rest = db.prepare("SELECT id, source_url, review_reason, confidence FROM leads WHERE scan_job_id = ? AND company <> '' AND company_domain IS NULL AND quarantined_at IS NULL LIMIT 200").all(jobId) as { id: string; source_url: string; review_reason: string | null; confidence: number | null }[]
        const eligible = (x: { review_reason: string | null; confidence: number | null }) => (x.review_reason === null && x.confidence !== null) || (x.review_reason !== null && CRAWL_HOLD_LIST.includes(x.review_reason))
        for (const x of rest) {
          if (picked.has(x.id) || db.prepare('SELECT 1 FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = ? AND kind = ?').get(x.id, tenantId, 'sitecrawl', DOMAIN_UNRESOLVED_KIND)) continue
          // a lead the crawl would check but did not reach (it reads the scan's top leads only) is told that, not that it is "held"
          recordDomainUnresolved(db, tenantId, x, eligible(x) ? 'probe_limit_reached' : 'not_checked', today, Math.floor((deps.now ?? Date.now()) / 1000))
        }
      } catch { /* a note only (an older leads table without these columns): never fails the crawl */ }
    }
  } catch (e) {
    console.error('sitecrawl failed', jobId, e instanceof Error ? e.message : 'error')
  }
}
