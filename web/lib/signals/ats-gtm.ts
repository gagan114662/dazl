// Dated sales / go-to-market postings from a company's PUBLIC job board (Greenhouse, Lever, Ashby: keyless, read-only JSON).
// Why: a seed-funded lead is only half of "seed funding AND hiring sales". The board says, with the posting's own date, whether the
// company is hiring sales / GTM people. Evidence only (an enrichment beside the lead, never a verdict, never a date for the lead's event).
// Dates: Greenhouse `first_published` (detail call), Lever `createdAt`, Ashby `publishedAt`. `updated_at` is never a posting date.
// Identity: a board counts only when its token derives from the lead's own domain (heuristic, like atsHiring) or its Greenhouse board
// NAME is token-identical to the company; a company domain found in the postings must agree with the lead's domain.
import { classifyEntityMatch, domainSlug } from './entity-match.ts'

const TIMEOUT = 8000
const WINDOW_DAYS = 90
const MAX_DETAIL = 4
const GTM = /\b(?:account\s+(?:executive|manager|director)|sales|business\s+development|bdr|sdr|revenue|go[-\s]to[-\s]market|gtm|growth|demand\s+gen(?:eration)?|customer\s+success|partnerships?|solutions?\s+(?:engineer|consultant)|head\s+of\s+(?:sales|growth|revenue|marketing)|vp\s+(?:of\s+)?(?:sales|revenue|growth|marketing))\b/i
const NOT_GTM = /\b(?:salesforce\s+(?:developer|engineer|architect|admin(?:istrator)?)|sales\s*tax|software\s+engineer|backend|front[-\s]?end|devops|data\s+scientist)\b/i
export const isGtmRole = (title: string): boolean => GTM.test(title) && !NOT_GTM.test(title)

export interface GtmPosting { title: string; date: string; url: string; location: string | null }
export interface GtmHiring { board: 'greenhouse' | 'lever' | 'ashby'; postings: GtmPosting[]; newest: string; url: string; domain: string | null; via: 'domain' | 'board_name' }

const get = async (url: string, fetchImpl: typeof fetch): Promise<any> => {
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': 'dazl/1.0', accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT) })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}
const day = (v: unknown): string | null => {
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null
}
const dedupe = (xs: GtmPosting[]) => { const seen = new Set<string>(); return xs.filter(p => !seen.has(p.url) && !!seen.add(p.url)) }

// A company domain the postings themselves name: an https link or an e-mail host whose first label is the board slug.
export function domainInText(text: string, slug: string): string | null {
  const plain = text.replace(/&lt;|&gt;|&quot;|&amp;/g, ' ').replace(/<[^>]*>/g, ' ')
  for (const m of plain.matchAll(/(?:https?:\/\/(?:www\.)?|@)([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi)) {
    const host = m[1].toLowerCase()
    const labels = host.split('.')
    const registrable = labels.slice(-2).join('.') // good enough for the identity check; co.uk style hosts compare on their first label below
    if (labels.some(l => l.replace(/[^a-z0-9]/g, '') === slug)) return registrable.length >= 4 ? (labels.length >= 3 && /^(?:co|com|org|ac)$/.test(labels[labels.length - 2]) ? labels.slice(-3).join('.') : registrable) : null
  }
  return null
}
const sameDomain = (a: string, b: string) => a.replace(/^www\./, '').toLowerCase() === b.replace(/^www\./, '').toLowerCase()

export async function atsGtmHiring(company: string, domain: string | null, fetchImpl: typeof fetch = fetch, opts: { now?: number; windowDays?: number } = {}): Promise<GtmHiring | null> {
  const now = opts.now ?? Date.now(), win = (opts.windowDays ?? WINDOW_DAYS) * 86_400_000
  const fresh = (d: string | null) => !!d && now - Date.parse(d) <= win && Date.parse(d) <= now + 86_400_000
  const slug = domainSlug(domain)
  const bareName = company.toLowerCase().replace(/[^a-z0-9]/g, '')
  const slugs = [...new Set([slug, bareName.length >= 3 ? bareName : null].filter((x): x is string => !!x))].slice(0, 2)
  for (const token of slugs) {
    const viaDomain = !!slug && token === slug
    // --- Greenhouse: list (titles) -> detail for the GTM ones (the date lives only on the detail) ---
    const gh = await get(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`, fetchImpl)
    if (Array.isArray(gh?.jobs) && gh.jobs.length > 0) {
      let nameOk = viaDomain
      if (!nameOk) { const b = await get(`https://boards-api.greenhouse.io/v1/boards/${token}`, fetchImpl); nameOk = typeof b?.name === 'string' && classifyEntityMatch(company, b.name) === 'heuristic' }
      if (nameOk) {
        const postings: GtmPosting[] = []; let found: string | null = null
        for (const j of gh.jobs.filter((x: { id?: unknown; title?: unknown }) => Number.isInteger(x?.id) && typeof x.title === 'string' && isGtmRole(x.title)).slice(0, MAX_DETAIL)) {
          const det = await get(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${j.id}`, fetchImpl)
          const date = day(det?.first_published), url = typeof det?.absolute_url === 'string' ? det.absolute_url : ''
          if (!fresh(date) || !url.startsWith('https://')) continue
          found = found ?? domainInText(String(det.content ?? ''), token)
          postings.push({ title: String(det.title ?? j.title).slice(0, 120), date: date!, url, location: typeof det?.location?.name === 'string' ? det.location.name : null })
        }
        if (found && domain && !sameDomain(found, domain)) return null // the postings name another company's site: not this company
        if (postings.length) return build('greenhouse', postings, `https://boards.greenhouse.io/${token}`, found, viaDomain ? 'domain' : 'board_name')
      }
    }
    // Lever and Ashby carry no company name in the payload: only a domain-derived token counts.
    if (!viaDomain) continue
    const lever = await get(`https://api.lever.co/v0/postings/${token}?mode=json`, fetchImpl)
    if (Array.isArray(lever) && lever.length > 0) {
      let found: string | null = null
      const postings = dedupe(lever.filter((j: any) => typeof j?.text === 'string' && isGtmRole(j.text) && typeof j.hostedUrl === 'string' && j.hostedUrl.startsWith('https://') && fresh(day(j.createdAt)))
        .slice(0, MAX_DETAIL).map((j: any) => { found = found ?? domainInText(String(j.descriptionPlain ?? j.description ?? ''), token); return { title: j.text.slice(0, 120), date: day(j.createdAt)!, url: j.hostedUrl, location: typeof j?.categories?.location === 'string' ? j.categories.location : null } }))
      if (found && domain && !sameDomain(found, domain)) return null
      if (postings.length) return build('lever', postings, `https://jobs.lever.co/${token}`, found, 'domain')
    }
    const ashby = await get(`https://api.ashbyhq.com/posting-api/job-board/${token}`, fetchImpl)
    if (Array.isArray(ashby?.jobs) && ashby.jobs.length > 0) {
      let found: string | null = null
      const postings = dedupe(ashby.jobs.filter((j: any) => j?.isListed === true && typeof j.title === 'string' && isGtmRole(j.title) && typeof j.jobUrl === 'string' && j.jobUrl.startsWith('https://') && fresh(day(j.publishedAt)))
        .slice(0, MAX_DETAIL).map((j: any) => { found = found ?? domainInText(String(j.descriptionPlain ?? j.descriptionHtml ?? ''), token); return { title: j.title.slice(0, 120), date: day(j.publishedAt)!, url: j.jobUrl, location: typeof j.location === 'string' ? j.location : null } }))
      if (found && domain && !sameDomain(found, domain)) return null
      if (postings.length) return build('ashby', postings, `https://jobs.ashbyhq.com/${token}`, found, 'domain')
    }
  }
  return null
}

function build(board: GtmHiring['board'], postings: GtmPosting[], boardUrl: string, domain: string | null, via: GtmHiring['via']): GtmHiring {
  const sorted = [...postings].sort((a, b) => (a.date < b.date ? 1 : -1))
  return { board, postings: sorted, newest: sorted[0].date, url: sorted.length === 1 ? sorted[0].url : boardUrl, domain, via }
}
