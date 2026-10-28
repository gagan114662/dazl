// An open sales / GTM role on the company's OWN careers page (public, https, robots.txt obeyed, same registrable domain). This is the "currently hiring
// sales staff" proof when the company has no public Greenhouse / Lever / Ashby board (lib/signals/ats-gtm.ts). It is evidence for the hiring half only:
// it saves the page URL, the role title with the surrounding text as the quote, and the retrieval time as the currentness evidence (the page does not
// date its roles, so nothing here is a posting date and nothing may be used as an event date). Unknown stays unknown:
//   no careers page / robots unreachable / page unreachable / no sales role / a closed or "no open positions" marker  ->  vacancy null + the reason.
// Funding, engineering growth, generic "GTM plans" and another company's jobs are not a vacancy: only a role-shaped title that isGtmRole() accepts counts.
import { isGtmRole } from './ats-gtm.ts'
import { parseRobots, type Get } from '../connectors/sitecrawl.ts'

export interface CareersVacancy { url: string; title: string; quote: string; retrievedAt: number; pageText: string } // pageText: the page's visible text (capped), so the caller can check it names the company and its place
export type CareersReason = 'found' | 'robots_unreachable' | 'robots_disallow' | 'no_careers_page' | 'no_open_sales_role' | 'closed_marker' | 'wrong_domain'
export interface CareersResult { vacancy: CareersVacancy | null; reason: CareersReason; pages: number }

const PATHS = ['/careers', '/jobs', '/join-us', '/join', '/about/careers', '/company/careers', '/work-with-us']
const MAX_PAGES = 4
const ROLE_NOUN = /\b(?:executive|manager|representative|rep|sdr|bdr|director|head|lead|specialist|associate|officer|vp|vice president|consultant|engineer|partner|advisor|owner)\b/i
const CLOSED = /\b(?:no (?:current |open |active )?(?:openings|vacancies|positions|roles|jobs)|not (?:currently |actively )?(?:hiring|recruiting)|no longer (?:accepting|available|open|hiring)|(?:position|role|job|vacancy)s? (?:has been |have been |is |are |was )?(?:filled|closed|taken)|applications? (?:are |is )?closed|past (?:positions|roles|openings|jobs)|previous (?:positions|roles|openings)|currently closed|nothing (?:open|available)|check back (?:later|soon))\b/i
const registrable = (h: string) => { const l = h.toLowerCase().replace(/^www\./, '').split('.'); return l.length >= 3 && /^(?:co|com|org|ac)$/.test(l[l.length - 2]) ? l.slice(-3).join('.') : l.slice(-2).join('.') }
const visible = (html: string) => html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const flat = (html: string) => decode(visible(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

// Role-shaped titles in a page: the text of headings, links, list items and table cells that is short, names a role noun and is a sales / GTM role.
export function salesRoleTitles(html: string): string[] {
  const out: string[] = []
  for (const m of visible(html).matchAll(/<(h[1-6]|a|li|td|span|strong|p|div)\b[^>]*>([^<]{4,100})<\/\1>/gi)) {
    const t = decode(m[2]).replace(/\s+/g, ' ').trim().replace(/^[-–—•·\s]+|[-–—•·\s]+$/g, '')
    if (t.length < 4 || t.length > 80 || t.split(' ').length > 10 || !ROLE_NOUN.test(t) || !isGtmRole(t)) continue
    if (/\b(?:we are|we're|is hiring|are hiring|our|you'll|you will|looking for)\b/i.test(t) || /[.!?]$/.test(t)) continue // a sentence about hiring, not a role title
    if (!out.includes(t)) out.push(t)
  }
  return out
}

// A role counts as an OPEN JOB only when it is tied to that specific job's page: the title itself is a link to the posting, or the title is followed by an
// apply / view-role link to it. A posting URL is either on the company's own domain below the careers index (/careers/account-executive, /jobs/123) or a
// public Greenhouse / Lever / Ashby posting. "Apply for job alerts", "Apply for our newsletter", a bare "Apply" with no link, mailto: and the careers index
// itself are not job routes.
const ATS_HOST = /^(?:boards\.greenhouse\.io|job-boards\.greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com)$/
const NOT_A_JOB_ROUTE = /alert|newsletter|subscribe|notify|talent[-_ ]?(?:network|pool|community)|spontaneous|general[-_ ]?application|mailto:|^#|javascript:/i
const APPLY_TEXT = /^(?:apply(?: now| here| today| for (?:this|the) (?:job|role|position))?|view (?:role|job|position|details)|see (?:role|job|details)|read more|learn more|details)$/i
function specificJobUrl(href: string, base: string, site: string): string | null {
  if (!href || NOT_A_JOB_ROUTE.test(href)) return null
  let u: URL; try { u = new URL(href, base) } catch { return null }
  if (u.protocol !== 'https:' || u.username || u.password) return null
  const segs = u.pathname.split('/').filter(Boolean)
  if (ATS_HOST.test(u.hostname.toLowerCase())) return segs.length >= 2 ? u.toString() : null
  if (registrable(u.hostname) !== registrable(site)) return null
  let b: URL; try { b = new URL(base) } catch { return null }
  if (u.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '')) return null // the page itself / the index
  if (/alert|newsletter|subscribe|notify|login|signin|contact|about|team|blog|press/i.test(u.pathname)) return null
  return segs.length >= 2 || /job|role|position|opening|vacanc/i.test(u.pathname) ? u.toString() : null
}
export function openJobFor(html: string, pageUrl: string, site: string): { title: string; jobUrl: string } | null {
  const body = visible(html)
  const anchors = [...body.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(m => ({ href: decode(m[1]), text: decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(), end: (m.index ?? 0) + m[0].length, start: m.index ?? 0 }))
  const titles = salesRoleTitles(html)
  for (const t of titles) {
    // (a) the title is itself a link to that job
    const own = anchors.find(a => a.text === t)
    const ownUrl = own ? specificJobUrl(own.href, pageUrl, site) : null
    if (ownUrl) return { title: t, jobUrl: ownUrl }
    // (b) the title is followed (before the next role-like title) by an apply / view-role link to that job
    const at = body.indexOf(t); if (at < 0) continue
    const nextTitle = titles.map(x => body.indexOf(x, at + t.length)).filter(i => i > 0).sort((x, y) => x - y)[0] ?? Infinity
    const apply = anchors.find(a => a.start >= at && a.start < Math.min(at + t.length + 400, nextTitle) && APPLY_TEXT.test(a.text) && specificJobUrl(a.href, pageUrl, site))
    if (apply) return { title: t, jobUrl: specificJobUrl(apply.href, pageUrl, site)! }
  }
  return null
}

export async function careersSalesVacancy(domain: string, get: Get, opts: { now?: number; signal?: AbortSignal } = {}): Promise<CareersResult> {
  const site = domain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '')
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(site)) return { vacancy: null, reason: 'no_careers_page', pages: 0 }
  const origin = `https://${site}`
  const rob = await get(`${origin}/robots.txt`)
  if (!rob || rob.status >= 500) return { vacancy: null, reason: 'robots_unreachable', pages: 0 }
  const robots = rob.status >= 400 ? { allows: () => true } : parseRobots(rob.body, site)
  if (!robots.allows('/')) return { vacancy: null, reason: 'robots_disallow', pages: 0 }
  const paths = [...PATHS]
  const home = opts.signal?.aborted ? null : await get(`${origin}/`)
  if (home && home.status < 400) for (const m of home.body.matchAll(/href\s*=\s*["']([^"'#?]*(?:careers?|jobs|join(?:-us)?|work-with-us)[^"'#?]*)["']/gi)) {
    try { const u = new URL(m[1], home.finalUrl); if (registrable(u.hostname) === registrable(site) && !paths.includes(u.pathname)) paths.unshift(u.pathname) } catch { /* ignore */ }
  }
  let pages = 0, sawPage = false, closed = false, wrongDomain = false
  for (const p of paths) {
    if (pages >= MAX_PAGES || opts.signal?.aborted) break
    if (!robots.allows(p)) continue
    const r = await get(origin + p); pages++
    if (!r || r.status >= 400) continue
    let host = ''; try { host = new URL(r.finalUrl).hostname } catch { continue }
    if (registrable(host) !== registrable(site)) { wrongDomain = true; continue } // redirected to another site (an ATS board is checked by ats-gtm.ts)
    sawPage = true
    const text = flat(r.body)
    // Closed-status wording is checked BEFORE any title is accepted: a page that says it is not hiring does not have a vacancy, whatever else it lists.
    if (CLOSED.test(text)) { closed = true; continue }
    const hit = openJobFor(r.body, r.finalUrl, site)
    if (!hit) continue // titles with no link to that specific job (team listings, alerts, newsletters) are mentions, not vacancies
    const at = text.indexOf(hit.title)
    return { vacancy: { url: hit.jobUrl.slice(0, 500), title: hit.title.slice(0, 120), quote: (at >= 0 ? text.slice(Math.max(0, at - 60), at + hit.title.length + 160) : hit.title).slice(0, 300), retrievedAt: Math.floor((opts.now ?? Date.now()) / 1000), pageText: text.slice(0, 6000) }, reason: 'found', pages }
  }
  return { vacancy: null, reason: closed ? 'closed_marker' : sawPage ? 'no_open_sales_role' : wrongDomain ? 'wrong_domain' : 'no_careers_page', pages }
}
