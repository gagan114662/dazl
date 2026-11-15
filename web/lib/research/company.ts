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
//   6. emails: addresses printed on the company's OWN pages (its domain), with the page; never a guess.
// Every network call and the model are injected (CompanyDeps), so tests run on recorded pages and the scan wires the real ones
// (TinyFish search through lib/search/tinyfish.ts, the guarded direct fetch of lib/connectors/sitecrawl.ts, the job's provider).
import type { CompanyResearch, Person, ResearchCase, ResearchEvent, ResearchPlan, Source } from './types.ts'

export interface SearchResult { url: string; title: string; snippet: string }
export interface Fetched { status: number; body: string; finalUrl: string }
export interface CompanyDeps {
  search: (query: string) => Promise<SearchResult[]>
  get: (url: string) => Promise<Fetched | null>                    // raw HTML, direct (free); null = could not open
  complete: (prompt: string, maxTokens: number) => Promise<string | null>   // the model's text answer; null = no answer
}

// Hosts a direct fetch cannot open or that are never a company's own site (the prototype's BLOCKED + DIRECTORY lists).
const BLOCKED = ['linkedin.com', 'indeed.com', 'glassdoor.', 'ziprecruiter.com', 'x.com', 'twitter.com', 'tiktok.com', 'youtube.com', 'simplyhired', 'jooble', 'talent.com', 'yelp.', 'jobleads', 'bebee.com', 'monster.com']
const DIRECTORY = ['facebook.com', 'instagram.com', 'yellowpages', 'bbb.org', 'mapquest', 'tripadvisor', 'zoominfo', 'crunchbase', 'bloomberg.com', 'dnb.com', 'wikipedia.org', 'opencorporates', 'manta.com', 'chamberofcommerce', 'yelp.', 'angi.com', 'houzz.com', 'thumbtack', 'nextdoor', 'google.com', 'apple.com', 'bing.com', 'superpages', 'justia.com', 'avvo.com', 'martindale', 'lawyers.com', 'findlaw', 'healthgrades', 'zocdoc', 'ratemds', 'opentable', 'ubereats', 'doordash', 'theorg.com', 'rocketreach', 'apollo.io', 'signalhire', 'clutch.co', 'g2.com']
const LINK_RX = /about|team|people|staff|leadership|founder|our-story|story|contact|impressum|imprint|attorney|lawyer|professional|doctor|dentist|meet|management|ber-uns|kontakt|who-we-are|partners/i
const FIRST_RX = /team|people|leadership|about|attorney|impressum|doctor|founder/i
const EMAIL_RX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const NOT_EMAIL = /\.(png|jpe?g|gif|webp|svg)$|sentry|wixpress|example\.|@2x/i
const SENIOR = /founder|ceo|owner|partner|president|chief|director|managing|gesch.ftsf.hr|principal|head|chair|gr.nder|inhaber|dentist|dr\.?\b|chef|proprietor|vorstand/i
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

// The page as the research step reads it: visible text (scripts, styles, svg dropped; blocks become lines), its links with their text,
// and its mailto addresses. Pure.
export interface ReadPage { url: string; finalUrl: string; text: string; links: { url: string; text: string }[]; mailtos: string[] }
const decode = (s: string) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;|&#8217;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d{1,6});/g, (_m, d: string) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)))
export function readHtml(html: string, url: string, finalUrl = url): ReadPage {
  const body = html.slice(0, 1_500_000).replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
  const links: { url: string; text: string }[] = [], mailtos: string[] = []
  for (const m of body.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi)) {
    const href = decode(m[1].trim())
    if (/^mailto:/i.test(href)) { mailtos.push(href.slice(7).split('?')[0]); continue }
    let u: string; try { u = new URL(href, finalUrl).toString() } catch { continue }
    if (!/^https?:/i.test(u)) continue
    links.push({ url: u, text: decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 80) })
  }
  const text = decode(body.replace(/<\/?(p|div|li|ul|ol|h[1-6]|br|section|article|tr|td|th|header|footer|nav|figure|figcaption|address|blockquote|dd|dt|table)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' '))
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

// 1. the company's own site
export async function findSite(ev: ResearchEvent, city: string, deps: CompanyDeps): Promise<string | null> {
  if (ev.pageIsCompanySite && host(ev.sourceUrl) && !blocked(ev.sourceUrl) && !directory(host(ev.sourceUrl))) return `https://${host(ev.sourceUrl)}`
  const w = (ev.website ?? '').trim()
  if (w && w.includes('.') && !/\s/.test(w)) { const u = /^https?:\/\//i.test(w) ? w : `https://${w}`; if (host(u) && !blocked(u) && !directory(host(u))) return u }
  const toks = nameTokens(ev.company)
  let rs: SearchResult[] = []
  try { rs = await deps.search(`${ev.company} ${city} official website`) } catch { rs = [] }
  let best: string | null = null
  for (const r of rs.slice(0, 8)) {
    const h = host(r.url)
    if (!h || blocked(r.url) || directory(h)) continue
    const hn = (h.split('.').length === 2 ? h.split('.')[0] : h).replace(/[^a-z0-9]/g, '')
    if (toks.some(t => hn.includes(t))) return `https://${h}`
    if (best === null && toks.slice(0, 2).every(t => norm(r.title).includes(t))) best = `https://${h}`
  }
  return best
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
  const city = c.where.split(',')[0].trim()
  const site = await findSite(ev, city, deps)
  const sources: Source[] = []
  const emails = new Map<string, string>()
  const add = (url: string, text: string, kind: Source['kind']) => { sources.push({ id: `S${sources.length + 1}`, url, text, kind }) }
  const ev0 = await open(deps, ev.sourceUrl)
  if (ev0) add(ev.sourceUrl, ev0.text.slice(0, PAGE_TEXT), 'page')
  const siteHost = site ? host(site) : ''
  if (site) {
    const home = await open(deps, site)
    if (home) {
      add(home.finalUrl, home.text.slice(0, PAGE_TEXT), 'page')
      const sh = host(home.finalUrl), picks: string[] = [], seen = new Set<string>()
      for (const l of home.links) {
        const u = l.url.split('#')[0]
        if (host(u) !== sh || seen.has(u) || u.replace(/\/$/, '') === home.finalUrl.replace(/\/$/, '')) continue
        const path = u.split(sh)[1] ?? ''
        if (LINK_RX.test(path) || LINK_RX.test(l.text)) { seen.add(u); picks.push(u) }
      }
      picks.sort((a, b) => (FIRST_RX.test(a) ? 0 : 1) - (FIRST_RX.test(b) ? 0 : 1) || a.length - b.length)
      const pages = [home, ...(await Promise.all(picks.slice(0, MAX_OWN_PAGES).map(u => open(deps, u)))).filter((p): p is ReadPage => !!p)]
      for (const p of pages.slice(1)) add(p.finalUrl, p.text.slice(0, TEAM_TEXT), 'page')
      for (const p of pages) for (const m of [...p.mailtos, ...(p.text.match(EMAIL_RX) ?? [])]) {
        const e = m.replace(/^\.+|\.+$/g, '').toLowerCase()
        if (!NOT_EMAIL.test(e) && !emails.has(e)) emails.set(e, p.finalUrl)
      }
    }
  }
  // 3. person searches; snippets are sources, and at most two result pages that name the company are opened
  const t2 = plan.decisionMakerTitles.slice(0, 3)
  const pq = [`"${ev.company}" ${city} owner OR founder OR CEO OR president OR "managing partner"`,
    `${ev.company} ${city} ${t2.map(t => `"${t}"`).join(' OR ')} linkedin`,
    `who owns ${ev.company} ${city}`]
  if (siteHost) pq.push(`site:${siteHost} founder OR owner OR president OR CEO OR partner OR director`)
  const seenU = new Set(sources.map(s => s.url)), toks = nameTokens(ev.company)
  let opened = 0
  const results = await Promise.all(pq.map(q => deps.search(q).catch(() => [] as SearchResult[])))
  for (const rs of results) for (const r of rs.slice(0, 6)) {
    const u = r.url ?? '', sn = `${r.title ?? ''} — ${r.snippet ?? ''}`
    if (!u || seenU.has(u) || !toks.some(t => norm(sn).includes(t))) continue
    seenU.add(u)
    let pg: ReadPage | null = null
    if (opened < MAX_RESULT_PAGES && !blocked(u) && !directory(host(u))) { pg = await open(deps, u); opened++ }
    if (pg && toks.some(t => norm(pg!.text.slice(0, 6000)).includes(t))) add(u, pg.text.slice(0, RESULT_TEXT), 'page')
    else add(u, sn.slice(0, SNIPPET_TEXT), 'snippet')
  }
  // 4. one model call; the second look only for the misses
  const known = ev.people.map(p => `${p.name} (${p.title ?? ''})`).join('; ') || 'none'
  const body = sources.map(s => `[${s.id}] (${s.kind}) ${s.url}\n${s.text}`).join('\n\n').slice(0, PROMPT_SOURCES)
  const prompt = `Company: ${ev.company} (${c.category}, ${c.where}). A seller of "${c.offer}" wants the person who decides on buying it.
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
  let j = sources.length ? parseJson(await deps.complete(prompt, 900).catch(() => null)) ?? {} : {}
  let person = acceptPerson(j, sources, 'research')
  if (!person) {
    const cand = ev.people.find(x => x.name && x.quote && SENIOR.test(`${x.title ?? ''} ${x.quote}`))
    if (cand && sources[0]?.url === ev.sourceUrl) person = acceptPerson({ decision_maker: { name: cand.name, title: cand.title, source_id: sources[0].id, quote: cand.quote } }, sources, 'trigger article')
    if (!person && sources.length) {
      const j2 = parseJson(await deps.complete(`${prompt}\n\nSECOND LOOK: a founder, co-founder, owner, CEO, managing partner, principal dentist/chef-owner or general manager of this company IS a valid decision-maker. Search-result snippets (LinkedIn titles, directory lines) count as sources. If ANY source names such a person for this exact company, return them with the verbatim quote; only return null when no source names anyone.`, 900).catch(() => null))
      const p2 = j2 ? acceptPerson(j2, sources, 'second look') : null
      if (p2) { person = p2; j = { ...j, ...j2 } }
    }
  }
  const loc = j.location && typeof j.location === 'object' ? j.location as Record<string, unknown> : null
  const locSrc = loc ? sources.find(s => s.id === str(loc.source_id)) : undefined
  const location = loc && locSrc && quoteIn(str(loc.quote), locSrc.text) ? { sourceId: locSrc.id, quote: str(loc.quote)! } : null
  // 6. emails printed on the company's own pages only (its domain or a subdomain of it)
  const own = siteHost ? [...emails].filter(([e]) => { const d = e.split('@')[1] ?? ''; return d === siteHost || d.endsWith(`.${siteHost}`) || siteHost.endsWith(`.${d}`) }) : []
  return { site, sources, person, location, whatTheyDo: str(j.what_they_do)?.slice(0, 300) ?? null, emails: own.slice(0, 5).map(([email, url]) => ({ email, url })) }
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
  return { name, title: str(dm.title), sourceId: src.id, quote, profileUrl, from }
}
