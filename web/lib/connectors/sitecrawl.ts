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
import { emailGuessEnabled, personalLocals, recordEmailGuesses } from '../people/email-pattern.ts'
import { roleContradicted, titleMatches } from '../people/rank.ts'
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
export type DomainBasis = 'evidence_own_domain' | 'evidence_link_domain_label' | 'evidence_link_text' | 'name_probe'
export function findCompanySitesWithBasis(company: string, evidenceHtml: string, evidenceUrl: string): { site: string; basis: DomainBasis }[] {
  const want = norm(company); if (want.length < 4) return []
  let base: URL; try { base = new URL(evidenceUrl) } catch { return [] }
  const own = registrable(base.hostname)
  const out: { site: string; basis: DomainBasis }[] = []
  const push = (site: string, basis: DomainBasis) => { if (!out.some(o => o.site === site)) out.push({ site, basis }) }
  if (!SOCIAL.test(own) && labelMatches(nameLabel(base.hostname), want)) push(own, 'evidence_own_domain')
  const byText: string[] = []
  for (const m of evidenceHtml.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    let u: URL; try { u = new URL(m[1].replace(/&amp;/g, '&'), base) } catch { continue }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue
    const host = registrable(u.hostname)
    if (host === own || SOCIAL.test(host)) continue
    if (labelMatches(nameLabel(host), want)) push(host, 'evidence_link_domain_label')
    else if (norm(m[2].replace(/<[^>]+>/g, ' ')).includes(want) && want.length >= 5) byText.push(host)
  }
  for (const h of byText) push(h, 'evidence_link_text')
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
export const ROLE = /^(info|hello|hi|contact|contactus|enquiries|enquiry|inquiries|inquiry|sales|business|office|admin|general|mail|team|support|help|press|media|partnerships|partners|bookings|booking|reservations|hola|contacto|kontakt|bonjour|ciao|ola|connect)$/i
const EMAIL = /\b([a-z0-9][a-z0-9._%+-]{0,63})@([a-z0-9][a-z0-9.-]{0,251}\.[a-z]{2,24})\b/gi
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
const T = `(?:founder|co-?founder|owner|co-?owner|ceo|president|principal|proprietor|managing director|general manager|director|managing partner|partner|practice manager|office manager|broker|dentist|doctor|${EXEC})`
const TITLE_FULL = new RegExp(`^${T}(?: (?:&|and) ${T})?$`, 'i')
const PEOPLE_PAGE = /(about|team|leadership|people|staff|our-story|who-we-are|meet|contact|company|owner|doctor|dentist)/i
const NAME_LINE = /^(?:(?:Dr|Mr|Ms|Mrs)\.?\s+)?[A-Z][a-z'\u2019-]{1,20}(?:\s+[A-Z]\.?)?\s+[A-Z][A-Za-z'\u2019-]{2,24}$/ // both names 3+ letters: two-letter surnames (Li, Ng) are skipped on purpose, "Us" in "Contact Us" is not a surname
// Remove balanced elements whose tag (blockquote/cite/q) or class/id (any element) marks quoted third-party content.
// Returns null when a marked region is malformed (never closed): the page is then not judged at all.
const MARK = '(?:testimonial|review|quote|client|customer|partner|sponsor|press|award|feedback|rating)'
function cutBlocks(html: string): string | null {
  let out = html
  const open = new RegExp(`<(blockquote|cite|q)\\b[^>]*>|<([a-z][a-z0-9]*)\\b[^>]*\\b(?:class|id)\\s*=\\s*["'][^"']*${MARK}[^"']*["'][^>]*>`, 'i')
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
export function extractPeople(html: string, pageUrl: string, buyerRoles?: string): Found[] {
  const found = new Map<string, Found>()
  let path = ''; try { path = new URL(pageUrl).pathname } catch { return [] }
  const clean = cutBlocks(html)
  if (clean === null) return [] // a quoted/testimonial region that never closes cannot be separated from the page: fail closed
  const visible = clean.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
  const linkText = new Set([...visible.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()))
  const text = visible.replace(/<\/?(p|div|li|ul|ol|h[1-6]|br|section|article|tr|td|th|figure|figcaption|header|footer|span|strong|b|em)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, "'").replace(/&nbsp;/g, ' ')
  const lines = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
  // Email addresses are not prose: their lower-case local parts (dana.lee@...) would otherwise reject the very person
  // listed beside them, so they are removed before the lower-case word test.
  const body = lines.join(' ').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ' ')
  const lowerWords = new Set(body.match(/\b[a-z][a-z'\u2019-]{1,}\b/g) ?? [])
  const add = (name: string, title: string, viaJson = false) => {
    name = name.replace(/\s+/g, ' ').trim(); title = title.replace(/\s+/g, ' ').trim()
    if (!NAME_LINE.test(name) || !(TITLE_FULL.test(title) || buyerTitle(title, buyerRoles))) return
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

const PAGE_HINT = /(contact|about|impressum|kontakt|contacto|contato|nous-contacter|contactez|chi-siamo|company|team|leadership|management|people|reach|locations?|careers?|our-practice|meet-the|providers|doctors|staff)/i
export function contactPaths(homeHtml: string, home: URL): string[] {
  const set = new Set<string>(['/contact', '/contact-us', '/about', '/team', '/leadership'])
  for (const m of homeHtml.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi)) {
    let u: URL; try { u = new URL(m[1].replace(/&amp;/g, '&'), home) } catch { continue }
    if (u.protocol !== 'https:' || u.hostname.replace(/^www\./, '') !== home.hostname.replace(/^www\./, '')) continue
    if (PAGE_HINT.test(u.pathname) && u.pathname.length < 60 && !/\.(pdf|jpg|png|zip)$/i.test(u.pathname) && !u.search) set.add(u.pathname)
  }
  for (const extra of ['/locations', '/our-team', '/careers']) set.add(extra) // after the page's own links: same cap, never ahead of them
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

// onPage (optional) sees the raw HTML of every own-site page read; used only by the email finder (EMAIL_GUESS_ENABLED).
// buyerRoles (optional): the scan ICP's "who" roles. Listed people whose title shares ICP words are kept first, so for a
// payroll seller "Head of HR" is not crowded out by a CTO; seniority breaks ties. Without it, seniority only (as before).
export async function crawlSite(site: string, get: Get = rawGet, gapMs = GAP_MS, expectName?: string, social = false, signal?: AbortSignal, onPage?: (html: string) => void, buyerRoles?: string): Promise<{ found: Found[]; reason: string; pages: number; tech?: TechHit[]; homeNorm?: string; homeText?: string }> {
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
  // The normalised homepage text is returned so a later lead on the same domain is checked against it without a second fetch.
  const homePlain = home.body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
  const homeNorm = norm(homePlain)
  // Case-preserved text (capped) for the place-agreement check: an address like "Rome, NY 13440" needs its capitals.
  const homeText = homePlain.replace(/\s+/g, ' ').trim().slice(0, 30_000)
  if (expectName && !homeNorm.includes(norm(expectName))) return { found: [], reason: 'name_mismatch', pages: 1, homeNorm, homeText }
  const found = new Map<string, Found>(); let pages = 1
  onPage?.(home.body)
  for (const f of [...extractContacts(home.body, home.finalUrl, site), ...extractPeople(home.body, home.finalUrl, buyerRoles)]) found.set(f.kind + f.value, f)
  for (const p of contactPaths(home.body, new URL(home.finalUrl))) {
    if (stopped()) break
    if (pages >= MAX_PAGES) break
    if (!robots.allows(p)) continue
    const r = await polite(origin + p, robots.delayMs)
    if (!r || r.status >= 400) continue
    pages++
    onPage?.(r.body)
    for (const f of [...extractContacts(r.body, r.finalUrl, site), ...extractPeople(r.body, r.finalUrl, buyerRoles)]) if (!found.has(f.kind + f.value)) found.set(f.kind + f.value, f)
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
  return { found: [...contacts.slice(0, 6), ...people.sort(buyerRoles ? byBuyerThenSeniority(buyerRoles) : bySeniority).slice(0, 3)], reason: contacts.length ? 'ok' : 'none_published', pages, tech: detectTech(home.body), homeNorm, homeText }
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

export async function crawlJob(db: Database.Database, tenantId: string, jobId: string, deps: { get?: Get; gapMs?: number; env?: Record<string, string | undefined>; now?: number; leads?: { id: string; company: string; source_url: string; review_reason?: string | null; signal?: string | null; evidence_excerpt?: string | null }[]; skipEvidenceFetch?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  try {
    if (!sitecrawlEnabled(deps.env)) return
    // Signal threads only into the rawGet path; a crawl4ai backend keeps its
    // own 40s per-call bound (outer deadline does not reach it yet - tracked).
    const get = deps.get ?? (deps.signal && !deps.env?.CRAWL4AI_URL && !process.env.CRAWL4AI_URL
      ? (url: string) => rawGet(url, 0, TIMEOUT_MS, guardedLookup, deps.signal)
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
    const guessing = emailGuessEnabled(deps.env ?? process.env)
    const localsBySite = new Map<string, Set<string>>()
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
      const r = await crawlSite(cand, get, deps.gapMs, company, (deps.env ?? process.env).SITECRAWL_SOCIAL === '1', deps.signal, guessing ? html => { for (const l of personalLocals(html, cand)) locals.add(l) } : undefined, buyerRoles)
      siteRead.set(cand, r)
      return r
    }
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
      let sites: string[] = []
      if (ev) for (const o of findCompanySitesWithBasis(l.company, ev.body, ev.finalUrl)) { sites.push(o.site); basisOf.set(o.site, o.basis) }
      if (sites.length === 0) {
        // Evidence page does not link the company site: probe name-derived domains. Wrong guesses
        // are rejected by the homepage name check inside crawlSite.
        if (probed >= MAX_PROBES_PER_SCAN) { audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: l.company, status: 'no_site_linked', results: 0 }); continue }
        probed++
        sites = probeDomains(l.company)
        for (const d of sites) basisOf.set(d, 'name_probe')
        if (blockedHost) { const kept = sites.filter(notBlockedHost); if (kept.length !== sites.length) audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: blockedHost, status: 'skipped_site_refused_us', results: 0 }); sites = kept }
        if (sites.length === 0) { audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: l.company, status: 'no_site_linked', results: 0 }); continue }
      }
      let r: Awaited<ReturnType<typeof crawlSite>> = { found: [], reason: 'name_mismatch', pages: 0 }; let site = sites[0]
      // Places this lead is about: the scan geography plus places its own evidence names (signal, quote, cited page).
      const places = placeTerms(where, [l.signal ?? '', l.evidence_excerpt ?? '', ev?.body ? ev.body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ') : ''].join(' '), l.company)
      for (const cand of sites) {
        site = cand
        r = await readSite(cand, l.company)
        if (r.reason !== 'name_mismatch' && r.reason !== 'site_unreachable' && ((basisOf.get(cand) === 'name_probe' && !probeLocationAgrees(r.homeText, where, l, { homeNorm: r.homeNorm, places })) || (basisOf.get(cand) !== 'name_probe' && basisOf.get(cand) !== 'evidence_own_domain' && places.length > 0 && !placeConsistent(r.homeNorm, places)))) {
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
        if (r.reason !== 'name_mismatch' && r.reason !== 'site_unreachable' && basisOf.get(cand) !== 'evidence_own_domain' && addressAgreement(r.homeText, `${l.evidence_excerpt ?? ''} ${l.signal ?? ''}`) === 'conflict') {
          const reason = `contact rejected: address mismatch ${(streetKeys(r.homeText)[0] ?? 'another address')} vs ${(streetKeys(`${l.evidence_excerpt ?? ''} ${l.signal ?? ''}`)[0] ?? 'the lead\'s address')}`.slice(0, 180)
          audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: cand, status: reason, results: 0 })
          if (r.homeText) recordContactRejection(db, tenantId, l.id, { connector: 'sitecrawl', reason, sourceUrl: `https://${cand}/` })
          r = { found: [], reason: 'name_mismatch', pages: 0 }
          continue
        }
        if (r.reason !== 'name_mismatch' && r.reason !== 'site_unreachable' && where.length > 0 && basisOf.get(cand) !== 'evidence_own_domain') {
          const v = r.homeText ? placeAgreement(r.homeText, where, l.company) : 'unconfirmed'
          if (v === 'mismatch' || (r.homeText && ownAddressElsewhere(r.homeText, where)) || (v !== 'agrees' && v !== 'no_geography' && cityScoped(where) && basisOf.get(cand) === 'name_probe')) {
            // Reason in plain words, e.g. "contact rejected: location mismatch Pico Rivera, CA vs New York, NY".
            audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: cand, status: `contact rejected: location ${v === 'mismatch' ? 'mismatch' : 'unconfirmed'} ${firstPlaceLabel(r.homeText ?? '') ?? 'another place'} vs ${leadPlaceLabel(where)}`.slice(0, 180), results: 0 })
            if (r.homeText) recordContactRejection(db, tenantId, l.id, { connector: 'sitecrawl', reason: (`contact rejected: location ${v === 'mismatch' ? 'mismatch' : 'unconfirmed'} ${firstPlaceLabel(r.homeText ?? '') ?? 'another place'} vs ${leadPlaceLabel(where)}`.slice(0, 180)).slice(0, 180), sourceUrl: `https://${cand}/` })
            r = { found: [], reason: 'name_mismatch', pages: 0 }
            continue
          }
        }
        if (r.reason !== 'name_mismatch' && r.reason !== 'site_unreachable') break
        audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: cand, status: r.reason, results: 0 })
      }
      // A deadline that fired during this crawl leaves a partial read: record nothing (no domain, tech, contacts or audit row) rather than a result that looks complete.
      if (deps.signal?.aborted) return
      if (r.reason === 'name_mismatch' || r.reason === 'site_unreachable') continue
      // The homepage named the company: the domain is confirmed as the company's own site, whether
      // or not it publishes contacts. Record it so leads link out and later runs skip the search.
      if (r.reason === 'ok' || r.reason === 'none_published') db.prepare('UPDATE leads SET company_domain = ? WHERE id = ?').run(site, l.id)
      if (guessing && (r.reason === 'ok' || r.reason === 'none_published')) { try { recordEmailGuesses(db, tenantId, l.id, site, [...(localsBySite.get(site) ?? [])], r.found.filter(f => f.kind === 'person').map(f => f.value)) } catch { /* never affects the crawl */ } }
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
      // A guessed site passed the name AND location checks, but the evidence never linked it: say so on every contact.
      const guessed = (basisOf.get(site) ?? 'name_probe') === 'name_probe'
      for (const f of r.found) {
        const label = guessed ? `${f.label}; site found by name search and location match, not linked from the source` : f.label
        const e: Enrichment = { connector: 'sitecrawl', kind: f.kind, value: f.value.slice(0, 254), label: label.slice(0, 200), confidence: null, source_url: f.url.slice(0, 500), source_date: today, retrieved_at: Math.floor((deps.now ?? Date.now()) / 1000) }
        addEnrichment(db, tenantId, l.id, e); n++
      }
      audit(db, { tenantId, connector: 'sitecrawl', jobId, lookup: site, status: r.reason, results: n })
    }
  } catch (e) {
    console.error('sitecrawl failed', jobId, e instanceof Error ? e.message : 'error')
  }
}
