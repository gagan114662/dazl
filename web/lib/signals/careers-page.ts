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
const APPLY = /\b(?:apply|view (?:role|job|position)|job description|read more|learn more|see role|open (?:roles?|positions?)|current (?:openings|vacancies))\b/i
const CLOSED = /\b(?:no (?:current |open )?(?:openings|vacancies|positions|roles)|not (?:currently )?hiring|no longer (?:accepting|available|open)|position (?:has been|is) filled|(?:role|position|job) (?:is )?closed|applications? (?:are )?closed)\b/i
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
    const titles = salesRoleTitles(r.body)
    if (CLOSED.test(text) && titles.length === 0) { closed = true; continue }
    for (const title of titles) {
      const at = text.indexOf(title); if (at < 0) continue
      const around = text.slice(Math.max(0, at - 60), at + title.length + 160)
      if (CLOSED.test(text.slice(at, at + title.length + 200))) { closed = true; continue } // this role is marked closed / filled
      if (!APPLY.test(text.slice(at, at + title.length + 400))) continue // a title with no way to apply is a mention, not a vacancy
      return { vacancy: { url: r.finalUrl.slice(0, 500), title: title.slice(0, 120), quote: around.slice(0, 300), retrievedAt: Math.floor((opts.now ?? Date.now()) / 1000), pageText: text.slice(0, 6000) }, reason: 'found', pages }
    }
  }
  return { vacancy: null, reason: closed ? 'closed_marker' : sawPage ? 'no_open_sales_role' : wrongDomain ? 'wrong_domain' : 'no_careers_page', pages }
}
