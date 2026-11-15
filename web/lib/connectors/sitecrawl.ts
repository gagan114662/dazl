import { looksLikeJobTitle } from '../people/job-title-name.ts'
import {contactContext,contextLabel} from '../outreach/contact-context.ts'
import https from 'node:https'
import zlib from 'node:zlib'
import type Database from 'better-sqlite3'
import robotsParser from 'robots-parser'
import { getDomain } from 'tldts'
import { social } from '@crawlee/utils'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { guardedLookup, isPublicIp } from '../scan/fetch-page.ts'
import { audit, addEnrichment, recordCrawlPage, type Enrichment } from './store.ts'
import { DOMAIN_UNRESOLVED_KIND, DOMAIN_UNRESOLVED_TOKEN } from './domain-unresolved.ts'
export { DOMAIN_UNRESOLVED_KIND, DOMAIN_UNRESOLVED_TOKEN, domainUnresolvedWords } from './domain-unresolved.ts'
import { detectTech, observability, type Observability, type TechHit } from './techstack.ts'
import { TECH_SCAN_KIND, TECH_CHANGE_KIND, encodeScan, decodeScan, techChanges, changeRow, scanOf, isScanDomain, type TechScan } from '../signals/tech-observations.ts'
import { personalAddresses, recordEmailGuesses, type AddressContext } from '../people/email-pattern.ts'
import { roleContradicted, roleEndedByDate, titleMatches } from '../people/rank.ts'
import { placeAgreement, cityScoped, geoTerms, US_STATES } from '../scan/place-agreement.ts'
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
export const MAX_SITES_PER_SCAN = Number(process.env.SITECRAWL_MAX_SITES || 8)
const GAP_MS = Number(process.env.SITECRAWL_GAP_MS ?? 2000)
// Intrinsic per-site crawl bound (#871): robots + home + up to MAX_PAGES pages under the polite gap must fit.
const CRAWL_BUDGET_MS = (() => { const n = Number(process.env.SITECRAWL_CRAWL_BUDGET_MS ?? 45_000); return Number.isFinite(n) && n > 0 ? n : 45_000 })()
// The crawl budget is ALWAYS a finite positive bound (#871): an invalid or non-positive value is the default, never a disable.
export const crawlBudgetBound = (ms: number): number => Number.isFinite(ms) && ms > 0 ? ms : CRAWL_BUDGET_MS

export const sitecrawlEnabled = (env: Record<string, string | undefined> = process.env) => env.SITECRAWL_ENABLED !== '0'

// opts.signal: the caller's abort (and the crawl's own deadline, #871) handed to the fetch itself, so a timed-out or
// aborted crawl CANCELS the native operation instead of abandoning a running socket. A Get that ignores it is still
// bounded by the crawl's own race, but production Gets (rawGet, crawl4ai) honor it.
export type Get = (url: string, opts?: { signal?: AbortSignal }) => Promise<{ status: number; body: string; finalUrl: string; text?: string } | null>

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
export function rawGet(rawUrl: string, hops = 0, timeoutMs = TIMEOUT_MS, lookup: typeof guardedLookup = guardedLookup, signal?: AbortSignal): Promise<{ status: number; body: string; finalUrl: string; text?: string } | null> {
  return new Promise(resolveRaw => {
    // Absolute per-request timer (the socket timeout below is inactivity-only: a slow drip never trips it).
    let hard: NodeJS.Timeout | undefined
    const resolve = (v: { status: number; body: string; finalUrl: string; text?: string } | null | Promise<{ status: number; body: string; finalUrl: string; text?: string } | null>) => { clearTimeout(hard); resolveRaw(v as never) }
    let u: URL
    try { u = new URL(rawUrl) } catch { return resolve(null) }
    if (u.protocol !== 'https:' || u.username || u.password || hops > 2) return resolve(null)
    const chunks: Buffer[] = []; let n = 0, readSoFar: () => { status: number; body: string; finalUrl: string; text?: string } | null = () => null
    const req = https.request(u, { method: 'GET', lookup: lookup as never, timeout: timeoutMs, headers: { 'user-agent': UA, accept: 'text/html,text/plain;q=0.9', 'accept-encoding': 'identity' } }, res => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        let next: URL
        try { next = new URL(String(res.headers.location), u) } catch { return resolve(null) }
        if (next.hostname.replace(/^www\./, '') !== u.hostname.replace(/^www\./, '')) return resolve(null) // stay on the same site
        return resolve(rawGet(next.toString(), hops + 1, timeoutMs, lookup, signal))
      }
      if (!/^text\/(html|plain)|application\/xhtml/i.test(String(res.headers['content-type'] ?? ''))) { res.destroy(); return resolve({ status, body: '', finalUrl: u.toString() }) }
      // Some servers send a compressed body although the request asks for 'identity' (seen on law-firm sites, #1102: ogletree.com,
      // honigman.com). Unread, the page looked like binary noise, the homepage never "named the company" and the whole site was skipped
      // as name_mismatch. The body is decoded here; MAX_BYTES caps the DECODED bytes, so a small compressed body cannot expand without
      // limit (a decompression bomb). An encoding this reader does not know reads as an empty page, never as noise.
      const enc = String(res.headers['content-encoding'] ?? '').trim().toLowerCase()
      const decoder = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH }) : enc === 'deflate' ? zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH }) : enc === 'br' ? zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH }) : null
      // An encoding this reader does not know ("utf-8", "none" from misconfigured servers, or zstd): the bytes are read, and are the page only
      // when they read as HTML; otherwise an empty page, never noise.
      const unknownEnc = !!enc && enc !== 'identity' && !decoder
      // A body LABELLED compressed but sent plain (some servers): if decoding fails before anything was decoded and the raw bytes do not
      // start like a compressed stream, the raw bytes are the page.
      const raw: Buffer[] = []; let rawN = 0
      if (decoder) res.on('data', (c: Buffer) => { if (rawN <= TEXT_BYTES) { raw.push(c); rawN += c.length } })
      const body = decoder ? res.pipe(decoder) : res
      // MAX_BYTES caps the stored (decoded) body; up to TEXT_BYTES of decoded bytes feed its visible text (#1122). A bomb stops there.
      const done = () => { const all = Buffer.concat(chunks); if (unknownEnc && !/^\s*</.test(all.subarray(0, 64).toString('utf8'))) return { status, body: '', finalUrl: u.toString() }; const body = all.subarray(0, MAX_BYTES).toString('utf8'); return all.length > MAX_BYTES ? { status, body, finalUrl: u.toString(), text: plainText(all.toString('utf8')) } : { status, body, finalUrl: u.toString() } }
      readSoFar = () => (n >= MAX_BYTES ? done() : null)
      body.on('data', (c: Buffer) => { n += c.length; if (n > TEXT_BYTES) { res.destroy(); decoder?.destroy(); resolve(done()) } else chunks.push(c) })
      body.on('end', () => resolve(done()))
      body.on('error', () => {
        if (n > 0) { res.destroy(); return resolve(done()) }   // a late error (trailing bytes after the stream): what was decoded is the page
        const b = Buffer.concat(raw)
        if (!(b.length > 0 && b[0] !== 0x1f && /^\s*</.test(b.subarray(0, 64).toString('utf8')))) { res.destroy(); return resolve(null) }   // a corrupt compressed body is no page; stop reading it
        // labelled compressed, sent plain: the raw bytes are the page, under the same caps as any body
        const plain = () => { const all = Buffer.concat(raw); const body = all.subarray(0, MAX_BYTES).toString('utf8'); return all.length > MAX_BYTES ? { status, body, finalUrl: u.toString(), text: plainText(all.toString('utf8')) } : { status, body, finalUrl: u.toString() } }
        if (res.readableEnded || res.complete || rawN > TEXT_BYTES) { res.destroy(); return resolve(plain()) }
        res.on('data', () => { if (rawN > TEXT_BYTES) { res.destroy(); resolve(plain()) } }); res.on('end', () => resolve(plain())); res.on('close', () => resolve(plain())); res.resume()
      })
      res.on('error', () => resolve(null))
      res.on('close', () => { if (!decoder) resolve(null) }) // no-op once already settled; with a decoder the decoder's 'end' settles it
    })
    // The error listener goes on FIRST: a caller whose signal is already aborted destroys the request below, and an 'error' with no
    // listener yet is an uncaught exception that takes the whole scan process down (seen in a matrix run, #1102).
    req.on('error', () => resolve(null))
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
  return async (url: string, opts?: { signal?: AbortSignal }) => {
    let u: URL; try { u = new URL(url) } catch { return null }
    if (u.protocol !== 'https:' || !(await hostOk(u.hostname))) return null
    if (u.pathname === '/robots.txt') return rawGet(url, 0, TIMEOUT_MS, guardedLookup, opts?.signal) // plain text, no rendering needed
    try {
      const res = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ urls: [url], crawler_config: { type: 'CrawlerRunConfig', params: { check_robots_txt: true, page_timeout: 20000 } } }), signal: opts?.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(40_000)]) : AbortSignal.timeout(40_000) })
      if (!res.ok) return null
      const j = (await res.json()) as { results?: { url?: string; html?: string; status_code?: number; success?: boolean; redirected_url?: string }[] }
      const r = j.results?.[0]; if (!r) return null
      const finalUrl = typeof r.redirected_url === 'string' && r.redirected_url.startsWith('https://') ? r.redirected_url : url
      try { if (new URL(finalUrl).hostname.replace(/^www\./, '') !== u.hostname.replace(/^www\./, '')) return null } catch { return null }
      return { status: r.status_code ?? (r.success ? 200 : 0), body: String(r.html ?? '').slice(0, MAX_BYTES), finalUrl }
    } catch { return null }
  }
}
export const defaultGet = (env: Record<string, string | undefined> = process.env): Get => (env.CRAWL4AI_URL ? crawl4aiGet(env.CRAWL4AI_URL) : (url, opts) => rawGet(url, 0, TIMEOUT_MS, guardedLookup, opts?.signal))

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
export const siteHostOk = (host: string) => { const h = host.replace(/^\[|\]$/g, ''); return !!h && isIP(h) === 0 && h.includes('.') && !/^\d+(\.\d+)*$/.test(h) && !h.endsWith('.') && !/[^a-z0-9.-]/i.test(h) }
const labelMatches = (label: string, want: string) => label.length >= 4 && (label === want || (want.startsWith(label) && label.length >= 6) || (label.startsWith(want) && want.length >= 6))

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
  return out.slice(0, 2).map((o, i) => (i >= anchors ? { ...o, structured: true } : o))
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
// The scan's geography names a country whose businesses usually live on its own TLD (#1122: Toronto and Vancouver leads were only ever
// probed at .com / .ai / .io / .co). Only an explicit country or one of its provinces / states / nations counts; nothing is inferred from a city alone.
const COUNTRY_TLDS: [RegExp, string[]][] = [
  [/\bcanada\b|\bontario\b(?!,?\s*(ca\b|calif))|\bquebec\b|\bbritish columbia\b|\balberta\b|\bmanitoba\b|\bsaskatchewan\b|\bnova scotia\b|\bnew brunswick\b(?!,?\s*(nj\b|new jersey))|\bnewfoundland\b|\bprince edward island\b/i, ['ca']],
  [/,\s*(ON|BC|AB|QC|MB|SK|NS|NL|PE)\b(?!\.)/, ['ca']],   // "Toronto, ON": the two-letter province after a comma, capitals only (", on" in running text is not a place)
  [/\bunited kingdom\b|\buk\b|(?<!new )\bengland\b|\bscotland\b|(?<!new south )\bwales\b|\bnorthern ireland\b|\bgreat britain\b/i, ['co.uk', 'uk']],
  [/\baustralia\b|\bnew south wales\b|\bnsw\b|\bqueensland\b|\bwestern australia\b|\bsouth australia\b|\btasmania\b/i, ['com.au']],
  [/\bgermany\b|\bdeutschland\b/i, ['de']],
  [/\bindia\b/i, ['in', 'co.in']],
  [/\bnew zealand\b/i, ['co.nz']],
  [/(?<!northern )\bireland\b/i, ['ie']],
]
export function countryTlds(where: string[]): string[] {
  const t = where.join(' ; ').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  return [...new Set(COUNTRY_TLDS.filter(([re]) => re.test(t)).flatMap(([, tlds]) => tlds))]
}
export function probeDomains(company: string, where: string[] = []): string[] {
  const want = norm(company)
  if (want.length < 4 || want.length > 30) return []
  const out = [`${want}.com`, ...countryTlds(where).map(t => `${want}.${t}`), `${want}.ai`, `${want}.io`, `${want}.co`]
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
export const MAX_PROBES_PER_SCAN = 8

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
const T = `(?:founder|co-?founder|owner|co-?owner|ceo|president|principal|proprietor|managing director|general manager|director|(?:office )?managing (?:partner|shareholder|principal)|partner|practice manager|office manager|broker|dentist|doctor|${EXEC})`
const TITLE_FULL = new RegExp(`^${T}(?: (?:&|and) ${T})?$`, 'i')
// A people page by a WHOLE path segment, after a locale such as "en-us": "/about", "/about-us", "/aboutus", "/AboutUs.aspx", "/our-team",
// "/meet-the-team", "/contact-us", "/locations/chicago"; or the second segment under a container ("/firm/our-people", "/company/leadership",
// "/about/team"). A segment that merely STARTS with such a word is a post, not the page: "/contact-tracing-guide", "/about-the-case-of-x",
// "/our-meetup-recap", and anything under "/insights/blog-posts/" (#1102 measurement: a UK blog post reached through a /contact redirect
// gave a wrong person). At most four segments deep.
const PEOPLE_SEGMENT = /^(?:our-|the-|meet-(?:the-|our-)?)?(?:about(?:-?us)?|about-the-(?:firm|practice|team|company)|our-story|our-firm|the-firm|who-we-are|(?:leadership|management|executive|practice|senior|core|dental|legal)-team|team(?:-members)?|staff-directory|founders?|leadership|management|people|staff|attorneys|lawyers|professionals|doctors?|dentists?|providers|owners?|contact(?:-?us)?|company|(?:[a-z]+-)?(?:locations?|offices?))(?:\.[a-z]{2,5})?$/
const CONTAINER_SEGMENT = /^(?:about(?:-?us)?|firm|our-firm|company|who-we-are)$/
const segmentsOf = (pathname: string) => { const seg = pathname.toLowerCase().replace(/_/g, '-').split('/').filter(Boolean); const at = /^[a-z]{2}(?:-[a-z]{2})?$/.test(seg[0] ?? '') ? 1 : 0; return seg.slice(at) }
// A later segment naming a post section ("/company/blog/...", "/about/news/2026/...") makes the page a post, whatever the first segment says.
const POST_SEGMENT = /(?:^|-)(?:blog|news|press|posts?|articles?|insights?|events?|case-stud(?:y|ies)|testimonials?|reviews?|portfolio|authors?)(?:-|$)|^\d{4}$/   // whole words: "newsome" is a name
const peoplePage = (pathname: string) => { const seg = segmentsOf(pathname); return seg.length > 0 && seg.length <= 4 && !seg.slice(1).some(x => POST_SEGMENT.test(x)) && (PEOPLE_SEGMENT.test(seg[0]) || (CONTAINER_SEGMENT.test(seg[0]) && seg.length >= 2 && PEOPLE_SEGMENT.test(seg[1]))) }
// A link to a person's own bio: under a people-directory segment ("/people/<slug>", "/attorneys/<slug>", "/our-team/<slug>"), never under
// testimonials, case studies, blog authors, portfolios or press (MARK words), and the last segment is the person's name slug.
const BIO_MARK = /testimonial|review|case-stud|blog|author|portfolio|press|news|client|customer|success-stor|sponsor|award/
const BIO_PARENT = /^(?:our-|meet-(?:the-|our-)?)?(?:people|team|staff|attorneys|lawyers|professionals|bios?|leadership|doctors?|dentists?|providers)$/
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
// company: the site's own company. A title the page writes as "Founder & CEO, <company>" (or "at" / "of" / "@ <company>") is the title
// "Founder & CEO": the trailing words are dropped ONLY when they name this company exactly (normalised), never another business.
export function extractPeople(html: string, pageUrl: string, buyerRoles?: string, company?: string): Found[] {
  const found = new Map<string, Found>()
  let path = ''; try { path = new URL(pageUrl).pathname } catch { return [] }
  const clean = cutBlocks(html)
  if (clean === null) return [] // a quoted/testimonial region that never closes cannot be separated from the page: fail closed
  const visible = clean.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
  // Link labels and where they point. A name that is a link label is a menu or card label (refused), EXCEPT when the link is that
  // person's own page on this site: its path ends with a slug made of the person's name ("/people/jane-l-roe"), as a firm's people and
  // office pages link every listed lawyer to their bio. That link confirms the name rather than casting doubt on it.
  const linkTargets = new Map<string, string[]>()
  for (const m of visible.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const label = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
    const href = /\bhref\s*=\s*["']([^"'#]+)["']/i.exec(m[1])?.[1] ?? ''
    linkTargets.set(label, [...(linkTargets.get(label) ?? []), href])
  }
  const linkText = { has: (label: string) => linkTargets.has(label) }
  const slugOf = (n: string) => n.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/^(?:dr|mr|ms|mrs)\.?\s+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const ownBioLink = (name: string) => {
    let base: URL; try { base = new URL(pageUrl) } catch { return false }
    const slug = slugOf(name), host = base.hostname.replace(/^www\./, '')
    return (linkTargets.get(name.toLowerCase()) ?? []).some(h => { try { const u = new URL(h.replace(/&amp;/g, '&'), base); const seg = segmentsOf(u.pathname.replace(/\/+$/, '')); if (seg.length < 2 || !BIO_PARENT.test(seg[seg.length - 2]) || seg.slice(0, -1).some(x => BIO_MARK.test(x))) return false; return u.hostname.replace(/^www\./, '') === host && (u.pathname.replace(/\/+$/, '').split('/').pop() ?? '').replace(/\.html?$/, '') === slug } catch { return false } })
  }
  const strict = (x: string) => x.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and').replace(/[,.]?\s*\b(inc|llc|ltd|llp|pllc|pc|plc|corp|co|pty ltd|pty)\.?\s*$/i, '').replace(/[^a-z0-9]+/g, '')
  const companyNorm = company ? strict(company) : ''
  const ownCompanyTail = (title: string) => {
    if (!companyNorm) return title
    // every separator is tried, so "Head of Sales at Acme" keeps "Head of Sales"
    for (const m of title.matchAll(/\s*(?:,|\bat\b|\bof\b|@|\u2013|\u2014|-)\s*/gi)) { const tail = title.slice((m.index ?? 0) + m[0].length); if ((m.index ?? 0) > 0 && tail.length >= 2 && tail.length <= 80 && !tail.includes(',') && strict(tail) === companyNorm) return title.slice(0, m.index) }
    return title
  }
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
  const add = (name: string, title: string, viaJson = false) => {
    name = name.replace(/\s+/g, ' ').trim(); title = ownCompanyTail(title.replace(/\s+/g, ' ').trim())
    if (roleEndedByDate(title) || roleContradicted(title, buyerRoles)) return // an explicit past end date or a past-tense title: not current staff
    // A hyphenated word whose second part is lowercase ("Australia-wide", "Award-winning") is a phrase, never a name ("Jean-Paul" is).
    if (/\b[A-Za-z]+-[a-z]/.test(name)) return
    if (!NAME_LINE.test(name) || looksLikeJobTitle(name) || !(TITLE_FULL.test(title) || buyerTitle(title, buyerRoles))) return // #1183: "Litigation Specialist" is a title, not a person
    if (!viaJson) {
      if (!peoplePage(path)) return
      if (lowerWords.size < 15) return // no prose on the page: nothing to judge a name-shaped phrase against, fail closed
      if (linkText.has(name.toLowerCase()) && !ownBioLink(name)) return
      // A title that is itself a link label is a menu or service link, not a title ("Serving Australia-wide" over the menu link "Digital
      // Marketing Consultant Melbourne", #1102 run G on sagarsethi.com.au).
      if (linkText.has(title.toLowerCase())) return
      if (name.replace(/^(Dr|Mr|Ms|Mrs)\.?\s+/, '').split(/\s+/).some(w => lowerWords.has(w.toLowerCase().replace(/\.$/, '')))) return
    }
    if (!found.has(name.toLowerCase())) found.set(name.toLowerCase(), { kind: 'person', value: `${name}, ${title}`.slice(0, 120), label: 'listed with this title on this company page, not verified as current staff', url: pageUrl })
  }
  for (const p of jsonLdPeople(clean)) add(p.name, p.title, true)
  for (let i = 0; i < lines.length; i++) {
    const same = /^([^,\u2013\u2014|]{3,45}?)\s*(?:,|\u2013|\u2014|-|\|)\s*([^,\u2013\u2014|]{3,40})$/.exec(lines[i])
    if (inFormer[i]) continue
    if (same) add(same[1], same[2])
    // #1183: an adjacent "Name" + "Title" pair is refused when the "name" reuses a word the page's OWN titles and the scan's buyer roles use
    // ("Managing Member" beside "Managing Partner"): that is an unmarked title list, whatever markup it sits in. Learned from the page, not a vocabulary.
    if (i + 1 < lines.length && lines[i].length < 45 && lines[i + 1].length < 45 && !inFormer[i + 1] && !reusesTitleWord(lines[i])) add(lines[i], lines[i + 1])
  }
  // Up to PAGE_PEOPLE per page, most senior first; crawlSite makes the final choice of 3 (buyer roles first when known).
  return [...found.values()].sort(bySeniority).slice(0, PAGE_PEOPLE)
}

// Which listed person to keep when a page lists many: whoever can sign off on a purchase first. Pure ordering of what
// extractPeople already accepted; it never adds or invents a person. Ties keep page order (stable sort).
export function seniority(title: string): number {
  const t = title.toLowerCase()
  if (/\b(founder|owner|proprietor|ceo|president|principal|managing (?:director|partner|shareholder|principal)|chief executive)\b/.test(t)) return 4
  if (/\b(c[a-z]o|chief|vp|svp|evp|vice president|head|general manager)\b/.test(t)) return 3
  if (/\b(director|partner|broker)\b/.test(t)) return 2
  return 1
}
const titleOf = (f: Found) => f.value.slice(f.value.indexOf(', ') + 2)
export const byBuyerThenSeniority = (buyerRoles: string) => (a: Found, b: Found) => titleMatches(titleOf(b), buyerRoles).length - titleMatches(titleOf(a), buyerRoles).length || bySeniority(a, b)
export const bySeniority = (a: Found, b: Found) => seniority(b.value.slice(b.value.indexOf(', ') + 2)) - seniority(a.value.slice(a.value.indexOf(', ') + 2))

// A path is a candidate page only when a WHOLE segment (the first after a locale, or the second under a container such as /firm/) is a hint
// word and it is at most three segments deep: "/contact-tracing-guide" and "/company-news/new-ceo-joins" are not; a blog post such as "/insights/blog-posts/contact-tracing-in-the-uk" or "/blog/about-stats-gaps" is not the company's contact or about page.
const HINT_SEGMENT = /^(?:our-|the-|meet-(?:the-|our-)?)?(?:contact(?:-?us)?|about(?:-?us)?|about-the-(?:firm|practice|team|company)|the-firm|(?:leadership|management|executive|practice|senior|core|dental|legal)-team|team-members|impressum|kontakt|contacto|contato|nous-contacter|contactez(?:-nous)?|chi-siamo|company|team|leadership|management|people|staff|attorneys|lawyers|professionals|reach(?:-us)?|locations?|offices?|careers?|our-practice|providers|doctors?|dentists?|our-story|who-we-are|our-firm)(?:\.[a-z]{2,5})?$/
const hinted = (pathname: string) => { const seg = segmentsOf(pathname); return seg.length > 0 && seg.length <= 3 && !seg.slice(1).some(x => POST_SEGMENT.test(x)) && (HINT_SEGMENT.test(seg[0]) || (CONTAINER_SEGMENT.test(seg[0]) && seg.length >= 2 && HINT_SEGMENT.test(seg[1]))) }
// A firm's index of its offices ("/locations", "/offices", "/firm-offices", "/locations.html").
const LOCATIONS_INDEX = /^\/(?:[a-z-]*-)?(?:locations?|offices?)(?:\.html?)?\/?$/i
// The city slugs a request names ("Chicago, Illinois" -> "chicago"; "Kansas City" -> "kansas-city").
export function citySlugs(places: string[]): string[] {
  // exactly one city: with several (a multi-city scan), which office a lead belongs to is not known here, so no office page is sought
  const one = [...new Set(places.map(p => String(p).split(',')[0].trim().toLowerCase()).filter(Boolean))]
  const regions = new Set(places.map(p => String(p).split(',').slice(1).join(',').trim().toLowerCase()).filter(Boolean))
  if (one.length !== 1 || regions.size > 1) return []   // "Paris, Texas" + "Paris, France" are two places
  return [...new Set(places.map(p => String(p).split(',')[0].trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).filter(x => x.length >= 3))]
}
// The requested city's office segment: the slug itself or the slug plus a two-letter state ("chicago", "chicago-il").
// The suffix must be the REQUESTED region's code: "portland-or" is not Portland, Maine; "paris-fr" is not Paris, Texas.
// "Chicago, IL", "Chicago, Illinois", "Chicago, IL, USA", "Chicago, IL 60601": the first region after the city.
// The request's region parts after the city, without dots, ZIPs or country words ("IL." -> "il"; "Ill. 60601" -> "ill"; "U.S.", "USA" -> nothing).
const COUNTRY_WORDS = /\b(?:usa|us|united states(?: of america)?|america)\b/g
const regionParts = (places: string[]) => places.flatMap(p => String(p).split(',').slice(1).map(x => x.toLowerCase().replace(/\./g, '').replace(/\d[\d-]*/g, ' ').replace(COUNTRY_WORDS, ' ').replace(/\s+/g, ' ').trim())).filter(Boolean)
// The standard (AP) state abbreviations: a fixed list, never a guessed name prefix ("Kent" is not Kentucky; a path "west" is not West Virginia).
const STATE_ABBREV: Record<string, string> = { ala: 'al', ariz: 'az', ark: 'ar', calif: 'ca', cal: 'ca', colo: 'co', conn: 'ct', del: 'de', fla: 'fl', ill: 'il', ind: 'in', kan: 'ks', kans: 'ks', mass: 'ma', mich: 'mi', minn: 'mn', miss: 'ms', mont: 'mt', neb: 'ne', nebr: 'ne', nev: 'nv', okla: 'ok', ore: 'or', oreg: 'or', penn: 'pa', tenn: 'tn', tex: 'tx', wash: 'wa', wis: 'wi', wisc: 'wi', wyo: 'wy' }
// A two-letter code, a state name, or a standard abbreviation.
const stateCode = (r: string): string | null => { if (/^[a-z]{2}$/.test(r)) return r; const exact = Object.entries(US_STATES).find(([, name]) => name === r); if (exact) return exact[0].toLowerCase(); return STATE_ABBREV[r] ?? null }
const regionCodes = (places: string[]) => new Set(regionParts(places).flatMap(r => { const c = stateCode(r); return c ? [c] : [] }))
// No region in the request at all ("Chicago"): any two-letter suffix is accepted, as the request cannot tell them apart. A region this
// reader does not know ("Paris, France") is NOT "no region": only the exact slug matches.
const bareCity = (places: string[]) => places.every(p => String(p).split(',').slice(1).every(x => !x.toLowerCase().replace(/\./g, '').replace(COUNTRY_WORDS, ' ').trim()))   // "Chicago", "Chicago, USA"; not "Paris, 75001"
const cityMatch = (slugs: string[], x: string, places: string[]) => { const codes = regionCodes(places); return slugs.some(c => x === c || (x.startsWith(c + '-') && /^[a-z]{2}$/.test(x.slice(c.length + 1)) && ((codes.size === 0 && bareCity(places)) || codes.has(x.slice(c.length + 1))))) }
// Same-site links to the office page for a requested city: a path whose segments include the city's slug next to an office segment, or a
// last segment that is the slug itself under a locations / offices path ("/locations/chicago", "/locations/offices/chicago.html").
export function officeLinks(html: string, base: URL, places: string[]): string[] {
  const slugs = citySlugs(places); if (slugs.length === 0) return []
  const out: string[] = []
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi)) {
    let u: URL; try { u = new URL(m[1].replace(/&amp;/g, '&'), base) } catch { continue }
    if (u.protocol !== 'https:' || u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '') || u.search) continue
    const seg = u.pathname.toLowerCase().replace(/\.html?$/, '').split('/').filter(Boolean)
    if (seg.length < 2 || seg.length > 4) continue
    const last = seg[seg.length - 1]
    if (cityMatch(slugs, last, places) && seg.slice(0, -1).some(x => /^(?:[a-z-]*-)?(?:locations?|offices?)$/.test(x))) { if (!out.includes(u.pathname)) out.push(u.pathname) }
  }
  return out.slice(0, 2)
}
// A path under a locations / offices segment ("/locations/denver") is the page of ONE office: read only when that office is the requested city.
// Which office a path is about, from the segments after its LAST locations / offices segment: "none" (the index, or a people page such as
// "/offices/leadership"), "requested" (the requested city's slug anywhere after it: "/locations/chicago", "/offices/team/chicago",
// "/locations/us/chicago"), or "other" (any other office: "/locations/denver", "/offices/team/dallas", "/locations/texas/paris" for Paris, France).
// A "requested" page still has to agree with the requested place before its people count (crawlSite), so "/offices/new-york/dallas" for Dallas is
// judged by what the page says.
const US_CODES = new Set(Object.keys(US_STATES).map(k => k.toLowerCase()))
// A path segment read as a US state: "texas", "tx", "tex", "us-texas", "new-york"; null otherwise. `codes`: also two-letter codes.
const pathState = (x: string, codes: boolean): string | null => { const r = x.replace(/^(?:usa?|united-states)-/, '').replace(/-/g, ' '); if (!codes && /^[a-z]{2}$/.test(r)) return null; const st = stateCode(r); return st && US_CODES.has(st) ? st : null }
// Two-letter codes that are both a US state and a language locale ("/de/", "/ar/", "/hi/"): as a leading segment they are read as the locale.
const LOCALE_LIKE = new Set(['ak', 'ar', 'ca', 'co', 'de', 'ga', 'hi', 'ia', 'id', 'in', 'ks', 'ky', 'la', 'mn', 'ms', 'mt', 'nd', 'ne', 'or', 'pa', 'sc', 'sd', 'tn', 'wa'])
function officeOf(pathname: string, places: string[]): 'none' | 'requested' | 'other' {
  const seg = segmentsOf(pathname).map(x => x.replace(/\.[a-z]{2,5}$/, ''))
  const i = seg.findLastIndex(x => /^(?:[a-z-]*-)?(?:locations?|offices?)$/.test(x))
  if (i < 0 || i === seg.length - 1) return 'none'
  if (i === seg.length - 2 && PEOPLE_SEGMENT.test(seg[i + 1])) return 'none'
  const slugs = citySlugs(places)
  // the requested city's segment: the LAST match, so for a city that is also a state name ("/offices/new-york/buffalo" for New York, NY)
  // the state segment is not taken for the city
  let j = -1
  if (slugs.length > 0) for (let k = seg.length - 1; k > i; k--) if (cityMatch(slugs, seg[k], places)) { j = k; break }
  if (j < 0) return 'other'
  const codes = regionCodes(places)
  // a city named like a state ("new-york", "washington") followed by anything but a people word, the requested region or "<city>-city" is that
  // state's other office ("/offices/new-york/buffalo"; "/offices/washington/dc" and "/offices/new-york/new-york-city" are the city itself)
  // ... and preceded by another place ("/locations/spokane/washington" for Washington, DC: the trailing "washington" is Spokane's state)
  if (pathState(seg[j].replace(/-[a-z]{2}$/, ''), false) && seg.slice(i + 1, j).some(x => !PEOPLE_SEGMENT.test(x) && !pathState(x, true) && x !== 'us')) return 'other'
  if (pathState(seg[j].replace(/-[a-z]{2}$/, ''), false) && seg.slice(j + 1).some(x => !PEOPLE_SEGMENT.test(x) && x !== `${seg[j].replace(/-[a-z]{2}$/, '')}-city` && !codes.has(pathState(x, true) ?? x))) return 'other'
  // a US state anywhere in the path (before or after the city) that is not the requested region: "/locations/texas/paris",
  // "/texas/locations/paris", "/locations/paris/texas" are not Paris, France; "/locations/springfield/mo" is not Springfield, IL.
  // Before the office segment a two-letter code counts unless it is also a language code ("/us/tx/locations/" is Texas; "/de/" is a locale).
  // a leading state code that segmentsOf took for a locale ("/tx/locations/paris", "/us-tx/locations/paris")
  // (with a "us-" prefix it is a state even when it is also a language code: "/us-ca/")
  const rawLead = pathname.toLowerCase().split('/').filter(Boolean)[0] ?? '', prefixed = /^(?:usa?|united-states)-/.test(rawLead), lead = rawLead.replace(/^(?:usa?|united-states)-/, '')
  if (!bareCity(places) && /^[a-z]{2}$/.test(lead) && US_CODES.has(lead) && (prefixed || !LOCALE_LIKE.has(lead)) && !codes.has(lead)) return 'other'
  if (!bareCity(places) && seg.some((x, k) => { if (k === j) return false; const st = pathState(k === i ? x.replace(/-?(?:locations?|offices?)$/, '') : x, k > i || !LOCALE_LIKE.has(x)) /* "/texas-offices/" names Texas */; return !!st && !codes.has(st) })) return 'other'
  return 'requested'
}
// A path under a locations / offices segment that is ANOTHER office (or any office, when no single city is requested): never read.
export function otherOffice(pathname: string, places: string[]): boolean { return officeOf(pathname, places) === 'other' }
// The requested city's own office page: its people count only when the page agrees with the requested place.
function cityOffice(pathname: string, places: string[]): boolean { return officeOf(pathname, places) === 'requested' }
export function contactPaths(homeHtml: string, home: URL, places: string[] = []): string[] {
  const offices = officeLinks(homeHtml, home, places)
  const set = new Set<string>([...offices, '/contact', '/contact-us', '/about', '/team', '/leadership'])
  const indexes: string[] = []
  for (const m of homeHtml.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi)) {
    let u: URL; try { u = new URL(m[1].replace(/&amp;/g, '&'), home) } catch { continue }
    if (u.protocol !== 'https:' || u.hostname.replace(/^www\./, '') !== home.hostname.replace(/^www\./, '')) continue
    if (u.search || u.pathname.length >= 60 || /\.(pdf|jpg|png|zip)$/i.test(u.pathname) || !hinted(u.pathname) || otherOffice(u.pathname, places)) continue
    // with a city requested and no direct office link, the locations index goes first: it leads to the office page
    if (offices.length === 0 && citySlugs(places).length > 0 && LOCATIONS_INDEX.test(u.pathname)) indexes.push(u.pathname)
    set.add(u.pathname)
  }
  for (const extra of ['/locations', '/our-team', '/careers']) set.add(extra) // after the page's own links: same cap, never ahead of them
  return [...new Set([...indexes.slice(0, 1), ...set])].slice(0, 8)
}

// Abort-aware sleep: resolves early (to false) when the signal fires, so the
// polite per-host gap does not outlive a post-processing deadline.
const sleepAbort = (ms: number, signal?: AbortSignal) => new Promise<boolean>((resolve) => {
  if (signal?.aborted) return resolve(false)
  const t = setTimeout(() => resolve(true), ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(false) }, { once: true })
})
const lastHit = new Map<string, number>()

// onPage (optional) sees the raw HTML of every own-site page read; used only by the email finder (EMAIL_GUESS_ENABLED).
// buyerRoles (optional): the scan ICP's "who" roles. Listed people whose title shares ICP words are kept first, so for a
// payroll seller "Head of HR" is not crowded out by a CTO; seniority breaks ties. Without it, seniority only (as before).
// budgetMs: an intrinsic wall-clock bound for the WHOLE crawl (#871) - robots, home, every polite wait, every own-site page and the
// social branch. A fetch never starts once the budget is spent, a polite gap that would outlive it is not waited out, and every fetch
// is handed a combined caller-abort + deadline signal so a bound or aborted crawl CANCELS the in-flight native fetch. The value is
// always finite and positive (crawlBudgetBound): invalid or non-positive inputs become CRAWL_BUDGET_MS, never an unbounded crawl.
// The return names which bound stopped the crawl (stoppedBy); a budget stop before the homepage reads reason 'time_budget', a caller
// abort reads reason 'aborted', and both are treated as unread.
export async function crawlSite(site: string, get: Get = (url, opts) => rawGet(url, 0, TIMEOUT_MS, guardedLookup, opts?.signal), gapMs = GAP_MS, expectName?: string, social = false, signal?: AbortSignal, onPage?: (html: string, url: string, status: number) => void, buyerRoles?: string, budgetMs: number = CRAWL_BUDGET_MS, places: string[] = []): Promise<{ found: Found[]; reason: string; pages: number; tech?: TechHit[]; homeObs?: Observability; homeNorm?: string; homeText?: string; stoppedBy?: 'pages' | 'time' | 'aborted' }> {
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
    const polite = async (url: string, delay: number) => {
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
        const r = await Promise.race([get(url, { signal: fetchSignal() }), interrupted])
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
    let robots: Robots
    if (!rob) return timeStop ? { found: [], reason: 'time_budget', pages: 0, stoppedBy: 'time' } : (abortStop || stopped()) ? { found: [], reason: 'aborted', pages: 0, stoppedBy: 'aborted' } : { found: [], reason: 'robots_unreachable', pages: 0 }
    if (rob.status >= 500) return { found: [], reason: 'robots_error', pages: 0 }
    robots = rob.status >= 400 ? { allows: () => true, delayMs: 0 } : parseRobots(rob.body, site)
    if (!robots.allows('/')) return { found: [], reason: 'robots_disallow', pages: 0 }
    const home = await polite(`${origin}/`, robots.delayMs)
    if (!home || home.status >= 400) return timeStop ? { found: [], reason: 'time_budget', pages: 0, stoppedBy: 'time' } : (abortStop || stopped()) ? { found: [], reason: 'aborted', pages: 0, stoppedBy: 'aborted' } : { found: [], reason: 'site_unreachable', pages: 0 }
    // The normalised homepage text is returned so a later lead on the same domain is checked against it without a second fetch.
    const homePlain = home.text ?? plainText(home.body)   // #1122: the whole page's text (beyond the stored body's cap), in one linear pass
    const homeNorm = norm(homePlain)
    // Case-preserved text (capped) for the place-agreement check: an address like "Rome, NY 13440" needs its capitals.
    const homeText = homePlain.replace(/\s+/g, ' ').trim().slice(0, 30_000)
    if (expectName && !homeNorm.includes(norm(expectName))) return { found: [], reason: 'name_mismatch', pages: 1, homeNorm, homeText }
    const found = new Map<string, Found>(); let pages = 1
    onPage?.(home.body, home.finalUrl, home.status)
    for (const f of [...extractContacts(home.body, home.finalUrl, site), ...extractPeople(home.body, home.finalUrl, buyerRoles, expectName)]) found.set(f.kind + f.value, f)
    // The pages to read, in order. A page that lands where an earlier one did ("/contact" and "/contact/") is read once. When the request names a
    // city, a firm's page for THAT office comes first (its office leader is the decision-maker for the request): a homepage link to it, or one
    // found on the firm's locations index (read for that purpose only, two hops at most).
    const queue = contactPaths(home.body, new URL(home.finalUrl), places)
    const seenUrls = new Set<string>([home.finalUrl.replace(/\/+$/, '')])
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]
      if (stopped()) { stoppedBy = 'aborted'; break }
      if (pages >= MAX_PAGES) { stoppedBy = 'pages'; break }
      if (deadline && Date.now() >= deadline) { stoppedBy = 'time'; break }
      if (!robots.allows(p)) continue
      if (seenUrls.has((origin + p).replace(/\/+$/, ''))) continue
      const r = await polite(origin + p, robots.delayMs)
      if (!r || r.status >= 400) continue
      const landed = r.finalUrl.replace(/\/+$/, '')
      seenUrls.add((origin + p).replace(/\/+$/, ''))
      if (seenUrls.has(landed) && landed !== (origin + p).replace(/\/+$/, '')) continue
      seenUrls.add(landed)
      pages++
      // An office page's people count only when it is the requested office (a redirect or a homepage link may still land on another one).
      let officePath = ''; try { officePath = new URL(r.finalUrl).pathname } catch { /* keep '' */ }
      // another city's office, or the requested city's office path whose page places it elsewhere ("Paris" in France for Paris, Texas):
      // not stored, not read for people, contacts or addresses. A page that does not say where it is keeps its contacts; its people need 'agrees'.
      const officeVerdict = cityOffice(officePath, places) ? placeAgreement(r.body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '), places, expectName ?? '') : null
      if (otherOffice(officePath, places) || officeVerdict === 'mismatch') continue
      onPage?.(r.body, r.finalUrl, r.status)
      // a locations index: the office page for the requested city, read next
      if (LOCATIONS_INDEX.test(p)) for (const o of officeLinks(r.body, new URL(r.finalUrl), places).reverse()) if (!queue.includes(o)) queue.splice(qi + 1, 0, o)
      for (const f of [...extractContacts(r.body, r.finalUrl, site), ...(!LOCATIONS_INDEX.test(officePath) && (officeVerdict === null || officeVerdict === 'agrees') ? extractPeople(r.body, r.finalUrl, buyerRoles, expectName) : [])]) if (!found.has(f.kind + f.value)) found.set(f.kind + f.value, f)
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
    const all = [...found.values()], contacts = all.filter(f => f.kind !== 'person'), people = all.filter(f => f.kind === 'person')
    const sb = stoppedBy ?? (timeStop ? 'time' as const : abortStop ? 'aborted' as const : undefined)
    return { found: [...contacts.slice(0, 6), ...people.sort(buyerRoles ? byBuyerThenSeniority(buyerRoles) : bySeniority).slice(0, 3)], reason: contacts.length ? 'ok' : 'none_published', pages, tech: detectTech(home.body), homeObs: observability(home.status, home.body), homeNorm, homeText, ...(sb ? { stoppedBy: sb } : {}) }
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
  for (const m of evidenceText.slice(0, 6000).matchAll(PLACE_AFTER)) { const t = norm(m[1]); const ws = t.split(' ').filter(Boolean); if (ws.length === 0 || ws.every(w => NOT_PLACE.has(w) || own.includes(w)) || NOT_PLACE_LEAD.has(ws[0])) continue; add(m[1]) }
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
export function probeLocationAgrees(home: string | undefined, where: string[], lead: { company: string; signal?: string | null; evidence_excerpt?: string | null }, evidence?: { homeNorm: string | undefined; places: string[] }): boolean {
  const text = home ?? ''
  if (!text) return false
  if (where.length > 0 && ownAddressElsewhere(text, where)) return false   // the site's own address is in another state
  if (where.length > 0 && placeAgreement(text, where, lead.company) === 'agrees') return true
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
    out.push({ tight: mailto ? '' : tight, wide, attr: inAttr && !mailto && attrName.startsWith('data-') })
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
    if ((db.prepare('SELECT company_domain FROM leads WHERE id = ?').get(l.id) as { company_domain: string | null } | undefined)?.company_domain) return
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

export async function crawlJob(db: Database.Database, tenantId: string, jobId: string, deps: { redirectOf?: (host: string) => Promise<string | null>; get?: Get; gapMs?: number; env?: Record<string, string | undefined>; now?: number; leads?: { id: string; company: string; source_url: string; review_reason?: string | null; signal?: string | null; evidence_excerpt?: string | null }[]; skipEvidenceFetch?: boolean; signal?: AbortSignal; findSites?: (company: string, where: string[]) => Promise<string[]> } = {}): Promise<void> {
  try {
    if (!sitecrawlEnabled(deps.env)) return
    // The per-site crawl budget resolves per call (env-overridable, #871); an unparseable value falls back to the default bound.
    const crawlBudgetMs = crawlBudgetBound(Number((deps.env ?? process.env).SITECRAWL_CRAWL_BUDGET_MS ?? CRAWL_BUDGET_MS))
    // Signal threads only into the rawGet path; a crawl4ai backend keeps its
    // own 40s per-call bound (outer deadline does not reach it yet - tracked).
    const get = deps.get ?? (deps.signal && !deps.env?.CRAWL4AI_URL && !process.env.CRAWL4AI_URL
      ? (url, opts) => rawGet(url, 0, TIMEOUT_MS, guardedLookup, opts?.signal ?? deps.signal)
      : defaultGet(deps.env))
    // signal and evidence_excerpt feed the location check; a leads table without them (older schema) still crawls.
    // Held leads whose evidence page could not be READ (blocked_by_site / needs_javascript) get the same identity attempt as the
    // date/quote classes: a blocked article says nothing about the company's own site. This never re-fetches the blocked evidence
    // page (below) and never clears the hold: identity/contact discovery only, qualification unchanged. Classes where the hold is
    // the event itself (job_closed, no_event_evidence, counterparty_signal, ...) are NOT selected - identity cannot change them.
    const pick = (cols: string) => db.prepare(`SELECT ${cols} FROM leads WHERE scan_job_id = ? AND ((review_reason IS NULL AND confidence IS NOT NULL) OR review_reason IN ('outside_window_undated', 'quote_unconfirmed', 'blocked_by_site', 'needs_javascript')) AND company <> '' ORDER BY (review_reason IS NOT NULL), score DESC LIMIT ?`).all(jobId, MAX_SITES_PER_SCAN)
    const leads = (deps.leads ?? (() => { try { return pick('id, company, source_url, review_reason, signal, evidence_excerpt') } catch { return pick('id, company, source_url') } })()) as { id: string; company: string; source_url: string; review_reason?: string | null; signal?: string | null; evidence_excerpt?: string | null }[]
    // The scan's geography, for the location check on guessed domains.
    let where: string[] = []
    try { const j = db.prepare('SELECT icp FROM scan_jobs WHERE id = ?').get(jobId) as { icp: string | null } | undefined; const w = j?.icp ? (JSON.parse(j.icp) as { where?: unknown }).where : null; if (Array.isArray(w)) where = w.filter((x): x is string => typeof x === 'string') } catch { /* no ICP: evidence places only */ }
    const today = new Date((deps.now ?? Date.now())).toISOString().slice(0, 10)
    // One crawl per site per run. Another lead on the same domain is NOT skipped: its own identity check runs against the cached homepage
    // text (same name test, per lead), and it reuses the pages already read, so no extra fetch and no extra budget. Only when the first lead's
    // name was absent from the homepage but this lead's name is present is the site read once more, because the earlier read stopped at the
    // identity check. Site-level outcomes (robots, unreachable) are the same for every lead and are reused as they are.
    type Crawled = Awaited<ReturnType<typeof crawlSite>>
    const siteRead = new Map<string, Crawled>()
    // Email finder part 1 (off by default): personal local parts published on each confirmed site, never shown or sent.
    const localsBySite = new Map<string, Set<string>>()
    const seenBySite = new Map<string, Map<string, { address: string; url: string; ctx?: AddressContext[] }>>() // email finder: printed addresses + page
    // The scan's buyer roles (ICP "who"), so the 3 people kept per site are the ones the seller wants to reach.
    let buyerRoles: string | undefined
    try { const j = db.prepare('SELECT icp FROM scan_jobs WHERE id = ?').get(jobId) as { icp: string | null } | undefined; const who = j?.icp ? (JSON.parse(j.icp) as { who?: unknown }).who : null; if (Array.isArray(who) && who.length) buyerRoles = who.filter(x => typeof x === 'string').join('; ').slice(0, 600) } catch { /* no ICP: seniority only */ }
    const readSite = async (cand: string, company: string): Promise<Crawled> => {
      const c = siteRead.get(cand)
      if (c) {
        if (c.homeNorm === undefined) return c
        if (!c.homeNorm.includes(norm(company))) return { found: [], reason: 'name_mismatch', pages: 0 }
        if (c.reason !== 'name_mismatch') return c
      }
      const locals = new Set<string>(); localsBySite.set(cand, locals)
      const seen = new Map<string, { address: string; url: string; ctx?: AddressContext[] }>(); seenBySite.set(cand, seen)
      // Every page the crawl fetches is recorded with its exact URL and its own completion time (#871); the email
      // finder keeps riding the same callback when enabled. The crawl runs under an intrinsic wall-clock budget so a
      // slow host or a polite per-host gap cannot stretch one site's read past CRAWL_BUDGET_MS.
      const onPage = (html: string, url: string, status: number) => {
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
      const r = await crawlSite(cand, get, deps.gapMs, company, (deps.env ?? process.env).SITECRAWL_SOCIAL === '1', deps.signal, onPage, buyerRoles, crawlBudgetMs, where)
      siteRead.set(cand, r)
      return r
    }
    // An injected fetch (tests, the crawl4ai backend's callers) never reaches the network for a redirect unless one is injected too.
    const redirectOf = deps.redirectOf ?? (deps.get ? async () => null : (host: string) => rawRedirectTarget(host, TIMEOUT_MS, guardedLookup, deps.signal))
    const redirectSeen = new Map<string, string | null>()   // host -> where it forwards (or null), for the whole scan
    let probed = 0
    for (const l of leads) {
      if (deps.signal?.aborted) return // post-processing deadline: stop starting new sites
      // A lead held because its evidence page blocked us (or needs JavaScript) never has that page fetched again here:
      // the block is known, re-hitting it is pressure on a refusing site, and the answer would be the same. Identity is
      // probed from the company name + place instead (strict agreement checks below apply unchanged).
      const ev = (deps.skipEvidenceFetch || l.review_reason === 'blocked_by_site' || l.review_reason === 'needs_javascript') ? null : await get(l.source_url)
      // The blocked-host guard covers EVERY path to a site, not just the evidence URL: when the company name resolves to
      // the very host that refused this lead's fetch (its own blog/docs were the evidence), probing it would re-hit a
      // refusing site by another path. Such candidates are excluded and the skip is audited.
      const blockedHost = (l.review_reason === 'blocked_by_site' || l.review_reason === 'needs_javascript') ? (() => { try { return new URL(l.source_url).hostname.toLowerCase() } catch { return null } })() : null
      const notBlockedHost = (d: string) => { const h = d.toLowerCase(); return !blockedHost || (h !== blockedHost && !h.endsWith('.' + blockedHost) && !blockedHost.endsWith('.' + h)) }
      const basisOf = new Map<string, DomainBasis>()
      const nowSec = Math.floor((deps.now ?? Date.now()) / 1000)
      let sites: string[] = []
      // A site the cited page shows as a link (or the page's own domain) is "linked": if it is read and refused, resolution ends there, as
      // before. A site named only in the page's structured data is a candidate: it is tried first, and its refusal stops nothing (#1122).
      let anchored = false; const structured: string[] = []
      if (ev) for (const o of findCompanySitesWithBasis(l.company, ev.body, ev.finalUrl)) { basisOf.set(o.site, o.basis); if (o.structured) structured.push(o.site); else { sites.push(o.site); anchored = true } }
      // a site named in the page's structured data is tried too when the page also links one (review at 576f9c8c: it was dropped whenever an
      // anchored link existed): after the linked sites, under the same checks; it never turns into a reason to skip what the page links
      if (anchored) for (const h of structured) if (!sites.includes(h)) sites.push(h)
      let unresolved = anchored ? 'linked_site_not_confirmed' : 'not_confirmed'
      if (!anchored) {
        // Evidence page does not link the company site: probe name-derived domains. Wrong guesses
        // are rejected by the homepage name check inside crawlSite.
        if (probed >= MAX_PROBES_PER_SCAN) {
          audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: l.company, status: 'no_site_linked', results: 0 })
          if (structured.length === 0) { recordDomainUnresolved(db, tenantId, l, 'probe_limit_reached', today, nowSec); continue }
          sites = [...structured]; unresolved = 'probe_limit_reached'   // no name guess and no search ran for this lead
        } else {
          probed++
          const guesses = probeDomains(l.company, where)   // #1122: the request country's TLD too (a Toronto lead at <name>.ca)
          // #1122 (review at 01140156): the lead's source page is ON the company's own name-built domain and it refused reading. That site is
          // already known and already refused us; a web search could only return it again, so none is made and the reason says what happened.
          const ownBlocked = !!blockedHost && guesses.some(g => !notBlockedHost(g))
          // #1036 4b: the company's own host from a web search first (one search per lead, capped by the caller), then the name guesses
          let found: string[] = []
          if (deps.findSites && !deps.signal?.aborted && !ownBlocked) { try { found = await deps.findSites(l.company, where) } catch { found = [] } }
          sites = [...structured, ...found.filter(d => !structured.includes(d)), ...guesses.filter(d => !found.includes(d) && !structured.includes(d))]
          for (const d of sites) if (!basisOf.has(d)) basisOf.set(d, 'name_probe')
          if (blockedHost) { const kept = sites.filter(notBlockedHost); if (kept.length !== sites.length) audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: blockedHost, status: 'skipped_site_refused_us', results: 0 }); sites = kept }
          const ownCode = l.review_reason === 'needs_javascript' ? 'own_site_needs_javascript' : 'own_site_refused_reading'
          if (ownBlocked) unresolved = ownCode
          if (sites.length === 0) { audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: l.company, status: 'no_site_linked', results: 0 }); recordDomainUnresolved(db, tenantId, l, ownBlocked ? ownCode : 'no_site_linked', today, nowSec); continue }
        }
      }
      let redirects = 0, asks = 0, robotsStopped = false, answered = false
      const followed = new Set<string>()   // hosts that are themselves forwarding targets: never followed further
      let r: Awaited<ReturnType<typeof crawlSite>> = { found: [], reason: 'name_mismatch', pages: 0 }; let site = sites[0]
      // Nothing usable was read: wrong company, unreachable, or the time budget stopped the crawl before the homepage (#871).
      const unread = (x: Awaited<ReturnType<typeof crawlSite>>) => x.reason === 'name_mismatch' || x.reason === 'site_unreachable' || x.reason === 'time_budget' || x.reason === 'aborted'
      // Places this lead is about: the scan geography plus places its own evidence names (signal, quote, cited page).
      const places = placeTerms(where, [l.signal ?? '', l.evidence_excerpt ?? '', ev?.body ? (ev.text ?? plainText(ev.body)) : ''].join(' '), l.company)
      for (const cand of sites) {
        site = cand
        r = await readSite(cand, l.company)
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
        if (!unread(r) && ((basisOf.get(cand) === 'name_probe' && !probeLocationAgrees(r.homeText, where, l, { homeNorm: r.homeNorm, places })) || (basisOf.get(cand) !== 'name_probe' && basisOf.get(cand) !== 'evidence_own_domain' && places.length > 0 && !placeConsistent(r.homeNorm, places)))) {
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
          const v = r.homeText ? placeAgreement(r.homeText, where, l.company) : 'unconfirmed'
          if (v === 'mismatch' || (r.homeText && ownAddressElsewhere(r.homeText, where)) || (v !== 'agrees' && v !== 'no_geography' && cityScoped(where) && basisOf.get(cand) === 'name_probe')) {
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
      if (unread(r)) { recordDomainUnresolved(db, tenantId, l, r.reason === 'time_budget' ? 'time_budget' : robotsStopped && !answered && unresolved === 'not_confirmed' ? 'site_not_readable' : unresolved, today, nowSec); continue }
      // The crawl's own time budget stopping it mid-read is the same class of partial read (#871): the pages actually
      // fetched stay recorded in crawl_pages (facts with their own times), but NO derived domain/tech/contact rows.
      if (r.stoppedBy === 'time') continue
      // The site answered but its robots rules could not be read, or forbid reading it: nothing is read, no domain is kept, and the lead says so (#1122).
      if (r.reason !== 'ok' && r.reason !== 'none_published') recordDomainUnresolved(db, tenantId, l, r.reason === 'robots_disallow' ? 'site_not_readable' : 'site_not_read', today, nowSec)   // only rules that FORBID reading are a refusal; rules that could not be fetched are just an unread site
      // The homepage named the company: the domain is confirmed as the company's own site, whether
      // or not it publishes contacts. Record it so leads link out and later runs skip the search.
      if (r.reason === 'ok' || r.reason === 'none_published') db.prepare('UPDATE leads SET company_domain = ? WHERE id = ?').run(site, l.id)
      if (r.reason === 'ok' || r.reason === 'none_published') { try { db.prepare('DELETE FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = ? AND kind = ?').run(l.id, tenantId, 'sitecrawl', DOMAIN_UNRESOLVED_KIND) } catch { /* note only */ } }
      if (r.reason === 'ok' || r.reason === 'none_published') { try { recordEmailGuesses(db, tenantId, l.id, site, [...(localsBySite.get(site) ?? [])], r.found.filter(f => f.kind === 'person').map(f => f.value), { env: deps.env ?? process.env, homeText: r.homeText, where, seen: [...(seenBySite.get(site)?.values() ?? [])] }) } catch { /* never affects the crawl */ } }
      let n = 0
      // Provenance of the domain choice. One row per (domain, basis), so a later scan that reaches the same domain a weaker way adds a row
      // instead of being swallowed by the first. For link bases source_url is the cited page holding the link; for name_probe it is only the
      // homepage the crawl read, which did not produce the domain. Not counted in n: a domain row is not a contact.
      // The homepage name check is the only
      // identity test, so a probed or link-selected domain is recorded as such and never as verified ownership.
      if (r.reason === 'ok' || r.reason === 'none_published') {
        const basis = basisOf.get(site) ?? 'name_probe'
        addEnrichment(db, tenantId, l.id, { connector: 'sitecrawl', kind: 'domain', value: `${site}|${basis}`, label: domainBasisToken(basis), confidence: null, source_url: basis === 'name_probe' ? `https://${site}/` : (ev?.finalUrl ?? l.source_url).slice(0, 500), source_date: today, retrieved_at: Math.floor((deps.now ?? Date.now()) / 1000) })
      }
      // The identity check passed for this site (name on the homepage, and the place or street agreed or was not contradicted): record it,
      // so the contact sweep and the score can tell this domain from a legacy name guess that only agrees with itself.
      if (r.reason === 'ok' || r.reason === 'none_published') addEnrichment(db, tenantId, l.id, { connector: 'sitecrawl', kind: 'domain_check', value: `${site}|identity_checked`, label: 'identity-check-v2: homepage names the company and the place or address agrees'.slice(0, 200), confidence: null, source_url: `https://${site}/`, source_date: today, retrieved_at: Math.floor((deps.now ?? Date.now()) / 1000) })
      for (const t of r.tech ?? []) {
        const e: Enrichment = { connector: 'sitecrawl', kind: 'tech', value: t.name.slice(0, 254), label: `seen on the company website (${t.where})`.slice(0, 200), confidence: null, source_url: `https://${site}/`, source_date: today, retrieved_at: Math.floor((deps.now ?? Date.now()) / 1000) }
        addEnrichment(db, tenantId, l.id, e); n++
      }
      // #389: this crawl's dated technology observation (what the homepage showed, and whether it could show absence at all), then any
      // change against this tenant's earlier comparable observations of the same domain. Not counted in n; never affects the crawl.
      techBranch(db, tenantId, jobId, l.id, site, r, Math.floor((deps.now ?? Date.now()) / 1000), deps.env)
      // A guessed site passed the name AND location checks, but the evidence never linked it: say so on every contact.
      const guessed = (basisOf.get(site) ?? 'name_probe') === 'name_probe'
      for (const f of r.found) {
        const label = guessed ? `${f.label}; site found by name search and location match, not linked from the source` : f.label
        const e: Enrichment = { connector: 'sitecrawl', kind: f.kind, value: f.value.slice(0, 254), label: label.slice(0, 200), confidence: null, source_url: f.url.slice(0, 500), source_date: today, retrieved_at: Math.floor((deps.now ?? Date.now()) / 1000) }
        addEnrichment(db, tenantId, l.id, e); n++
      }
      audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: site, status: r.reason, results: n })
    }
    // #1122 (review at 01140156): a lead this crawl never picks (its hold is about the event itself: a closed opening, someone else's customer,
    // no event evidence) has no website attempt at all. It says so, instead of showing nothing. Whole-job crawls only; never beside a domain.
    if (!deps.leads && !deps.signal?.aborted) {
      try {
        const picked = new Set(leads.map(l => l.id))
        const rest = db.prepare("SELECT id, source_url, review_reason, confidence FROM leads WHERE scan_job_id = ? AND company <> '' AND company_domain IS NULL AND quarantined_at IS NULL LIMIT 200").all(jobId) as { id: string; source_url: string; review_reason: string | null; confidence: number | null }[]
        const eligible = (x: { review_reason: string | null; confidence: number | null }) => (x.review_reason === null && x.confidence !== null) || ['outside_window_undated', 'quote_unconfirmed', 'blocked_by_site', 'needs_javascript'].includes(x.review_reason ?? '')
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
