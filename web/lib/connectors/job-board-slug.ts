// #1122/#1037: the employer's own slug on a job board. An aggregator posting (growthroles.com/jobs/war-room-business-development-...)
// names the company only as a slug, and links the employer's ATS posting (ats.rippling.com/war-room-careers/jobs/<id>). The ATS links and the
// aggregator's own company/job paths give slugs; a slug is kept only when it IS the company's name (folded, a careers/jobs tail removed),
// so another employer's ATS link on the same page is never used. Pure: no fetch. Kept out of sitecrawl.ts so it is tested on its own;
// crawlJob (sitecrawl.ts) uses it for a job-board lead that links no company site.
import { countryTlds } from './sitecrawl.ts'

// The same company-name fold as sitecrawl.ts's norm(): accents off, legal suffixes and "the" dropped, letters and digits only.
const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and').replace(/\b(inc|ltd|llc|limited|gmbh|ag|sa|sl|corp|corporation|co|company|plc|pty|group|holdings|the)\b/g, ' ').replace(/[^a-z0-9]+/g, '')

const ATS_SLUG: RegExp[] = [
  /^https?:\/\/ats\.(?:[a-z0-9]+\.)?rippling\.com\/([a-z0-9-]+)(?:\/|$)/i,
  /^https?:\/\/jobs\.(?:eu\.)?lever\.co\/([a-z0-9-]+)(?:\/|$)/i,
  /^https?:\/\/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([a-z0-9-]+)(?:\/|$)/i,
  /^https?:\/\/jobs\.ashbyhq\.com\/([a-z0-9-]+)(?:\/|$)/i,
  /^https?:\/\/apply\.workable\.com\/([a-z0-9-]+)(?:\/|$)/i,
  /^https?:\/\/(?:jobs|careers)\.smartrecruiters\.com\/([a-z0-9-]+)(?:\/|$)/i,
  /^https?:\/\/([a-z0-9-]+)\.(?:bamboohr\.com|breezy\.hr|recruitee\.com|teamtailor\.com|pinpointhq\.com)(?:\/|$)/i,
]
// Holds where the hold is the event itself being over (a closed job, a stale or out-of-window date, no event at all): identity cannot change them.
export const EVENT_OVER_HOLDS = new Set(['job_closed', 'outside_window', 'event_date_stale', 'no_event_evidence'])
const SLUG_TAIL = /-(careers|career|jobs|job|hiring|inc|ltd|llc|corp)$/
export function jobBoardSlugs(company: string, sourceUrl: string, html = ''): { slug: string; ats: string[] } {
  const want = norm(company)
  const none = { slug: '', ats: [] as string[] }
  if (want.length < 4) return none
  const nameSlug = company.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean).join('-')
  const fits = (raw: string) => { let s = raw.toLowerCase(); for (let i = 0; i < 2; i++) s = s.replace(SLUG_TAIL, ''); return norm(s.replace(/-/g, ' ')) === want }
  const ats: string[] = []
  let slug = ''
  // A direct ATS source already identifies its employer; do not fetch that same page twice.
  for (const re of ATS_SLUG) { const x = re.exec(sourceUrl); if (x && fits(x[1])) { slug = x[1].toLowerCase(); break } }
  for (const m of html.matchAll(/href\s*=\s*["'](https?:\/\/[^"'#\s]+)["']/gi)) {
    const u = m[1].replace(/&amp;/g, '&')
    for (const re of ATS_SLUG) { const x = re.exec(u); if (x && fits(x[1])) { if (u !== sourceUrl && !ats.includes(u) && ats.length < 2) ats.push(u); slug ||= x[1].toLowerCase(); break } }
  }
  // the aggregator's own paths: /companies/<slug> or /jobs/<slug>-<title>-<id>, where the slug is exactly the company's name
  try {
    const path = new URL(sourceUrl).pathname.toLowerCase()
    const seg = path.split('/').filter(Boolean)
    if (!slug && seg.length >= 2 && /^(jobs?|companies|company|employers?)$/.test(seg[0]) && nameSlug && (seg[1] === nameSlug || seg[1].startsWith(nameSlug + '-'))) slug = nameSlug
  } catch { /* unparseable source */ }
  if (!slug) for (const m of html.matchAll(/href\s*=\s*["'](?:https?:\/\/[^/"']+)?\/(?:companies|company|employers?)\/([a-z0-9-]+)["'\/?]/gi)) { if (fits(m[1])) { slug = m[1].toLowerCase(); break } }
  return { slug, ats }
}
// Domains a job-board slug points to: the folded slug (careers/jobs tail removed) at .com and the request country's TLD, plus the common
// company-site forms <slug>inc.com and <slug>hq.com ("War Room" lives at warroominc.com). Each is only a candidate: the crawl's homepage name
// check and place check decide.
export function slugDomains(slug: string, where: string[] = []): string[] {
  let s = slug.toLowerCase(); for (let i = 0; i < 2; i++) s = s.replace(SLUG_TAIL, '')
  const base = s.replace(/[^a-z0-9]/g, '')
  if (base.length < 4 || base.length > 30) return []
  return [...new Set([`${base}.com`, ...countryTlds(where).map(t => `${base}.${t}`), `${base}inc.com`, `${base}hq.com`])]
}
