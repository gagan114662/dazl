// An open sales / GTM role on the company's OWN careers page (public, https, robots.txt obeyed, same registrable domain). This is the "currently hiring
// sales staff" proof when the company has no public Greenhouse / Lever / Ashby board (lib/signals/ats-gtm.ts). It is evidence for the hiring half only:
// it saves the page URL, the role title with the surrounding text as the quote, and the retrieval time as the currentness evidence (the page does not
// date its roles, so nothing here is a posting date and nothing may be used as an event date). Unknown stays unknown:
//   no careers page / robots unreachable / page unreachable / no sales role / a closed or "no open positions" marker  ->  vacancy null + the reason.
// Funding, engineering growth, generic "GTM plans" and another company's jobs are not a vacancy: only a role-shaped title that isGtmRole() accepts counts.
import { isGtmRole } from './ats-gtm.ts'
import { parseRobots, type Get } from '../connectors/sitecrawl.ts'
import { getDomain } from 'tldts'
import { decode as decodeEntities, htmlToText } from '../scan/fetch-page.ts'

export interface CareersVacancy { url: string; title: string; quote: string; retrievedAt: number; pageText: string; posted?: string | null; postedBoard?: 'greenhouse' | 'lever' | 'ashby' | null } // pageText: the page's visible text (capped), so the caller can check it names the company and its place
// posted (#533 AC4): when the careers link IS a public Greenhouse / Lever / Ashby posting, the board's OWN first-published date read from that
// posting (Greenhouse first_published, Lever createdAt, Ashby publishedAt - never updated_at). null = the posting supplies no date (an own-domain
// job page never does): the date stays unknown and the retrieval day is never used in its place.
// roleMatchAsked: the caller asked for a specific requested role; matched tells whether the returned vacancy source-matched it.
// A returned vacancy with matched=false is GENERIC careers hiring only: recordable, never role-qualified (AC3).
export interface CareersResult { vacancy: CareersVacancy | null; reason: CareersReason; pages: number; readPages?: number; matched?: boolean }
export type CareersReason = 'job_role_mismatch' | 'job_closed' | 'job_company_mismatch' | 'job_unverified' | 'found' | 'robots_unreachable' | 'robots_disallow' | 'no_careers_page' | 'no_open_sales_role' | 'closed_marker' | 'wrong_domain' | 'no_matching_requested_role'

const PATHS = ['/careers', '/jobs', '/join-us', '/join', '/about/careers', '/company/careers', '/work-with-us']
const MAX_PAGES = 4
const ROLE_NOUN = /\b(?:executive|manager|representative|rep|sdr|bdr|director|head|lead|specialist|associate|officer|vp|vice president|consultant|engineer|partner|advisor|owner)\b/i
const CLOSED = /\b(?:no (?:current |open |active )?(?:openings|vacancies|positions|roles|jobs)|not (?:currently |actively )?(?:hiring|recruiting)|no longer (?:accepting|available|open|hiring)|(?:position|role|job|vacancy)s? (?:has been |have been |is |are |was )?(?:filled|closed|taken)|applications? (?:are |is )?closed|past (?:positions|roles|openings|jobs)|previous (?:positions|roles|openings)|currently closed|nothing (?:open|available)|check back (?:later|soon))\b/i
// The registrable domain by the Public Suffix List INCLUDING its private section (as lib/evals/contract.ts does), so shared hosts are not one company:
// alice.github.io and bob.github.io are different sites. A host with no listed suffix is itself.
export const registrable = (h: string) => { const host = h.toLowerCase().replace(/^www\./, ''); return getDomain(host, { allowPrivateDomains: true }) ?? host }
const visible = (html: string) => html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const flat = (html: string) => decode(visible(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

// Role-shaped titles in a page: the text of headings, links, list items and table cells that is short, names a role noun and is a sales / GTM role.
// `accept` widens the candidate set to titles matching the caller's requested role: an explicit user ask (e.g. CRM administrator)
// is a candidate even when it is not a generic sales / GTM title - GTM-only discovery never quietly drops a named role.
export function salesRoleTitles(html: string, accept?: (title: string) => boolean): string[] {
  const out: string[] = []
  for (const m of visible(html).matchAll(/<(h[1-6]|a|li|td|span|strong|p|div)\b[^>]*>([^<]{4,100})<\/\1>/gi)) {
    const t = decode(m[2]).replace(/\s+/g, ' ').trim().replace(/^[-–—•·\s]+|[-–—•·\s]+$/g, '')
    if (t.length < 4 || t.length > 80 || t.split(' ').length > 10) continue
    const asked = accept?.(t) ?? false // an explicitly requested role title (e.g. CRM administrator) needs neither the role-noun nor the GTM gate
    if (!asked && (!ROLE_NOUN.test(t) || !isGtmRole(t))) continue
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
export function openJobsFor(html: string, pageUrl: string, site: string, accept?: (title: string) => boolean): { title: string; jobUrl: string }[] {
  const body = visible(html)
  const anchors = [...body.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(m => ({ href: decode(m[1]), text: decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(), end: (m.index ?? 0) + m[0].length, start: m.index ?? 0 }))
  const titles = salesRoleTitles(html, accept)
  const hits: { title: string; jobUrl: string }[] = []
  for (const t of titles) {
    // (a) the title is itself a link to that job
    const own = anchors.find(a => a.text === t)
    const ownUrl = own ? specificJobUrl(own.href, pageUrl, site) : null
    if (ownUrl) { hits.push({ title: t, jobUrl: ownUrl }); continue }
    // (b) the title is followed (before the next role-like title) by an apply / view-role link to that job
    const at = body.indexOf(t); if (at < 0) continue
    const nextTitle = titles.map(x => body.indexOf(x, at + t.length)).filter(i => i > 0).sort((x, y) => x - y)[0] ?? Infinity
    const apply = anchors.find(a => a.start >= at && a.start < Math.min(at + t.length + 400, nextTitle) && APPLY_TEXT.test(a.text) && specificJobUrl(a.href, pageUrl, site))
    if (apply) hits.push({ title: t, jobUrl: specificJobUrl(apply.href, pageUrl, site)! })
  }
  return hits
}

// ---- the selected job must be verified, never trusted from the careers index ----
// A link on the careers index can outlive its job. Before a role is accepted its OWN page / posting is fetched:
//   same-domain job page: reachable (not 404 / 410), still on the company's domain after redirects (not bounced to the index or another site), still shows the title,
//                         and carries no closed wording (closed / filled / expired / no longer accepting ...).
//   public ATS posting:   read through the board's public JSON (Greenhouse / Lever / Ashby). 404 or unlisted = closed. The board must be the lead's: its token equals the
//                         domain's name, or the posting itself names the company (never a board that merely exists). Another company's posting is rejected.
const norm = (x: string) => x.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and').replace(/\b(inc|ltd|llc|limited|plc|corp|co|the|gmbh)\b/g, ' ').replace(/[^a-z0-9]+/g, '')
type Json = { [k: string]: unknown }
const json = (b: string): Json | null => { try { return JSON.parse(b) } catch { return null } }
// The board's own publish date as a day (ISO string or epoch ms); anything else is unknown, never guessed.
const boardDay = (v: unknown): string | null => { const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null }
export type JobVerdict = { ok: true; text: string; title: string; posted?: string | null; postedBoard?: 'greenhouse' | 'lever' | 'ashby' | null; passages?: string[]; names?: string[] } | { ok: false; reason: 'job_closed' | 'job_company_mismatch' | 'job_unverified' | 'job_role_mismatch' }
// The role comes from the POSTING itself (its JSON title or its own heading), never from the index label. It must be a sales / GTM role and agree with what the index
// claimed: same role once locations / levels after a dash, pipe, comma or bracket are dropped ("Account Executive - London" ~ "Account Executive"); a different role
// behind the same link (a Backend Engineer behind "Account Executive") is rejected.
const coreRole = (t: string) => norm2(t.split(/\s[-\u2013\u2014|\u00b7]\s|\s*[,(\[]/)[0] ?? t)
const norm2 = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
export function roleAgrees(indexTitle: string, postingTitle: string, accept?: (title: string) => boolean): boolean {
  if (!isGtmRole(postingTitle) && !accept?.(postingTitle)) return false
  const a = coreRole(indexTitle), b = coreRole(postingTitle)
  if (!a || !b) return false
  if (a === b) return true
  const wa = new Set(a.split(' ')), wb = new Set(b.split(' '))
  const sub = (x: Set<string>, y: Set<string>) => [...x].every(w => y.has(w))
  return sub(wa, wb) || sub(wb, wa)
}
async function verifyAtsJob(url: URL, get: Get, site: string, company: string | undefined, indexTitle: string, accept?: (title: string) => boolean): Promise<JobVerdict> {
  const host = url.hostname.toLowerCase(), segs = url.pathname.split('/').filter(Boolean), token = (segs[0] ?? '').toLowerCase()
  let title = '', body = '', open = false, posted: string | null = null, postedBoard: 'greenhouse' | 'lever' | 'ashby' | null = null
  // passages (#767 live check): the posting's OWN text fields, each one contiguous as the verifier's read of the board record renders it
  // (lib/sources/ats-posting.ts). `body` joins the title (and Greenhouse's company_name) onto the description for the closed / company checks;
  // that join appears nowhere on the posting, so a quote is never taken from it, only from inside one passage.
  let passages: string[] = []
  let boardName = '' // the company the board itself names (Greenhouse company_name): with the org token and the site's name, who "<company> is hiring" may be
  if (host.endsWith('greenhouse.io')) {
    const id = segs[2]; if (!id || segs[1] !== 'jobs') return { ok: false, reason: 'job_unverified' }
    const r = await get(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${id}`)
    if (!r) return { ok: false, reason: 'job_unverified' }; if (r.status === 404 || r.status === 410) return { ok: false, reason: 'job_closed' }
    const j = json(r.body); if (r.status >= 400 || !j || typeof j.title !== 'string') return { ok: false, reason: 'job_unverified' }
    title = j.title; body = `${j.title} ${j.company_name ?? ''} ${String(j.content ?? '')}`; passages = [htmlText(String(j.content ?? ''))]; boardName = typeof j.company_name === 'string' ? j.company_name : ''; open = true; posted = boardDay(j.first_published); postedBoard = 'greenhouse'
  } else if (host === 'jobs.lever.co') {
    const id = segs[1]; if (!id) return { ok: false, reason: 'job_unverified' }
    const r = await get(`https://api.lever.co/v0/postings/${token}/${id}`)
    if (!r) return { ok: false, reason: 'job_unverified' }; if (r.status === 404 || r.status === 410) return { ok: false, reason: 'job_closed' }
    const j = json(r.body); if (r.status >= 400 || !j || typeof j.text !== 'string') return { ok: false, reason: 'job_unverified' }
    title = j.text; body = `${j.text} ${String(j.descriptionPlain ?? j.description ?? '')} ${String(j.additionalPlain ?? '')}`; passages = [plainText(j.descriptionPlain), ...leverLists(j.lists), plainText(j.additionalPlain)]; open = true; posted = boardDay(j.createdAt); postedBoard = 'lever'
  } else if (host === 'jobs.ashbyhq.com') {
    const id = segs[1]; if (!id) return { ok: false, reason: 'job_unverified' }
    const r = await get(`https://api.ashbyhq.com/posting-api/job-board/${token}`)
    if (!r || r.status >= 500) return { ok: false, reason: 'job_unverified' }; if (r.status === 404) return { ok: false, reason: 'job_closed' }
    const j = json(r.body); const jobs = Array.isArray(j?.jobs) ? j.jobs : null; if (!jobs) return { ok: false, reason: 'job_unverified' }
    const job = jobs.find((x: Json) => typeof x?.jobUrl === 'string' && x.jobUrl.split('/').filter(Boolean).pop() === id)
    if (!job || job.isListed !== true) return { ok: false, reason: 'job_closed' }
    title = String(job.title ?? ''); body = `${title} ${String(job.descriptionPlain ?? job.descriptionHtml ?? '')}`; passages = [plainText(job.descriptionPlain)]; open = true; posted = boardDay(job.publishedAt); postedBoard = 'ashby'
  } else return { ok: false, reason: 'job_unverified' }
  if (!open) return { ok: false, reason: 'job_unverified' }
  const plain = decode(body.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ')
  if (CLOSED.test(plain.slice(0, 1500))) return { ok: false, reason: 'job_closed' }
  const slug = norm(site.split('.')[0] ?? ''), tokenN = norm(token)
  const ownBoard = tokenN.length >= 3 && tokenN === slug
  const namesCompany = !!company && norm(company).length >= 3 && norm(plain).includes(norm(company))
  if (!ownBoard && !namesCompany) return { ok: false, reason: 'job_company_mismatch' }
  if (!roleAgrees(indexTitle, title, accept)) return { ok: false, reason: 'job_role_mismatch' } // the posting is a different role (or not a sales / GTM one) than the index claimed
  return { ok: true, text: plain.slice(0, 6000), title: title.slice(0, 120), posted, postedBoard: posted ? postedBoard : null, passages: passages.filter(p => p.length >= 20), names: [boardName, token, site.split('.')[0] ?? ''].filter(n => n.length >= 3) }
}
// Only the fields the verifier's read of the board record also renders as text: Ashby / Lever descriptionPlain (and Lever additionalPlain), Greenhouse content
// (escaped HTML), turned into text by the verifier's OWN functions (lib/scan/fetch-page.ts: htmlToText(decode(content))), so the quote source is byte-identical to
// the page the verifier checks. Ashby's descriptionHtml is never read there, so it is never quoted here.
const plainText = (v: unknown) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
// Lever's lists[] (responsibilities / requirements bullets), each heading and each content block on its own, rendered exactly as lib/sources/ats-posting.ts does
// (tags to spaces, no entity decoding)
const leverLists = (v: unknown): string[] => Array.isArray(v) ? v.flatMap(l => l && typeof l === 'object' ? [plainText((l as Json).text), plainText(typeof (l as Json).content === 'string' ? String((l as Json).content).replace(/<[^>]+>/g, ' ') : '')] : []) : []
const htmlText = (v: string) => htmlToText(decodeEntities(v)).text
async function verifyJob(hit: { title: string; jobUrl: string }, get: Get, site: string, company: string | undefined, robots: { allows: (p: string) => boolean }, accept?: (title: string) => boolean): Promise<JobVerdict> {
  let u: URL; try { u = new URL(hit.jobUrl) } catch { return { ok: false, reason: 'job_unverified' } }
  if (ATS_HOST.test(u.hostname.toLowerCase())) return verifyAtsJob(u, get, site, company, hit.title, accept)
  if (!robots.allows(u.pathname)) return { ok: false, reason: 'job_unverified' }
  const r = await get(u.toString())
  if (!r) return { ok: false, reason: 'job_unverified' }
  if (r.status === 404 || r.status === 410) return { ok: false, reason: 'job_closed' }
  if (r.status >= 400) return { ok: false, reason: 'job_unverified' }
  let f: URL; try { f = new URL(r.finalUrl) } catch { return { ok: false, reason: 'job_unverified' } }
  if (registrable(f.hostname) !== registrable(site)) return { ok: false, reason: 'job_company_mismatch' }
  const text = flat(r.body)
  if (CLOSED.test(text) || /\b(?:this )?(?:job|position|role|posting|vacancy) (?:is |has )?(?:closed|expired|no longer|been (?:filled|removed|closed))\b/i.test(text)) return { ok: false, reason: 'job_closed' }
  // redirected back to the index / a listing: the job is gone
  const indexPath = (() => { try { return new URL(hit.jobUrl).pathname } catch { return '' } })()
  if (f.pathname.replace(/\/$/, '') !== indexPath.replace(/\/$/, '') && !/job|role|position|opening|vacanc/i.test(f.pathname)) return { ok: false, reason: 'job_closed' }
  // the role is read from the page's OWN heading (h1, else <title>), never from the index label
  const heading = decode((/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(r.body)?.[1] ?? /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(r.body)?.[1] ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
  if (!heading) return { ok: false, reason: 'job_unverified' }
  if (!roleAgrees(hit.title, heading, accept)) return { ok: false, reason: 'job_role_mismatch' }
  return { ok: true, text, title: heading.slice(0, 120) }
}

// The quote is a verbatim passage of the posting. The default window (60 before the title, 160 after) can miss the company's name, and the source prompt needs a passage that
// names it: when the name is outside the window, widen to one span holding the title and the name if that fits in 300 characters. When it does not fit, there is
// no quote (''): a passage around the name alone would drop the vacancy it is cited for, so the caller skips it (quote_too_short) instead.
export function quoteFor(text: string, title: string, at: number, company?: string): string {
  const win = at >= 0 ? text.slice(Math.max(0, at - 60), at + title.length + 160) : title
  const name = company?.trim()
  if (!name || name.length < 3 || norm(win).includes(norm(name))) return win.slice(0, 300)
  const lt = text.toLowerCase(), ln = name.toLowerCase()
  if (lt.indexOf(ln) < 0) return win.slice(0, 300)
  if (at < 0) return ''
  // the mention nearest the title (the last one before it or the first one after it), not merely the first on the page (a header naming the company)
  let best = ''
  for (const ci of [lt.lastIndexOf(ln, at), lt.indexOf(ln, at)]) {
    if (ci < 0) continue
    const a = Math.max(0, Math.min(at, ci) - 20), b = Math.min(text.length, Math.max(at + title.length, ci + name.length) + 20)
    if (b - a <= 300 && (!best || b - a < best.length)) best = text.slice(a, b)
  }
  return best
}
// The quote for a public ATS posting (#767 live check: a quote glued the title onto the description's boilerplate preamble, "Sales Assist Representative AI AT
// ZAPIER At Zapier ...", which is on no page). It is a window inside ONE passage of the posting's own text, never across the title join, and it must be the
// posting stating THIS vacancy. The posting is the subject (we / we're / our ... team is / <company> is / join us / join <company> / join the team), the verb
// is hiring wording (hiring, looking for, looking to hire, seeking, recruiting ...), and the title or its core role follows after at most three filler words
// ("a new", "an experienced", never "a former"), with no further role noun after it ("Account Executive Manager" / "Assistant" / "Academy" is another thing).
// Also a sentence opening "As our new <title>" or "About the role: <title>", "we're hiring for the <title> role", and "We're hiring!" followed by a
// sentence that opens with the title. Anything else (customers / competitors "looking for", "Hiring an AE is hard", a passing title mention, another role)
// gives no quote (''): the careers source then offers no evidence for that posting, and the sales-hiring gate records the vacancy as on main.
// filler words between the verb and the title; `levels` are the seniority words allowed there (a level other than the posting's own is another role)
const fill = (levels: string) => String.raw`(?:(?:an?|our|the|one|two|three|four|five|several|multiple|\d+|new|next|first|experienced|driven|talented|motivated|${levels}|founding|ambitious|enthusiastic|dedicated|additional|another|full[- ]time|part[- ]time|remote|hybrid|in-house|seasoned|proven|exceptional|strong)[\s,]+){0,3}`
const LEVEL = /^(senior|sr\.?|junior|jr\.?|lead|principal|staff)\s+/i
const LEVEL_WORDS: Record<string, string> = { senior: String.raw`senior|sr\.?`, sr: String.raw`senior|sr\.?`, junior: String.raw`junior|jr\.?`, jr: String.raw`junior|jr\.?`, lead: 'lead', principal: 'principal', staff: 'staff' }
const VERB = String.raw`(?:hiring|looking\s+for|looking\s+to\s+hire|seeking|searching\s+for|in\s+search\s+of|recruiting)`
const ADV = String.raw`(?:(?:currently|actively|now|also|urgently)\s+)?`
const ROLE_TAIL = String.raw`(?:managers?|assistants?|leads?|engineers?|directors?|academy|associates?|coordinators?|specialists?|interns?|internship|trainees?|teams?|program|programme|platform|tools?|community|webinars?|head|officers?|partners?|consultants?|analysts?|operations|enablement|development|representatives?|executives?|reps?|sdrs?|bdrs?|vp|admin|administrators?)`
// (?!-\p{L}): not the first half of a hyphen compound ("Account Executive-led growth marketer")
const END = String.raw`(?!-\p{L})(?![\p{L}\p{N}])(?!\s*[-‐-—]?\s*${ROLE_TAIL}(?![\p{L}\p{N}]))`
const words = (t: string) => t.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
// company: the lead's name (the subject, and the name a namedQuote widens to); also: other names the posting may call itself by (board org, site name).
export function postingQuote(passages: string[], title: string, company?: string, nameInQuote = true, also: string[] = []): string {
  const core = title.split(/\s[-–—|·]\s|\s*[,(\[]/)[0]?.trim() ?? ''
  // the role without a leading level is the same vacancy ("We're looking for an Account Executive" on a Senior Account Executive posting)
  const unlevelled = [title, core].map(t => t.replace(/^(?:(?:senior|sr\.?|junior|jr\.?|lead|principal|staff|founding|mid[- ]level|entry[- ]level)\s+)+/i, '')).filter(t => words(t).length >= 2)
  const alts = [...new Set([title, core, ...unlevelled].filter(Boolean).map(t => words(t).join(String.raw`[\s\-‐-—_/]+`)).filter(Boolean))]
  if (!alts.length) return ''
  // a plural names the same role ("We're hiring two Account Executives")
  const T = `(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?:e?s)?${END}`
  // a posting with a level (Senior Account Executive) is not stated by a sentence naming another level (a Junior Account Executive); with no level, either is allowed
  const lv = LEVEL.exec(title)?.[1]?.toLowerCase().replace('.', '')
  const FILL = fill(lv ? LEVEL_WORDS[lv] ?? lv : String.raw`senior|sr\.?|junior|jr\.?`)
  const names = [...new Set([company ?? '', ...also].map(n => words(n).join(String.raw`\s+`)).filter(n => n.length >= 3))]
  const co = names.length ? `(?:${names.join('|')})` : null
  const WE = String.raw`(?:we(?:'|’)re|we\s+are|our\s+(?:[\p{L}-]+\s+){0,2}team\s+is${co ? String.raw`|${co}\s+(?:is|are)` : ''})`
  const JOIN = String.raw`join\s+(?:us|our\s+team|the\s+team${co ? `|${co}` : ''})(?:\s+[^.!?]{0,30}?)?\s+as`
  const re = (s: string) => new RegExp(s, 'iu')
  const inSentence = [
    re(String.raw`\b${WE}\s+${ADV}${VERB}\s+${FILL}${T}`),
    re(String.raw`\b${WE}\s+${ADV}hiring\s+for\s+(?:the|our|an?)\s+${T}\s+(?:role|position|opening|vacancy)\b`),
    re(String.raw`\b${JOIN}\s+${FILL}${T}`),
    re(String.raw`^\s*as\s+(?:our|an?|the)\s+(?:new\s+)?${T}`),
    re(String.raw`^\s*about\s+the\s+role\s*:?\s*${T}`),
  ]
  const bareHiring = re(String.raw`\b${WE}\s+${ADV}(?:hiring|recruiting)\s*[.!]+\s*$`), opensWithTitle = re(String.raw`^\s*${FILL}${T}`)
  for (const p of passages) {
    // "Sr." / "Jr." do not end a sentence
    const sentences = [...p.matchAll(/(?:\b(?:Sr|Jr)\.|[^.!?])+(?:[.!?]+|$)/gi)].map(m => ({ text: m[0], at: m.index ?? 0 }))
    for (let i = 0; i < sentences.length; i++) {
      const { text, at } = sentences[i]
      let from = -1, to = -1
      for (const r of inSentence) { const m = r.exec(text); if (m) { from = at + m.index; to = from + m[0].length; break } }
      if (from < 0 && bareHiring.test(text) && sentences[i + 1]) { // "We're hiring! Account Executive at Brightloop."
        const n = sentences[i + 1], m = opensWithTitle.exec(n.text)
        if (m) { from = at + (bareHiring.exec(text)?.index ?? 0); to = n.at + m.index + m[0].length }
      }
      if (from < 0) continue
      // the window spans the statement (from the sentence start when that is close), widened to the company name when the caller asks for it
      const span = p.slice(from, to), begin = Math.max(at + (text.length - text.trimStart().length), from - 60)
      const q = quoteFor(p.slice(begin), span, from - begin, nameInQuote ? company : undefined).trim()
      if (q.length >= 20 && q.includes(span.trim()) && p.includes(q)) return q
    }
  }
  return ''
}
// opts.namedQuote (the careers source adapter's evidence): when the posting names opts.company, the quote holds the title and that name or there is no quote;
// when the posting never names it, the quote is the plain title window. Without namedQuote (the sales-hiring gate) the quote is always the title window.
export async function careersSalesVacancy(domain: string, get: Get, opts: { now?: number; signal?: AbortSignal; company?: string; roleMatch?: (title: string) => boolean; firstPaths?: string[]; namedQuote?: boolean } = {}): Promise<CareersResult> {
  const site = domain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '')
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(site)) return { vacancy: null, reason: 'no_careers_page', pages: 0 }
  const origin = `https://${site}`
  const rob = await get(`${origin}/robots.txt`)
  // Only a clean 404 / 410 means "no robots policy". A blocked (401 / 403 / 429) or failing robots.txt is unreachable: never read around.
  if (!rob || rob.status >= 500 || (rob.status >= 400 && rob.status !== 404 && rob.status !== 410)) return { vacancy: null, reason: 'robots_unreachable', pages: 0 }
  const robots = rob.status >= 400 ? { allows: () => true } : parseRobots(rob.body, site)
  if (!robots.allows('/')) return { vacancy: null, reason: 'robots_disallow', pages: 0 }
  const paths = [...PATHS]
  const home = opts.signal?.aborted ? null : await get(`${origin}/`)
  if (home && home.status < 400) for (const m of home.body.matchAll(/href\s*=\s*["']([^"'#?]*(?:careers?|jobs|join(?:-us)?|work-with-us)[^"'#?]*)["']/gi)) {
    try { const u = new URL(m[1], home.finalUrl); if (registrable(u.hostname) === registrable(site) && !paths.includes(u.pathname)) paths.unshift(u.pathname) } catch { /* ignore */ }
  }
  for (const fp of [...(opts.firstPaths ?? [])].reverse()) if (/^\/[^\s]*$/.test(fp)) { const i = paths.indexOf(fp); if (i >= 0) paths.splice(i, 1); paths.unshift(fp) } // a path the user supplied is read first
  let pages = 0, readPages = 0, sawPage = false, closed = false, wrongDomain = false, verdict: CareersReason | null = null, generic: CareersVacancy | null = null, unquoted: CareersVacancy | null = null, unquotedMatch: CareersVacancy | null = null
  for (const p of paths) {
    if (pages >= MAX_PAGES || opts.signal?.aborted) break
    if (!robots.allows(p)) continue
    const r = await get(origin + p); pages++
    if (!r || r.status >= 400) continue
    let host = ''; try { host = new URL(r.finalUrl).hostname } catch { continue }
    if (registrable(host) !== registrable(site)) { wrongDomain = true; continue } // redirected to another site (an ATS board is checked by ats-gtm.ts)
    sawPage = true; readPages++
    const text = flat(r.body)
    // Closed-status wording is checked BEFORE any title is accepted: a page that says it is not hiring does not have a vacancy, whatever else it lists.
    if (CLOSED.test(text)) { closed = true; continue }
    const hits = openJobsFor(r.body, r.finalUrl, site, opts.roleMatch)
    if (hits.length === 0) continue // titles with no link to that specific job (team listings, alerts, newsletters) are mentions, not vacancies
    // The index link is never enough: the selected job's own page / posting is fetched and must prove the vacancy (open, this company's, still showing the role).
    // When the caller asks for a requested role, every verified hit (same cap of 3) is considered: the first whose POSTING title
    // source-matches wins; verified non-matching roles are remembered so generic careers hiring can be recorded without ever
    // being role-qualified, and 'no_matching_requested_role' names that outcome honestly instead of 'no_open_sales_role'.
    for (const hit of hits.slice(0, 3)) {
      const v = await verifyJob(hit, get, site, opts.company, robots, opts.roleMatch)
      if (!v.ok) { verdict = v.reason; continue }
      const shown = v.title, vt = v.text, at = vt.indexOf(shown)
      const vacancy: CareersVacancy = { url: hit.jobUrl.slice(0, 500), title: shown, quote: v.passages ? postingQuote(v.passages, shown, opts.company, !!opts.namedQuote, v.names) : quoteFor(vt, shown, at, opts.namedQuote ? opts.company : undefined), retrievedAt: Math.floor((opts.now ?? Date.now()) / 1000), pageText: `${text} ${v.text}`.slice(0, 6000), posted: v.posted ?? null, postedBoard: v.postedBoard ?? null }
      // a posting with no quotable statement never hides a later quotable one among this page's sampled hits (#767): it is kept as the fallback
      const quotable = vacancy.quote.trim() !== ''
      if (!opts.roleMatch) { if (quotable) return { vacancy, reason: 'found', pages, readPages }; unquoted ??= vacancy; continue }
      if (opts.roleMatch(shown)) { if (quotable) return { vacancy, reason: 'found', pages, readPages, matched: true }; unquotedMatch ??= vacancy; continue }
      if (!generic || (!generic.quote.trim() && quotable)) generic = vacancy
    }
    // no quotable one on this page: the first verified vacancy stands, as before (a missing quote only means no quote is offered)
    if (unquotedMatch) return { vacancy: unquotedMatch, reason: 'found', pages, readPages, matched: true }
    if (unquoted) return { vacancy: unquoted, reason: 'found', pages, readPages }
    // a generic find never ends a requested-role search: the remaining careers paths are still scanned (same MAX_PAGES
    // bound) before 'no_matching_requested_role' is claimed - the cap-3-per-page sample is annotated by the caller, never read as absence
    if (generic) continue
  }
  if (generic) return { vacancy: generic, reason: 'no_matching_requested_role', pages, readPages, matched: false }
  if (verdict) return { vacancy: null, reason: verdict, pages }
  return { vacancy: null, reason: closed ? 'closed_marker' : sawPage ? 'no_open_sales_role' : wrongDomain ? 'wrong_domain' : 'no_careers_page', pages }
}
