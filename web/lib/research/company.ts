// Research engine, part G (MISSION v2; LEAD_ENGINE=research): ResearchEvent -> CompanyResearch. A port of the prototype's
// stage 6 (~/work/proto/ai-research/pipeline.py find_site + research, lib.py fetch / norm / quote_in), which found a named
// decision-maker for most companies and invented no name in 67 hand-checked leads.
//   1. the company's own site: the event page itself when it is the company's site, else the site the page shows, else one search
//      "<company> <city> official website" whose result host carries the company's name (directories and unopenable hosts skipped);
//   2. its pages: the event page, the homepage, and up to four of its own about / team / people / leadership / contact / imprint pages;
//   3. person searches (owner / founder / CEO / the plan's titles / "who owns"), result snippets kept as sources and up to two result
//      pages opened when they name the company;
//   4. ONE model call picks the decision-maker with a VERBATIM quote naming the person AND their role, from a cited source; a second
//      look (a person the trigger article itself names, else the question asked plainly) only for the misses;
//   5. the quote must be literally in the cited source's text, or there is no person: the model is never trusted to have copied it;
//   6. emails: addresses printed on the company's OWN pages (its domain), with the page; never a guess. The named person's own address
//      first, then the company's inboxes; recruiting and no-reply inboxes are not contacts. Cloudflare-protected addresses are decoded.
// The found site must be THIS business (#1122, Hermes 02:15: the Vancouver restaurant Fable resolved to a books app's site): its own pages
// must show the case's place (a place word, or a country domain) AND its category (a business-type word). No match -> no site and no
// person: a person found for the wrong company is worse than none. The next candidate site is tried before giving up.
// Every network call and the model are injected (CompanyDeps), so tests run on recorded pages and the scan wires the real ones
// (TinyFish search through lib/search/tinyfish.ts, the guarded direct fetch of lib/connectors/sitecrawl.ts, the job's provider).
import type { CompanyResearch, Person, ResearchCase, ResearchEvent, ResearchPlan, Source } from './types.ts'
import type { SearchFn } from './hunt.ts'

export interface SearchResult { url: string; title: string; snippet: string }
export interface Fetched { status: number; body: string; finalUrl: string }
export interface CompanyDeps {
  search: (query: string) => Promise<SearchResult[]>
  get: (url: string) => Promise<Fetched | null>                    // raw HTML, direct (free); null = could not open
  complete: (prompt: string, maxTokens: number) => Promise<string | null>   // the model's text answer; null = no answer
  // a spend refusal (the scan's cap, SpendRefused) is never swallowed here: it stops the scan (the engine's own rule)
  isRefusal?: (e: unknown) => boolean
}

// Hosts a direct fetch cannot open or that are never a company's own site (the prototype's BLOCKED + DIRECTORY lists).
const BLOCKED = ['linkedin.com', 'indeed.com', 'glassdoor.', 'ziprecruiter.com', 'x.com', 'twitter.com', 'tiktok.com', 'youtube.com', 'simplyhired', 'jooble', 'talent.com', 'yelp.', 'jobleads', 'bebee.com', 'monster.com']
const DIRECTORY = ['facebook.com', 'instagram.com', 'yellowpages', 'bbb.org', 'mapquest', 'tripadvisor', 'zoominfo', 'crunchbase', 'bloomberg.com', 'dnb.com', 'wikipedia.org', 'opencorporates', 'manta.com', 'chamberofcommerce', 'yelp.', 'angi.com', 'houzz.com', 'thumbtack', 'nextdoor', 'google.com', 'apple.com', 'bing.com', 'superpages', 'justia.com', 'avvo.com', 'martindale', 'lawyers.com', 'findlaw', 'healthgrades', 'zocdoc', 'ratemds', 'opentable', 'ubereats', 'doordash', 'theorg.com', 'rocketreach', 'apollo.io', 'signalhire', 'clutch.co', 'g2.com']
const LINK_RX = /about|team|people|staff|leadership|founder|our-story|story|contact|impressum|imprint|attorney|lawyer|professional|doctor|dentist|meet|management|ber-uns|kontakt|who-we-are|partners/i
const FIRST_RX = /team|people|leadership|about|attorney|impressum|doctor|founder/i
const EMAIL_RX = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}/g
const NOT_EMAIL = /\.(png|jpe?g|gif|webp|svg)$|sentry|wixpress|example\.|@2x/i
const SENIOR = /\b(?:founder|ceo|owner|partner|president|chief|director|managing|gesch.ftsf.hr|principal|head|chair|gr.nder|inhaber|dentist|dr\.?\b|chef|proprietor|vorstand)\b/i
const STOP_TOKENS = new Set(['the', 'and', 'inc', 'llc', 'llp', 'ltd', 'gmbh', 'group', 'company', 'pvt', 'limited', 'law', 'dental', 'roofing'])
export const PAGE_TEXT = 3500, TEAM_TEXT = 5000, RESULT_TEXT = 3000, SNIPPET_TEXT = 500, PROMPT_SOURCES = 22000, MAX_OWN_PAGES = 4, MAX_RESULT_PAGES = 2

export const host = (u: string): string => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, '') } catch { return '' } }
const blocked = (u: string) => { const h = host(u); return BLOCKED.some(b => h.includes(b)) }
const directory = (h: string) => DIRECTORY.some(d => h.includes(d))
// lib.py norm: lower case, curly quotes and dashes folded, every run of other characters one space
export const norm = (s: string | null | undefined): string => (s ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^a-z0-9äöüß]+/g, ' ').trim()
// lib.py quote_in: the quote, or any 8-word run of it, is literally in the text after norm (tolerates a small edit in a long quote)
export function quoteIn(quote: string | null | undefined, text: string): boolean {
  const q = norm(quote), t = ` ${norm(text)} `
  if (q.length < 12) return false
  if (t.includes(` ${q} `) || t.includes(q)) return true
  const w = q.split(' ')
  if (w.length >= 8) for (let i = 0; i + 8 <= w.length; i++) if (t.includes(` ${w.slice(i, i + 8).join(' ')} `)) return true
  return false
}
export function nameTokens(company: string): string[] {
  const all = norm(company).split(' ').filter(Boolean)
  const t = all.filter(w => w.length > 2 && !STOP_TOKENS.has(w))
  return t.length ? t : all
}

// Cloudflare's email protection prints no address: data-cfemail="<hex>" (or /cdn-cgi/l/email-protection#<hex>); byte 0 is the key, every
// next byte XOR the key is one character. Bounded: 40 per page.
export function cfEmails(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/(?:data-cfemail=["']|\/cdn-cgi\/l\/email-protection#)([0-9a-f]{6,510})/gi)) {
    if (out.length >= 40) break
    const h = m[1]; if (h.length % 2) continue
    const key = parseInt(h.slice(0, 2), 16); let e = ''
    for (let i = 2; i < h.length; i += 2) e += String.fromCharCode(parseInt(h.slice(i, i + 2), 16) ^ key)
    if (/^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,251}\.[a-z]{2,24}$/i.test(e)) out.push(e)
  }
  return out
}

// The page as the research step reads it: visible text (scripts, styles, svg dropped; blocks become lines), its links with their text,
// and its mailto addresses. Pure.
export interface ReadPage { url: string; finalUrl: string; text: string; links: { url: string; text: string }[]; mailtos: string[] }
const decode = (s: string) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;|&#8217;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d{1,6});/g, (_m, d: string) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)))
const MAX_HTML = 400_000
// scripts, styles, svg, templates and comments removed by index scans (linear), never a lazy pattern over the whole page
function stripBlocks(html: string): string {
  let out = '', i = 0
  const low = html.toLowerCase()
  while (i < html.length) {
    const lt = low.indexOf('<', i)
    if (lt < 0) { out += html.slice(i); break }
    out += html.slice(i, lt)
    if (low.startsWith('<!--', lt)) { const e = low.indexOf('-->', lt + 4); i = e < 0 ? html.length : e + 3; out += ' '; continue }
    const m = /^<(script|style|noscript|svg|template)\b/.exec(low.slice(lt, lt + 12))
    if (m) { const e = low.indexOf(`</${m[1]}`, lt + 1); const end = e < 0 ? -1 : low.indexOf('>', e); i = end < 0 ? html.length : end + 1; out += ' '; continue }
    out += '<'; i = lt + 1
  }
  return out
}
// Linear anchor scan (a regex over hostile HTML backtracks badly): each '<a' is looked at within bounded windows, so cost stays O(n).
function anchors(body: string): [string, string, string][] {
  const out: [string, string, string][] = []
  const low = body.toLowerCase()
  let i = 0
  while (out.length < 2000) {
    i = low.indexOf('<a', i)
    if (i < 0) break
    const next = low.charCodeAt(i + 2)
    const start = i
    i += 2
    if (!(next === 32 || next === 9 || next === 10 || next === 13 || next === 47)) continue
    const gt = low.slice(start, start + 1400).indexOf('>') + start
    if (gt < start) continue
    const tag = body.slice(start, gt)
    const hm = /\bhref\s*=\s*(?:"([^"]{1,2000})"|'([^']{1,2000})')/i.exec(tag)
    if (!hm) continue
    const cl = low.slice(gt, gt + 405).indexOf('</a>')
    const end = cl < 0 ? gt + 1 + 400 : gt + cl
    out.push(['', hm[1] ?? hm[2], body.slice(gt + 1, Math.min(end, body.length))])
    i = gt + 1
  }
  return out
}

export function readHtml(html: string, url: string, finalUrl = url): ReadPage {
  // bounded input and bounded patterns: a hostile page (20,000 unclosed "<script ") must not cost seconds of synchronous CPU
  const body = stripBlocks(html.slice(0, MAX_HTML))
  const links: { url: string; text: string }[] = [], mailtos: string[] = [...cfEmails(body)]
  for (const m of anchors(body)) {
    const href = decode(m[1].trim())
    if (/^mailto:/i.test(href)) { mailtos.push(href.slice(7).split('?')[0]); continue }
    let u: string; try { u = new URL(href, finalUrl).toString() } catch { continue }
    if (!/^https?:/i.test(u)) continue
    links.push({ url: u, text: decode(m[2].replace(/<[^>]{1,400}>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 80) })
  }
  const text = decode(body.replace(/<\/?(p|div|li|ul|ol|h[1-6]|br|section|article|tr|td|th|header|footer|nav|figure|figcaption|address|blockquote|dd|dt|table)\b[^>]{0,400}>/gi, '\n').replace(/<[^>]{1,400}>/g, ' '))
    .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
  return { url, finalUrl, text, links: links.slice(0, 600), mailtos: mailtos.slice(0, 60) }
}
async function open(deps: CompanyDeps, url: string): Promise<ReadPage | null> {
  if (blocked(url)) return null
  let r: Fetched | null = null
  try { r = await deps.get(url) } catch { r = null }
  if (!r || r.status !== 200 || !r.body) return null
  const p = readHtml(r.body, url, r.finalUrl || url)
  return p.text.length > 400 ? p : null   // the prototype's floor: a near-empty page (a block page, a JS shell) is not a source
}

// 1. the company's own site, in three stages, cheapest first; researchCompany keeps the first candidate whose own pages match the case
//    a. the site the event page IS or shows (no cost);
//    b. hosts guessed from the company's name and the place's country domain (a free direct fetch each, no search: purebread.ca,
//       passiondental.ca, ybdentistry.com were never in the "official website" search results, which are news about the event);
//    c. one search "<company> <city> official website", only when a and b found no site that matches.
// Every candidate, whatever its stage, must pass the same check (place + category + the homepage names the company), so a guessed host
// that is another business is refused exactly as a searched one (#1122).
export async function findSite(ev: ResearchEvent, city: string, deps: CompanyDeps): Promise<string | null> { return (await siteCandidates(ev, city, deps))[0] ?? null }
const PLACE_WORDS = ['australia', 'canada', 'india', 'germany', 'uk', 'usa', 'america', 'london', 'texas', 'ontario']
const nameOnly = (ev: ResearchEvent, city: string) => nameTokens(ev.company).filter(t => !norm(city).split(' ').includes(t) && !PLACE_WORDS.includes(t))
export function shownSites(ev: ResearchEvent): string[] {
  const out: string[] = []
  const own = ev.pageIsCompanySite && host(ev.sourceUrl) && !blocked(ev.sourceUrl) && !directory(host(ev.sourceUrl)) ? `https://${host(ev.sourceUrl)}` : null
  const w = (ev.website ?? '').trim()
  const shown = w && w.includes('.') && !/\s/.test(w) ? (/^https?:\/\//i.test(w) ? w : `https://${w}`) : null
  for (const u of [own, shown && host(shown) && !blocked(shown) && !directory(shown ? host(shown) : '') ? shown : null]) if (u && !out.some(o => host(o) === host(u))) out.push(u)
  return out
}
// the country domains a place implies, from the case's own keywords (".ca", ".com.au", ".co.uk", ".de", ".in"), then the generic ones
export function guessedSites(ev: ResearchEvent, c: ResearchCase, city: string): string[] {
  const toks = nameOnly(ev, city); if (!toks.length) return []
  const slugs = [...new Set([toks.join(''), toks.join('-'), norm(ev.company).split(' ').filter(w => w.length > 1 && !STOP_TOKENS.has(w)).join('')].filter(x => x.length >= 4 && x.length <= 40))].slice(0, 2)
  const cc = (c.whereKeywords ?? []).filter(k => /^\.[a-z.]{2,8}$/.test(k) && k !== '.com')
  const tlds = [...new Set([...cc, '.com', '.co', '.io'])].slice(0, 4)
  const out: string[] = []
  for (const sl of slugs) for (const t of tlds) { const h = `${sl}${t}`; if (!directory(h) && !out.includes(`https://${h}`)) out.push(`https://${h}`) }
  return out.slice(0, 6)
}
async function searchedSites(ev: ResearchEvent, city: string, deps: CompanyDeps, skip: string[]): Promise<string[]> {
  const toks = nameOnly(ev, city)
  let rs: SearchResult[] = []
  try { rs = await deps.search(`${ev.company} ${city} official website`) } catch (e) { if (deps.isRefusal?.(e)) throw e; rs = [] }
  const out: string[] = []
  let best: string | null = null
  for (const r of rs.slice(0, 8)) {
    const h = host(r.url)
    if (!h || blocked(r.url) || directory(h) || skip.some(o => host(o) === h) || out.some(o => host(o) === h)) continue
    const hn = (h.split('.').length === 2 ? h.split('.')[0] : h).replace(/[^a-z0-9]/g, '')
    const u = `https://${h}`
    if (toks.some(t => hn.includes(t))) { if (out.length < 3) out.push(u) }
    else if (best === null && toks.slice(0, 2).every(t => norm(r.title).includes(t))) best = u
  }
  if (best && out.length < 3 && !out.some(o => host(o) === host(best!))) out.push(best)
  return out
}
// all stages at once (tests and callers that want the list); researchCompany walks them lazily instead
export async function siteCandidates(ev: ResearchEvent, city: string, deps: CompanyDeps, c?: ResearchCase): Promise<string[]> {
  const a = shownSites(ev), b = c ? guessedSites(ev, c, city) : []
  const out = [...a, ...b]
  for (const u of await searchedSites(ev, city, deps, out)) if (out.length < 8) out.push(u)
  return out
}

// #1122: is this site THIS business? Its own pages show the case's place (a place keyword, or a country domain like ".com.au") AND its
// category (a business-type keyword). The case's keyword lists when given (the matrix's), else the words of `where` / `category`.
const words = (s: string, min: number) => s.toLowerCase().split(/[^a-z0-9\u00c0-\u024f]+/).filter(w => w.length >= min)
export function siteMatchesCase(c: ResearchCase, siteHost: string, pageTexts: string[]): { place: boolean; category: boolean } {
  const text = ` ${pageTexts.join(' \n ').toLowerCase().replace(/\s+/g, ' ')} `
  const placeKw = c.whereKeywords?.length ? c.whereKeywords : words(c.where, 3)
  const catKw = c.categoryKeywords?.length ? c.categoryKeywords : words(c.category, 4).map(w => w.replace(/(?:ies|es|s)$/, ''))
  const place = placeKw.some(k => { const kw = k.toLowerCase(); return kw.startsWith('.') ? siteHost.endsWith(kw) : kwIn(text, kw) })
  // TWO different category words: one is chance (a "menu" on any site, "bar" in "barrier"), two is what the business does
  // (with only the words of the category name to go on, one of them is enough: there is no list to count against)
  const category = new Set(catKw.map(k => k.toLowerCase()).filter(k => kwIn(text, k))).size >= (c.categoryKeywords?.length ? 2 : 1)
  return { place, category }
}
// A keyword at the start of a word (a stem like "manufactur" matches "manufacturing"); a keyword of 4 letters or fewer only as a whole word;
// one with punctuation in it (", tx") as written.
const kwIn = (text: string, kw: string): boolean => {
  if (!/^[a-z\u00c0-\u024f0-9 -]+$/.test(kw)) return text.includes(kw)
  const e = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(kw.length <= 4 ? `(?<![a-z0-9\u00c0-\u024f])${e}(?![a-z0-9\u00c0-\u024f])` : `(?<![a-z0-9\u00c0-\u024f])${e}`).test(text)
}
// The site's homepage must name THIS company: its full name, or (a name of several words) two of its distinctive words, or (one word) that word.
// Place words are not distinctive ("Special Australia" is not australia.com).
export function homeNamesCompany(company: string, homeText: string, c: ResearchCase): boolean {
  const t = ` ${norm(homeText)} `, full = norm(company)
  if (full && t.includes(` ${full} `)) return true
  const place = new Set(words(c.where, 3).concat((c.whereKeywords ?? []).flatMap(k => words(k, 3))))
  const toks = nameTokens(company).filter(w => !place.has(w))
  if (!toks.length) return false
  const hit = toks.filter(w => t.includes(` ${w} `)).length
  if (hit < Math.min(2, toks.length)) return false
  // one distinctive word is thin evidence ("Apex" is in every other Austin roofer's text): it must open the page (title / first heading)
  if (toks.length === 1) return ` ${norm(homeText.slice(0, 300))} `.includes(` ${toks[0]} `)
  return true
}

const parseJson = (s: string | null): Record<string, unknown> | null => {
  if (!s) return null
  const m = /\{[\s\S]*\}/.exec(s)
  if (!m) return null
  try { const j = JSON.parse(m[0]); return j && typeof j === 'object' && !Array.isArray(j) ? j as Record<string, unknown> : null } catch { return null }
}
const str = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim() : null

// 2-6. the research of one company
export async function researchCompany(c: ResearchCase, plan: ResearchPlan, ev: ResearchEvent, deps: CompanyDeps): Promise<CompanyResearch> {
  const soft = <T>(fallback: T) => (e: unknown): T => { if (deps.isRefusal?.(e)) throw e; return fallback }
  const city = c.where.split(',')[0].trim()
  const sources: Source[] = []
  const emails = new Map<string, string>()
  const add = (url: string, text: string, kind: Source['kind']) => { sources.push({ id: `S${sources.length + 1}`, url, text, kind }) }
  const ev0 = await open(deps, ev.sourceUrl)
  if (ev0) add(ev.sourceUrl, ev0.text.slice(0, PAGE_TEXT), 'page')
  let site: string | null = null, wrongSite = false
  const tried = new Set<string>(), rejectedGuess = new Set<string>()
  // one candidate: open it, read its own pages, and keep it only when it is THIS business (place + category + the homepage names the company)
  const tryCandidate = async (cand: string, speculative = false): Promise<boolean> => {
    // a host first tried as a guess and refused, then pointed at by the event or a search, IS a mis-identified site
    if (tried.has(host(cand))) { if (!speculative && rejectedGuess.has(host(cand))) wrongSite = true; return false }
    tried.add(host(cand))
    const home = await open(deps, cand)
    if (!home) return false
    tried.add(host(home.finalUrl))
    const sh = host(home.finalUrl), picks: string[] = [], seen = new Set<string>()
    for (const l of home.links) {
      const u = l.url.split('#')[0]
      if (host(u) !== sh || seen.has(u) || u.replace(/\/$/, '') === home.finalUrl.replace(/\/$/, '')) continue
      const path = u.split(sh)[1] ?? ''
      if (LINK_RX.test(path) || LINK_RX.test(l.text)) { seen.add(u); picks.push(u) }
    }
    picks.sort((a, b) => (FIRST_RX.test(a) ? 0 : 1) - (FIRST_RX.test(b) ? 0 : 1) || a.length - b.length)
    const pages = [home, ...(await Promise.all(picks.slice(0, MAX_OWN_PAGES).map(u => open(deps, u)))).filter((p): p is ReadPage => !!p)]
    const m = siteMatchesCase(c, sh, pages.map(p => p.text))
    // a GUESSED host that is some other business is not evidence that the company's site was mis-identified: only a site the event or a search
    // pointed at, and that fails, stops the person hunt (#1122)
    if (!m.place || !m.category || !homeNamesCompany(ev.company, home.text, c)) { if (!speculative) wrongSite = true; else { rejectedGuess.add(host(cand)); rejectedGuess.add(host(home.finalUrl)) } return false }
    site = `https://${sh}`
    add(home.finalUrl, home.text.slice(0, PAGE_TEXT), 'page')
    for (const p of pages.slice(1)) add(p.finalUrl, p.text.slice(0, TEAM_TEXT), 'page')
    for (const p of pages) for (const mm of [...p.mailtos, ...(p.text.match(EMAIL_RX) ?? [])]) {
      const e = mm.replace(/^\.+|\.+$/g, '').toLowerCase()
      if (!NOT_EMAIL.test(e) && !emails.has(e)) emails.set(e, p.finalUrl)
    }
    return true
  }
  // stages: the site the event shows, then hosts guessed from the name (free fetches), then one search; stop at the first that is the business
  const stage1 = shownSites(ev)
  let found = false
  for (const cand of stage1) if (!found) found = await tryCandidate(cand)
  if (!found) for (const cand of guessedSites(ev, c, city).filter(u => !stage1.includes(u))) { if (!found) found = await tryCandidate(cand, true) }
  if (!found) for (const cand of await searchedSites(ev, city, deps, [])) { if (!found) found = await tryCandidate(cand) }
  // #1122: a site was found but none of its candidates is this business: no site, no person (a name from the wrong company is worse than none)
  if (!site && wrongSite) return { site: null, sources, person: null, location: null, whatTheyDo: null, emails: [] }
  const siteHost = site ? host(site) : ''
  // 3-4. The person, cheapest first (Hermes 03:3x: the hunt uses most of the scan's searches, so a search per company is the scarce thing):
  //   a. the pages already opened (the event page and the company's own home / about / team / people / contact / imprint pages): one model call;
  //   b. a senior person the trigger article itself names (no call);
  //   c. only then the person searches (snippets are sources, at most two result pages opened), one more call, and the second look.
  const seed = registrySeed(ev, sources.filter(s => s.url === ev.sourceUrl).map(s => s.text))
  const known = (ev.people.map(p => `${p.name} (${p.title ?? ''})`).join('; ') || 'none') + (seed ? `. The city's permit record names ${seed} as contractor of record: that is a lead to check, NOT a role. Use ${seed} only if a source states their role at THIS company (owner, president, CEO, general manager...)` : '')
  const promptFor = () => {
    const body = sources.map(s => `[${s.id}] (${s.kind}) ${s.url}\n${s.text}`).join('\n\n').slice(0, PROMPT_SOURCES)
    return `Company: ${ev.company} (${c.category}, ${c.where}). A seller of "${c.offer}" wants the person who decides on buying it.
Typical decision-maker titles: ${plan.decisionMakerTitles.join(', ')}. People named in the trigger article: ${known}.
SOURCES:
${body}
---
Return ONLY JSON:
{"decision_maker":{"name":"full name of a real person at THIS company, or null","title":"their role","source_id":"S#","quote":"VERBATIM text (8-40 words) from that source that contains BOTH the person's name and their role"},
"profile_url":"a LinkedIn or bio-page URL for that person that appears in the sources, else null",
"location":{"source_id":"S#","quote":"VERBATIM text showing the company's address/city"} or null,
"what_they_do":"one line from the sources"}
Rules: never invent a name; the quote must be copied character for character from the cited source; prefer the most senior relevant person; if no person is named for this exact company, decision_maker.name = null.`
  }
  let j: Record<string, unknown> = {}
  let person: Person | null = null
  const askModel = async (extra = '') => parseJson(await deps.complete(promptFor() + extra, 900).catch(soft(null)))
  // a. the pages already opened, when the company's own site is among them
  if (siteHost && sources.length) { j = await askModel() ?? {}; person = acceptPerson(j, sources, 'research') }
  // b. the trigger article's own senior person (its quote checked on that article)
  if (!person) {
    const cand = ev.people.find(x => x.name && x.quote && SENIOR.test(`${x.title ?? ''} ${x.quote}`))
    if (cand && sources[0]?.url === ev.sourceUrl) person = acceptPerson({ decision_maker: { name: cand.name, title: cand.title, source_id: sources[0].id, quote: cand.quote } }, sources, 'trigger article')
  }
  // c. the searches, only for a company whose own pages and trigger article name nobody
  if (!person) {
    const t2 = plan.decisionMakerTitles.slice(0, 3)
    const pq = [...(seed ? [`"${seed}" "${ev.company}" ${city}`] : []), `"${ev.company}" ${city} owner OR founder OR CEO OR president OR "managing partner"`,
      `${ev.company} ${city} ${t2.map(t => `"${t}"`).join(' OR ')} linkedin`,
      ...(seed ? [] : [`who owns ${ev.company} ${city}`])]
    if (siteHost) pq.push(`site:${siteHost} founder OR owner OR president OR CEO OR partner OR director`)
    const seenU = new Set(sources.map(s => s.url)), toks = nameTokens(ev.company)
    let opened = 0, added = 0
    const results = await Promise.all(pq.map(q => deps.search(q).catch(soft([] as SearchResult[]))))
    for (const rs of results) for (const r of rs.slice(0, 6)) {
      const u = r.url ?? '', sn = `${r.title ?? ''} \u2014 ${r.snippet ?? ''}`
      if (!u || seenU.has(u) || !toks.some(t => norm(sn).includes(t))) continue
      seenU.add(u); added++
      let pg: ReadPage | null = null
      if (opened < MAX_RESULT_PAGES && !blocked(u) && !directory(host(u))) { pg = await open(deps, u); opened++ }
      if (pg && toks.some(t => norm(pg!.text.slice(0, 6000)).includes(t))) add(u, pg.text.slice(0, RESULT_TEXT), 'page')
      else add(u, sn.slice(0, SNIPPET_TEXT), 'snippet')
    }
    // a new call only when the searches added a source, or when no call has been made yet
    if (sources.length && (added > 0 || !(siteHost && sources.length))) { const jj = await askModel() ?? {}; j = { ...j, ...jj }; person = acceptPerson(jj, sources, 'research') }
    if (!person && sources.length) {
      const j2 = await askModel(`\n\nSECOND LOOK: a founder, co-founder, owner, CEO, managing partner, principal dentist/chef-owner or general manager of this company IS a valid decision-maker. Search-result snippets (LinkedIn titles, directory lines) count as sources. If ANY source names such a person for this exact company, return them with the verbatim quote; only return null when no source names anyone.`)
      const p2 = j2 ? acceptPerson(j2, sources, 'second look') : null
      if (p2) { person = p2; j = { ...j, ...j2 } }
    }
  }
  const loc = j.location && typeof j.location === 'object' ? j.location as Record<string, unknown> : null
  const locSrc = loc ? sources.find(s => s.id === str(loc.source_id)) : undefined
  const location = loc && locSrc && quoteIn(str(loc.quote), locSrc.text) ? { sourceId: locSrc.id, quote: str(loc.quote)! } : null
  // 6. emails printed on the company's own pages only (its domain or a subdomain of it)
  return { site, sources, person, location, whatTheyDo: str(j.what_they_do)?.slice(0, 300) ?? null, emails: ownEmails(emails, siteHost, person) }
}

// A registry lead (a city permit) names a contractor of record: that name is a SEED to search for, never a decision-maker by itself. A permit
// "Applicant" / "System Administrator" is whoever filed the paper; only a page that states a real role at this company makes a person.
const ROLE_ONLY_RX = /^(?:contractor of record(?: on the .{1,40} permit)?|applicant|system administrator|administrator|agent|contact|registered agent)$/i
export function registrySeed(ev: ResearchEvent, pageTexts: string[] = []): string | null {
  const texts = [ev.quote, ev.whyNow, ev.whatHappened, ...ev.people.flatMap(p => [p.quote, p.name]), ...pageTexts.map(t => t.slice(0, 20_000))]
  for (const t of texts) {
    const m = /contractor of record:?\s+([\p{L}][\p{L}.'’-]*(?:\s+[\p{L}][\p{L}.'’-]*){1,3})/iu.exec(t ?? '')
    if (m) return m[1].trim().replace(/[.\s]+$/, '')
  }
  const p = ev.people.find(x => x.name && /contractor of record/i.test(`${x.title ?? ''} ${x.quote}`))
  if (p) return p.name
  for (const t of pageTexts) {   // the open-data record as JSON: the model may have left the contractor out of ev.people
    const j = /"contractor_full_name"\s*:\s*"([\p{L}][\p{L}.' -]{3,60})"/iu.exec(t.slice(0, 200_000))
    if (j && /\s/.test(j[1].trim())) return j[1].trim()
  }
  return null
}

// The model's person, kept only when its quote is literally in the source it cites and names the person: never trusted to have copied it.
function acceptPerson(j: Record<string, unknown>, sources: Source[], from: Person['from']): Person | null {
  const dm = j.decision_maker && typeof j.decision_maker === 'object' ? j.decision_maker as Record<string, unknown> : null
  const name = str(dm?.name), quote = str(dm?.quote)
  if (!dm || !name || !quote || /^null$/i.test(name)) return null
  const src = sources.find(s => s.id === str(dm.source_id))
  if (!src || !quoteIn(quote, src.text)) return null
  const last = norm(name).split(' ').filter(w => w.length > 1).pop()
  if (!last || !norm(quote).split(' ').includes(last)) return null   // the quote must contain the person's name
  const profile = str(j.profile_url)
  const profileUrl = profile && /^https?:\/\//i.test(profile) && sources.some(s => s.url === profile || s.text.includes(profile)) ? profile : null
  const title = str(dm.title)
  if (title && ROLE_ONLY_RX.test(title.trim())) return null   // a filing role is not a decision-maker's title
  return { name, title, sourceId: src.id, quote, profileUrl, from }
}

// The addresses printed on the company's own pages: its domain (or a subdomain), never a recruiting or no-reply inbox; the named person's own
// address first (its local part carries their first or last name), then the company's inboxes, in page order. At most 5.
// a bare public suffix is not a company's domain: an address @co.uk must never ride on the site acme.co.uk
const PUBLIC_SUFFIX = /^(?:co|com|org|net|gov|edu|ac|ltd|plc)\.[a-z]{2}$|^[a-z]{2,3}$/i
const NOT_A_CONTACT = /^(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|webmaster|careers?|jobs?|recruit\w*|talent|hr|hiring|applications?|resumes?|privacy|gdpr|dpo|abuse|unsubscribe|wordpress)$/i
export function ownEmails(found: Map<string, string>, siteHost: string, person: Person | null): { email: string; url: string }[] {
  if (!siteHost) return []
  const own = [...found].filter(([e]) => { const [local, d = ''] = e.split('@'); return (d === siteHost || d.endsWith(`.${siteHost}`) || (siteHost.endsWith(`.${d}`) && !PUBLIC_SUFFIX.test(d))) && !NOT_A_CONTACT.test(local.replace(/[._-]/g, '')) })
  const parts = person ? norm(person.name).split(' ').filter(w => w.length >= 3 && !/^(?:dr|mr|mrs|ms)$/.test(w)) : []
  const mine = (e: string) => parts.some(p => e.split('@')[0].replace(/[^a-z]/g, '').includes(p))
  return [...own.filter(([e]) => mine(e)), ...own.filter(([e]) => !mine(e))].slice(0, 5).map(([email, url]) => ({ email, url }))
}

// A's paced search (hunt.ts SearchFn: TinyFish inside the scan's caps) as this module's search: a 'rate' answer (the per-minute limit, refused
// before anything is sent) is waited out and retried, like hunt(); any other failure is no results. `wait` is injected for tests.
export function companySearch(search: SearchFn, after: string, o: { retries?: number; waitMs?: number; wait?: (ms: number) => Promise<void> } = {}): CompanyDeps['search'] {
  const wait = o.wait ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  return async q => {
    for (let i = 0; i <= (o.retries ?? 18); i++) {
      const r = await search(q, after)
      if (r.ok) return r.hits.map(h => ({ url: h.url, title: h.title ?? '', snippet: h.snippet ?? '' }))
      if (r.reason !== 'rate') return []
      await wait(o.waitMs ?? 5000)
    }
    return []
  }
}

// GOAL-DRIVEN SCAN (MISSION v2, Hermes 05:40): the orchestrator (A's run.ts) calls the company stage again on every loop, and the same company
// often comes back from another trigger or source. One memo per scan: the same company (by its distinctive name words) in the same place is
// researched once and its result reused, so a later loop spends no search, fetch or model call on it. A failed research (an exception, a
// spend refusal) is not kept, so it is tried again. `size` is how many companies were researched; `hits` how many calls were answered from it.
export function memoCompanyResearch(research: (c: ResearchCase, plan: ResearchPlan, ev: ResearchEvent) => Promise<CompanyResearch>) {
  const done = new Map<string, Promise<CompanyResearch>>()
  let hits = 0
  const keyOf = (c: ResearchCase, ev: ResearchEvent) => `${norm(ev.company).replace(/\b(?:inc|llc|llp|ltd|gmbh|pvt|limited|the)\b/g, ' ').replace(/\s+/g, ' ').trim()}|${norm(c.where)}`
  const fn = async (c: ResearchCase, plan: ResearchPlan, ev: ResearchEvent): Promise<CompanyResearch> => {
    const k = keyOf(c, ev), had = done.get(k)
    if (had) { hits++; return had }
    const p = research(c, plan, ev)
    done.set(k, p)
    try {
      const r = await p
      // nothing opened and nothing decided (a network blip, a blocked page): not a final answer, so a later loop tries again
      if (!r.site && !r.person && r.sources.length === 0) done.delete(k)
      return r
    } catch (e) { done.delete(k); throw e }
  }
  return Object.defineProperties(fn, { size: { get: () => done.size }, hits: { get: () => hits } }) as typeof fn & { readonly size: number; readonly hits: number }
}
