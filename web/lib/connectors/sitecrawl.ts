import {contactContext,contextLabel} from '../outreach/contact-context.ts'
import https from 'node:https'
import type Database from 'better-sqlite3'
import robotsParser from 'robots-parser'
import { getDomain } from 'tldts'
import { social } from '@crawlee/utils'
import { lookup as dnsLookup } from 'node:dns/promises'
import { guardedLookup, isPublicIp } from '../scan/fetch-page.ts'
import { audit, addEnrichment, type Enrichment } from './store.ts'
import { detectTech, type TechHit } from './techstack.ts'

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

export const sitecrawlEnabled = (env: Record<string, string | undefined> = process.env) => env.SITECRAWL_ENABLED !== '0'

export type Get = (url: string) => Promise<{ status: number; body: string; finalUrl: string } | null>

// timeoutMs/lookup are injectable for tests only; production callers use the
// defaults. Lookup defaults to the SSRF-guarded resolver (private IPs refused).
export function rawGet(rawUrl: string, hops = 0, timeoutMs = TIMEOUT_MS, lookup: typeof guardedLookup = guardedLookup, signal?: AbortSignal): Promise<{ status: number; body: string; finalUrl: string } | null> {
  return new Promise(resolveRaw => {
    // Absolute per-request timer (the socket timeout below is inactivity-only: a slow drip never trips it).
    let hard: NodeJS.Timeout | undefined
    const resolve = (v: { status: number; body: string; finalUrl: string } | null | Promise<{ status: number; body: string; finalUrl: string } | null>) => { clearTimeout(hard); resolveRaw(v as never) }
    let u: URL
    try { u = new URL(rawUrl) } catch { return resolve(null) }
    if (u.protocol !== 'https:' || u.username || u.password || hops > 2) return resolve(null)
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
      const chunks: Buffer[] = []; let n = 0
      res.on('data', (c: Buffer) => { n += c.length; if (n > MAX_BYTES) { res.destroy(); resolve({ status, body: Buffer.concat(chunks).toString('utf8'), finalUrl: u.toString() }) } else chunks.push(c) })
      res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8'), finalUrl: u.toString() }))
      res.on('error', () => resolve(null))
      res.on('close', () => resolve(null)) // no-op once already settled
    })
    hard = setTimeout(() => { req.destroy(new Error('timeout')); resolve(null) }, timeoutMs)
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
  return async (url: string) => {
    let u: URL; try { u = new URL(url) } catch { return null }
    if (u.protocol !== 'https:' || !(await hostOk(u.hostname))) return null
    if (u.pathname === '/robots.txt') return rawGet(url) // plain text, no rendering needed
    try {
      const res = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ urls: [url], crawler_config: { type: 'CrawlerRunConfig', params: { check_robots_txt: true, page_timeout: 20000 } } }), signal: AbortSignal.timeout(40_000) })
      if (!res.ok) return null
      const j = (await res.json()) as { results?: { url?: string; html?: string; status_code?: number; success?: boolean; redirected_url?: string }[] }
      const r = j.results?.[0]; if (!r) return null
      const finalUrl = typeof r.redirected_url === 'string' && r.redirected_url.startsWith('https://') ? r.redirected_url : url
      try { if (new URL(finalUrl).hostname.replace(/^www\./, '') !== u.hostname.replace(/^www\./, '')) return null } catch { return null }
      return { status: r.status_code ?? (r.success ? 200 : 0), body: String(r.html ?? '').slice(0, MAX_BYTES), finalUrl }
    } catch { return null }
  }
}
export const defaultGet = (env: Record<string, string | undefined> = process.env): Get => (env.CRAWL4AI_URL ? crawl4aiGet(env.CRAWL4AI_URL) : rawGet)

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
const labelMatches = (label: string, want: string) => label.length >= 4 && (label === want || (want.startsWith(label) && label.length >= 6) || (label.startsWith(want) && want.length >= 6))

// Candidate company websites, strongest first. All come from evidence we already hold, never from guessing:
// (1) the evidence page is itself on the company's domain; (2) a link on it whose domain name matches the company;
// (3) a link whose visible text names the company. The crawl then checks the homepage really names the company.
export function findCompanySites(company: string, evidenceHtml: string, evidenceUrl: string): string[] {
  const want = norm(company); if (want.length < 4) return []
  let base: URL; try { base = new URL(evidenceUrl) } catch { return [] }
  const own = registrable(base.hostname)
  const out: string[] = []
  const push = (h: string) => { if (!out.includes(h)) out.push(h) }
  if (!SOCIAL.test(own) && labelMatches(nameLabel(base.hostname), want)) push(own)
  const byText: string[] = []
  for (const m of evidenceHtml.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    let u: URL; try { u = new URL(m[1].replace(/&amp;/g, '&'), base) } catch { continue }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue
    const host = registrable(u.hostname)
    if (host === own || SOCIAL.test(host)) continue
    if (labelMatches(nameLabel(host), want)) push(host)
    else if (norm(m[2].replace(/<[^>]+>/g, ' ')).includes(want) && want.length >= 5) byText.push(host)
  }
  for (const h of byText) push(h)
  return out.slice(0, 2)
}
export const findCompanySite = (company: string, html: string, url: string) => findCompanySites(company, html, url)[0] ?? null

// When the evidence page does not link the company's site (aggregator/news evidence), probe the
// obvious domains built from the company name. A probed domain is never trusted on its own: the
// crawl still fetches the homepage and rejects it unless the company is named there (name_mismatch),
// and robots.txt stays a hard rule. Key-free; no search API involved.
export function probeDomains(company: string): string[] {
  const want = norm(company)
  if (want.length < 4 || want.length > 30) return []
  const out = [`${want}.com`, `${want}.ai`, `${want}.io`, `${want}.co`]
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
const ROLE = /^(info|hello|hi|contact|contactus|enquiries|enquiry|inquiries|inquiry|sales|business|office|admin|general|mail|team|support|help|press|media|partnerships|partners|bookings|booking|reservations|hola|contacto|kontakt|bonjour|ciao|ola|connect)$/i
const EMAIL = /\b([a-z0-9][a-z0-9._%+-]{0,63})@([a-z0-9][a-z0-9.-]{0,251}\.[a-z]{2,24})\b/gi
const sameSite = (emailDomain: string, site: string) => { const a = emailDomain.toLowerCase(); return a === site || a.endsWith('.' + site) }

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
//  - JSON-LD Person counts only under employee/founder/member and never inside review/author/comment nodes.
const T = '(?:founder|co-?founder|owner|co-?owner|ceo|president|principal|proprietor|managing director|general manager|director|managing partner|partner|practice manager|office manager|broker|dentist|doctor)'
const TITLE_FULL = new RegExp(`^${T}(?: (?:&|and) ${T})?$`, 'i')
const PEOPLE_PAGE = /(about|team|leadership|people|staff|our-story|who-we-are|meet|contact|company|owner|doctor|dentist)/i
const NAME_LINE = /^(?:(?:Dr|Mr|Ms|Mrs)\.?\s+)?[A-Z][a-z'\u2019-]{1,20}(?:\s+[A-Z]\.?)?\s+[A-Z][A-Za-z'\u2019-]{2,24}$/ // both names 3+ letters: two-letter surnames (Li, Ng) are skipped on purpose, "Us" in "Contact Us" is not a surname
// Remove balanced elements whose tag or class/id marks quoted third-party content.
function cutBlocks(html: string): string {
  let out = html.replace(/<(blockquote|cite|q)\b[\s\S]*?<\/\1>/gi, ' ')
  const open = /<(div|section|article|ul|ol|li|aside|figure)\b[^>]*\b(?:class|id)\s*=\s*["'][^"']*(?:testimonial|review|quote|client|customer|partner|sponsor|press|award)[^"']*["'][^>]*>/i
  for (let guard = 0; guard < 50; guard++) {
    const m = open.exec(out); if (!m) break
    const tag = m[1].toLowerCase(); const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi'); re.lastIndex = m.index + m[0].length
    let depth = 1, end = out.length, t: RegExpExecArray | null
    while ((t = re.exec(out))) { depth += t[1] ? -1 : 1; if (depth === 0) { end = t.index + t[0].length; break } }
    out = out.slice(0, m.index) + ' ' + out.slice(end)
  }
  return out
}
function jsonLdPeople(html: string): { name: string; title: string }[] {
  const out: { name: string; title: string }[] = []
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let root: unknown; try { root = JSON.parse(m[1]) } catch { continue }
    const stack: { node: unknown; ok: boolean }[] = [{ node: root, ok: false }]
    while (stack.length) {
      const { node, ok } = stack.pop()!
      if (!node || typeof node !== 'object') continue
      if (Array.isArray(node)) { for (const n of node) stack.push({ node: n, ok }); continue }
      const rec = node as Record<string, unknown>
      const types = ([] as unknown[]).concat(rec['@type'] ?? []).map(String)
      if (types.includes('Person') && ok && typeof rec.name === 'string' && typeof rec.jobTitle === 'string') out.push({ name: rec.name.trim(), title: rec.jobTitle.trim() })
      for (const [k, v] of Object.entries(rec)) {
        if (!v || typeof v !== 'object') continue
        if (/^(review|reviews|author|creator|comment|reviewRating|editor|contributor|publisher)$/i.test(k)) continue
        stack.push({ node: v, ok: ok || /^(employee|employees|founder|founders|member|members)$/i.test(k) })
      }
    }
  }
  return out
}
export function extractPeople(html: string, pageUrl: string): Found[] {
  const found = new Map<string, Found>()
  let path = ''; try { path = new URL(pageUrl).pathname } catch { return [] }
  const clean = cutBlocks(html)
  const visible = clean.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
  const linkText = new Set([...visible.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()))
  const text = visible.replace(/<\/?(p|div|li|ul|ol|h[1-6]|br|section|article|tr|td|th|figure|figcaption|header|footer|span|strong|b|em)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, "'").replace(/&nbsp;/g, ' ')
  const lines = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const body = lines.join(' ')
  const lowerWords = new Set(body.match(/\b[a-z][a-z'\u2019-]{1,}\b/g) ?? [])
  const add = (name: string, title: string, viaJson = false) => {
    name = name.replace(/\s+/g, ' ').trim(); title = title.replace(/\s+/g, ' ').trim()
    if (!NAME_LINE.test(name) || !TITLE_FULL.test(title)) return
    if (!viaJson) {
      if (!PEOPLE_PAGE.test(path)) return
      if (lowerWords.size < 15) return // no prose on the page: nothing to judge a name-shaped phrase against, fail closed
      if (linkText.has(name.toLowerCase())) return
      if (name.replace(/^(Dr|Mr|Ms|Mrs)\.?\s+/, '').split(/\s+/).some(w => lowerWords.has(w.toLowerCase().replace(/\.$/, '')))) return
    }
    if (!found.has(name.toLowerCase())) found.set(name.toLowerCase(), { kind: 'person', value: `${name}, ${title}`.slice(0, 120), label: 'listed with this title on this company page, not verified as current staff', url: pageUrl })
  }
  for (const p of jsonLdPeople(clean)) add(p.name, p.title, true)
  for (let i = 0; i < lines.length; i++) {
    const same = /^([^,\u2013\u2014|]{3,45}?)\s*(?:,|\u2013|\u2014|-|\|)\s*([^,\u2013\u2014|]{3,40})$/.exec(lines[i])
    if (same) add(same[1], same[2])
    if (i + 1 < lines.length && lines[i].length < 45 && lines[i + 1].length < 45) add(lines[i], lines[i + 1])
  }
  return [...found.values()].slice(0, 3)
}

const PAGE_HINT = /(contact|about|impressum|kontakt|contacto|contato|nous-contacter|contactez|chi-siamo|company|team|reach)/i
export function contactPaths(homeHtml: string, home: URL): string[] {
  const set = new Set<string>(['/contact', '/contact-us', '/about'])
  for (const m of homeHtml.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi)) {
    let u: URL; try { u = new URL(m[1].replace(/&amp;/g, '&'), home) } catch { continue }
    if (u.protocol !== 'https:' || u.hostname.replace(/^www\./, '') !== home.hostname.replace(/^www\./, '')) continue
    if (PAGE_HINT.test(u.pathname) && u.pathname.length < 60 && !/\.(pdf|jpg|png|zip)$/i.test(u.pathname) && !u.search) set.add(u.pathname)
  }
  return [...set].slice(0, 8)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
// Abort-aware sleep: resolves early (to false) when the signal fires, so the
// polite per-host gap does not outlive a post-processing deadline.
const sleepAbort = (ms: number, signal?: AbortSignal) => new Promise<boolean>((resolve) => {
  if (signal?.aborted) return resolve(false)
  const t = setTimeout(() => resolve(true), ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(false) }, { once: true })
})
const lastHit = new Map<string, number>()

export async function crawlSite(site: string, get: Get = rawGet, gapMs = GAP_MS, expectName?: string, social = false, signal?: AbortSignal): Promise<{ found: Found[]; reason: string; pages: number; tech?: TechHit[] }> {
  const origin = `https://${site}`
  const stopped = () => signal?.aborted ?? false
  const polite = async (url: string, delay: number) => { const h = new URL(url).hostname; const wait = (lastHit.get(h) ?? 0) + Math.max(gapMs, delay) - Date.now(); if (wait > 0 && !(await sleepAbort(wait, signal))) return null; lastHit.set(h, Date.now()); return get(url) }
  const rob = await polite(`${origin}/robots.txt`, 0)
  let robots: Robots
  if (!rob) return { found: [], reason: 'robots_unreachable', pages: 0 }
  if (rob.status >= 500) return { found: [], reason: 'robots_error', pages: 0 }
  robots = rob.status >= 400 ? { allows: () => true, delayMs: 0 } : parseRobots(rob.body, site)
  if (!robots.allows('/')) return { found: [], reason: 'robots_disallow', pages: 0 }
  const home = await polite(`${origin}/`, robots.delayMs)
  if (!home || home.status >= 400) return { found: [], reason: 'site_unreachable', pages: 0 }
  if (expectName && !norm(home.body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).includes(norm(expectName))) return { found: [], reason: 'name_mismatch', pages: 1 }
  const found = new Map<string, Found>(); let pages = 1
  for (const f of [...extractContacts(home.body, home.finalUrl, site), ...extractPeople(home.body, home.finalUrl)]) found.set(f.kind + f.value, f)
  for (const p of contactPaths(home.body, new URL(home.finalUrl))) {
    if (stopped()) break
    if (pages >= MAX_PAGES) break
    if (!robots.allows(p)) continue
    const r = await polite(origin + p, robots.delayMs)
    if (!r || r.status >= 400) continue
    pages++
    for (const f of [...extractContacts(r.body, r.finalUrl, site), ...extractPeople(r.body, r.finalUrl)]) if (!found.has(f.kind + f.value)) found.set(f.kind + f.value, f)
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
  return { found: [...contacts.slice(0, 6), ...people.slice(0, 3)], reason: contacts.length ? 'ok' : 'none_published', pages, tech: detectTech(home.body) }
}

// Runs for one finished scan. Never throws, never touches the lead row, one audit row per site.
// deps.leads overrides the lead selection (commenter import: imported rows carry no
// confidence); deps.skipEvidenceFetch skips fetching the lead's source_url (commenter
// import again: the URL is stored provenance that must never be fetched - the crawl
// goes straight to name-derived domain probing, confirmed by the homepage name check).
export async function crawlJob(db: Database.Database, tenantId: string, jobId: string, deps: { get?: Get; gapMs?: number; env?: Record<string, string | undefined>; now?: number; leads?: { id: string; company: string; source_url: string }[]; skipEvidenceFetch?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  try {
    if (!sitecrawlEnabled(deps.env)) return
    // Signal threads only into the rawGet path; a crawl4ai backend keeps its
    // own 40s per-call bound (outer deadline does not reach it yet - tracked).
    const get = deps.get ?? (deps.signal && !deps.env?.CRAWL4AI_URL && !process.env.CRAWL4AI_URL
      ? (url: string) => rawGet(url, 0, TIMEOUT_MS, guardedLookup, deps.signal)
      : defaultGet(deps.env))
    const leads = deps.leads ?? db.prepare("SELECT id, company, source_url FROM leads WHERE scan_job_id = ? AND review_reason IS NULL AND confidence IS NOT NULL AND company <> '' ORDER BY score DESC LIMIT ?").all(jobId, MAX_SITES_PER_SCAN) as { id: string; company: string; source_url: string }[]
    const today = new Date((deps.now ?? Date.now())).toISOString().slice(0, 10)
    const done = new Set<string>()
    let probed = 0
    for (const l of leads) {
      if (deps.signal?.aborted) return // post-processing deadline: stop starting new sites
      const ev = deps.skipEvidenceFetch ? null : await get(l.source_url)
      let sites = ev ? findCompanySites(l.company, ev.body, ev.finalUrl) : []
      if (sites.length === 0) {
        // Evidence page does not link the company site: probe name-derived domains. Wrong guesses
        // are rejected by the homepage name check inside crawlSite.
        if (probed >= MAX_PROBES_PER_SCAN) { audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: l.company, status: 'no_site_linked', results: 0 }); continue }
        probed++
        sites = probeDomains(l.company).filter(d => !done.has(d))
        if (sites.length === 0) { audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: l.company, status: 'no_site_linked', results: 0 }); continue }
      }
      let r: Awaited<ReturnType<typeof crawlSite>> = { found: [], reason: 'name_mismatch', pages: 0 }; let site = sites[0]
      for (const cand of sites) {
        if (done.has(cand)) continue
        done.add(cand); site = cand
        r = await crawlSite(cand, get, deps.gapMs, l.company, (deps.env ?? process.env).SITECRAWL_SOCIAL === '1', deps.signal)
        if (r.reason !== 'name_mismatch' && r.reason !== 'site_unreachable') break
        audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: cand, status: r.reason, results: 0 })
      }
      // A deadline that fired during this crawl leaves a partial read: record nothing (no domain, tech, contacts or audit row) rather than a result that looks complete.
      if (deps.signal?.aborted) return
      if (r.reason === 'name_mismatch' || r.reason === 'site_unreachable') continue
      // The homepage named the company: the domain is confirmed as the company's own site, whether
      // or not it publishes contacts. Record it so leads link out and later runs skip the search.
      if (r.reason === 'ok' || r.reason === 'none_published') db.prepare('UPDATE leads SET company_domain = ? WHERE id = ?').run(site, l.id)
      let n = 0
      for (const t of r.tech ?? []) {
        const e: Enrichment = { connector: 'sitecrawl', kind: 'tech', value: t.name.slice(0, 254), label: `seen on the company website (${t.where})`.slice(0, 200), confidence: null, source_url: `https://${site}/`, source_date: today, retrieved_at: Math.floor((deps.now ?? Date.now()) / 1000) }
        addEnrichment(db, tenantId, l.id, e); n++
      }
      for (const f of r.found) {
        const e: Enrichment = { connector: 'sitecrawl', kind: f.kind, value: f.value.slice(0, 254), label: f.label, confidence: null, source_url: f.url.slice(0, 500), source_date: today, retrieved_at: Math.floor((deps.now ?? Date.now()) / 1000) }
        addEnrichment(db, tenantId, l.id, e); n++
      }
      audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: site, status: r.reason, results: n })
    }
  } catch (e) {
    console.error('sitecrawl failed', jobId, e instanceof Error ? e.message : 'error')
  }
}
