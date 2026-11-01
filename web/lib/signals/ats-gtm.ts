// Dated sales / go-to-market postings from a company's PUBLIC job board (Greenhouse, Lever, Ashby: keyless, read-only JSON).
// Why: a seed-funded lead is only half of "seed funding AND hiring sales". The board says, with the posting's own date, whether the
// company is hiring sales / GTM people. Evidence only (an enrichment beside the lead, never a verdict, never a date for the lead's event).
// Dates: Greenhouse `first_published` (detail call), Lever `createdAt`, Ashby `publishedAt`. `updated_at` is never a posting date.
// Identity: the board is FOUND by a token derived from the lead's domain (or, on Greenhouse, a board whose name equals the company's); finding it is not
// proof it is the company's. The caller scores it only when the domain is established or the postings name the lead's domain; every company domain named
// in the INCLUDED postings (all of them, several per posting) must be one and the same domain as the lead's, otherwise the board is contradictory: nothing.
import { classifyEntityMatch, domainSlug } from './entity-match.ts'

const TIMEOUT = 8000
export const WINDOW_DAYS = 90
const MAX_DETAIL = 4
const GTM = /\b(?:account\s+(?:executive|manager|director)s?|sales|business\s+development|bdrs?|sdrs?|revenue|go[-\s]to[-\s]market|gtm|growth|demand\s+gen(?:eration)?|customer\s+success|partnerships?|solutions?\s+(?:engineer|consultant)s?|head\s+of\s+(?:sales|growth|revenue|marketing)|vp\s+(?:of\s+)?(?:sales|revenue|growth|marketing))\b/i
const NOT_GTM = /\b(?:salesforce\s+(?:developer|engineer|architect|admin(?:istrator)?)|sales\s*tax|software\s+engineer|backend|front[-\s]?end|devops|data\s+scientist)\b/i
// A posting whose own text says it is closed is not open evidence, whatever the board still lists.
const POSTING_CLOSED = /\b(?:this (?:job|position|role|posting|vacancy) (?:is |has |was )?(?:closed|filled|expired|been (?:filled|closed|removed))|no longer (?:accepting applications|available|open|hiring)|applications? (?:are |is )?closed|position (?:has been |is )?filled)\b/i
export const postingClosed = (text: unknown): boolean => typeof text === 'string' && POSTING_CLOSED.test(text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]+>/g, ' ').slice(0, 3000))
export const isGtmRole = (title: string): boolean => GTM.test(title) && !NOT_GTM.test(title)
export const BOARD_LABEL = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby' } as const

type LeverPosting = { text?: unknown; hostedUrl?: unknown; createdAt?: unknown; descriptionPlain?: unknown; description?: unknown; additionalPlain?: unknown; additional?: unknown; lists?: unknown; categories?: { location?: unknown }; updatedAt?: unknown }
type AshbyPosting = { isListed?: unknown; title?: unknown; jobUrl?: unknown; publishedAt?: unknown; updatedAt?: unknown; descriptionPlain?: unknown; descriptionHtml?: unknown; description?: unknown; location?: unknown }

export interface GtmPosting { title: string; date: string; url: string; location: string | null; updated?: string | null } // date = the posting's own publish date; updated = the board's last-edited date, shown as a label and never used as a date
export interface GtmHiring { board: 'greenhouse' | 'lever' | 'ashby'; postings: GtmPosting[]; newest: string; url: string; domain: string | null; via: 'domain' | 'board_name';
  allTitles: string[]; boardUrl: string; listedCount: number; titleFilter: 'all' | 'gtm' | 'role-match';
  // Breadth (#533): the UNFILTERED listing - every title on the board (deduped, cap 50) and its full pre-cap count.
  // The filtered sample can never answer 'was the requested role anywhere on this board'; the full listing can.
  allListed: string[]; listedCountAll: number } // allTitles: a BOUNDED SAMPLE (cap 50) of the roleOk titles on the board LISTING; listedCount is the full deduped count before the cap, so listedCount > allTitles.length means the sample is truncated and cannot prove a role absent (#533); boardUrl: the listing page itself

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
// EVERY company domain the text names (a link or an e-mail host whose label is the board slug), registrable form. More than one distinct domain in one
// posting (brightloop.io and brightloop.com) is itself a contradiction the caller must treat as such.
export function domainsInText(text: string, slug: string): string[] {
  // Entities are decoded first (Greenhouse sends escaped HTML), then tags are NOT stripped: a link's href is read as well as the visible text, so a posting
  // that says brightloop.io while its company-website link points to brightloop.com names both.
  const raw = text.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;|&#34;|&#x22;/gi, '"').replace(/&#39;|&#x27;|&apos;/gi, "'").replace(/&amp;/gi, '&')
  const hosts: string[] = []
  for (const m of raw.matchAll(/(?:https?:\/\/(?:www\.)?|@)([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi)) hosts.push(m[1])
  for (const m of raw.matchAll(/\bhref\s*=\s*["']?\s*(?:mailto:[^"'\s>@]*@|(?:https?:)?\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi)) hosts.push(m[1])
  for (const m of raw.replace(/<[^>]*>/g, ' ').matchAll(/(?<![a-z0-9@./-])(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?![a-z0-9-])/gi)) hosts.push(m[1]) // a bare domain in the visible text
  const out = new Set<string>()
  for (const h of hosts) {
    const labels = h.toLowerCase().split('.')
    if (!labels.some(l => l.replace(/[^a-z0-9]/g, '') === slug)) continue
    const reg = labels.length >= 3 && /^(?:co|com|org|ac)$/.test(labels[labels.length - 2]) ? labels.slice(-3).join('.') : labels.slice(-2).join('.')
    if (reg.length >= 4) out.add(reg)
  }
  return [...out]
}
// Every representation a posting supplies (plain text AND html, whatever the board calls them) is read and the domains are unioned: HTML is never only a
// fallback for a missing plain field, so a link that disagrees with the plain text is still seen.
const fieldDomains = (fields: unknown[], slug: string): string[] => [...new Set(fields.flatMap(f => (typeof f === 'string' ? domainsInText(f, slug) : [])))]
export const domainInText = (text: string, slug: string): string | null => domainsInText(text, slug)[0] ?? null
// The domains the included postings named: none = no claim; exactly one that agrees with the lead's (or the lead has none) = that domain; more than one,
// or one that is not the lead's = contradictory (false): the board cannot corroborate this company.
function settle(seen: Set<string>, leadDomain: string | null): string | null | false {
  if (seen.size === 0) return null
  if (seen.size > 1) return false
  const d = [...seen][0]
  return leadDomain && !sameDomain(d, leadDomain) ? false : d
}
const sameDomain = (a: string, b: string) => a.replace(/^www\./, '').toLowerCase() === b.replace(/^www\./, '').toLowerCase()

export async function atsGtmHiring(company: string, domain: string | null, fetchImpl: typeof fetch = fetch, opts: { now?: number; windowDays?: number; roleMatch?: (title: string) => boolean } = {}): Promise<GtmHiring | null> {
  return (await atsGtmBoard(company, domain, fetchImpl, opts)).hiring
}
// Same lookup, but says when the board's included postings name contradictory company domains: the caller must then not use ANY board evidence for the
// company (including the older open-role count), not just this one.
// #533 review (F-B): a successfully fetched, attributed board LISTING whose titles pass no freshness/role filter
// used to collapse to the same null as "fetch failed" or "no board", leaving zero-match checks with no stored trace.
// `checked` carries that listing outcome so callers can store an honest zero-match audit + coverage trail.
export interface CheckedListing { board: GtmHiring['board']; boardUrl: string; allTitles: string[]; listedCount: number; titleFilter: GtmHiring['titleFilter']; via: 'domain' | 'board_name'; domain: string | null; allListed: string[]; listedCountAll: number;
  // F-E (review): freshness is per-title knowledge, not a blanket claim. rawTotal = roleOk listing entries; rawDatedStale = entries whose
  // posting date was actually READ and is outside the window; rawUnread = entries never date-checked (detail fetch failed/absent, beyond the
  // detail cap, or no date in the payload); rawFreshExcluded = fresh entries excluded for another reason (closed / unusable) - outside any
  // 0-fresh claim. datedStale = the stored (capped) titles known stale, for per-title row labels. "0 fresh" may only be claimed when
  // rawUnread = rawFreshExcluded = 0 and rawDatedStale = rawTotal. }
  rawTotal: number; rawDatedStale: number; rawUnread: number; rawFreshExcluded: number; datedStale: string[] }
export async function atsGtmBoard(company: string, domain: string | null, fetchImpl: typeof fetch = fetch, opts: { now?: number; windowDays?: number; roleMatch?: (title: string) => boolean } = {}): Promise<{ hiring: GtmHiring | null; contradictory: boolean; checked?: CheckedListing | null }> {
  const roleOk = opts.roleMatch ?? isGtmRole
  const titleFilter: GtmHiring['titleFilter'] = opts.roleMatch ? 'role-match' : 'gtm'
  const now = opts.now ?? Date.now(), win = (opts.windowDays ?? WINDOW_DAYS) * 86_400_000
  const fresh = (d: string | null) => !!d && now - Date.parse(d) <= win && Date.parse(d) <= now + 86_400_000
  const slug = domainSlug(domain)
  const bareName = company.toLowerCase().replace(/[^a-z0-9]/g, '')
  const slugs = [...new Set([slug, bareName.length >= 3 ? bareName : null].filter((x): x is string => !!x))].slice(0, 2)
  let checked: CheckedListing | null = null // first attributed listing fetched this lookup; probe order and signal paths unchanged
  for (const token of slugs) {
    const viaDomain = !!slug && token === slug
    // --- Greenhouse: list (titles) -> detail for the GTM ones (the date lives only on the detail) ---
    const gh = await get(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`, fetchImpl)
    if (Array.isArray(gh?.jobs)) {
      let nameOk = viaDomain
      if (!nameOk) { const b = await get(`https://boards-api.greenhouse.io/v1/boards/${token}`, fetchImpl); nameOk = typeof b?.name === 'string' && classifyEntityMatch(company, b.name) === 'heuristic' }
      if (nameOk && gh.jobs.length === 0 && !checked) checked = { board: 'greenhouse', boardUrl: `https://boards.greenhouse.io/${token}`, allTitles: [], listedCount: 0, titleFilter, via: viaDomain ? 'domain' : 'board_name', domain: null, rawTotal: 0, rawDatedStale: 0, rawUnread: 0, rawFreshExcluded: 0, datedStale: [], allListed: [], listedCountAll: 0 }
      if (nameOk && gh.jobs.length > 0) {
        const ghAllTitles = gh.jobs.filter((x: { title?: unknown }) => typeof x?.title === 'string').map((x: { title: string }) => x.title)
        const ghAll = dedupeTitles(ghAllTitles), ghAllCount = new Set(ghAllTitles.map((t: string) => t.trim().toLowerCase())).size
        const ghTitles = gh.jobs.filter((x: { title?: unknown }) => typeof x?.title === 'string' && roleOk(x.title as string)).map((x: { title: string }) => x.title)
        const listTitles = dedupeTitles(ghTitles)
        const postings: GtmPosting[] = []; const seen = new Set<string>()
        // F-E: GH dates live ONLY on per-job detail fetches (capped at MAX_DETAIL). Track exactly which listing entries had a date read,
        // which were fresh-but-excluded, and which were never date-checked - the zero-match trail may claim freshness only for the first set.
        const detailable = gh.jobs.filter((x: { id?: unknown; title?: unknown }) => Number.isInteger(x?.id) && typeof x.title === 'string' && roleOk(x.title))
        let rawDatedStale = 0, rawUnread = ghTitles.length - detailable.length + Math.max(0, detailable.length - MAX_DETAIL), rawFreshExcluded = 0
        const datedStaleTitles = new Set<string>()
        for (const j of detailable.slice(0, MAX_DETAIL)) {
          const det = await get(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${j.id}`, fetchImpl)
          const date = day(det?.first_published), url = typeof det?.absolute_url === 'string' ? det.absolute_url : ''
          const title = String(det?.title ?? j.title).slice(0, 120)
          if (!det || !date) { rawUnread++; continue }                                          // date never read: freshness unknown, no claim
          if (!fresh(date)) { rawDatedStale++; datedStaleTitles.add(title.trim().toLowerCase()); continue } // date read: older than the window
          if (!url.startsWith('https://') || !roleOk(title) || postingClosed(det?.content)) { rawFreshExcluded++; continue } // fresh but unusable: outside any 0-fresh claim
          for (const d of fieldDomains([det.content, det.description], token)) seen.add(d)   // every included posting is examined, and every domain in it
          postings.push({ title, date: date!, url, location: typeof det?.location?.name === 'string' ? det.location.name : null, updated: day(det?.updated_at) })
        }
        const found = settle(seen, domain); if (found === false) return { hiring: null, contradictory: true } // the postings name more than one company site, or another company's: contradictory, fail closed
        if (postings.length) return { hiring: build('greenhouse', postings, `https://boards.greenhouse.io/${token}`, found, viaDomain ? 'domain' : 'board_name', listTitles, new Set(ghTitles.map((t: string) => t.trim().toLowerCase())).size, titleFilter, ghAll, ghAllCount), contradictory: false, checked: null }
        if (!checked) checked = { board: 'greenhouse', boardUrl: `https://boards.greenhouse.io/${token}`, allTitles: listTitles, listedCount: new Set(ghTitles.map((t: string) => t.trim().toLowerCase())).size, titleFilter, via: viaDomain ? 'domain' : 'board_name', domain: found, rawTotal: ghTitles.length, rawDatedStale, rawUnread, rawFreshExcluded, datedStale: listTitles.filter(t => datedStaleTitles.has(t.trim().toLowerCase())), allListed: ghAll, listedCountAll: ghAllCount }
      }
    }
    // Lever and Ashby carry no company name in the payload: only a domain-derived token counts.
    if (!viaDomain) continue
    const lever = await get(`https://api.lever.co/v0/postings/${token}?mode=json`, fetchImpl)
    if (Array.isArray(lever) && lever.length === 0 && !checked) checked = { board: 'lever', boardUrl: `https://jobs.lever.co/${token}`, allTitles: [], listedCount: 0, titleFilter, via: 'domain', domain: null, rawTotal: 0, rawDatedStale: 0, rawUnread: 0, rawFreshExcluded: 0, datedStale: [], allListed: [], listedCountAll: 0 }
    if (Array.isArray(lever) && lever.length > 0) {
      const seen = new Set<string>()
      const leverAllTitles = lever.filter((j: LeverPosting) => typeof j?.text === 'string').map((j: { text: string }) => j.text)
      const lvAll = dedupeTitles(leverAllTitles), lvAllCount = new Set(leverAllTitles.map((t: string) => t.trim().toLowerCase())).size
      const leverTitles = lever.filter((j: LeverPosting) => typeof j?.text === 'string' && roleOk(j.text)).map((j: { text: string }) => j.text)
      const listTitles = dedupeTitles(leverTitles)
      // Lever carries createdAt in the LISTING, so every entry's date is read - but a fresh entry excluded as closed/unusable is still outside any 0-fresh claim.
      let lvDatedStale = 0, lvUnread = 0, lvFreshExcluded = 0; const lvStaleTitles = new Set<string>()
      for (const j of lever.filter((x: LeverPosting) => typeof x?.text === 'string' && roleOk(x.text))) { const dt = day(j.createdAt); if (!dt) lvUnread++; else if (!fresh(dt)) { lvDatedStale++; lvStaleTitles.add(j.text.slice(0, 120).trim().toLowerCase()) } else if (!(typeof j.hostedUrl === 'string' && j.hostedUrl.startsWith('https://')) || postingClosed(j.descriptionPlain ?? j.description)) lvFreshExcluded++ }
      const postings = dedupe(lever.filter((j: LeverPosting): j is LeverPosting & { text: string; hostedUrl: string } => typeof j?.text === 'string' && roleOk(j.text) && typeof j.hostedUrl === 'string' && j.hostedUrl.startsWith('https://') && fresh(day(j.createdAt)) && !postingClosed(j.descriptionPlain ?? j.description))
        .slice(0, MAX_DETAIL).map((j: LeverPosting & { text: string; hostedUrl: string }) => { for (const d of fieldDomains([j.descriptionPlain, j.description, j.additionalPlain, j.additional, ...(Array.isArray(j.lists) ? (j.lists as { text?: unknown; content?: unknown }[]).flatMap((l) => [l?.text, l?.content]) : [])], token)) seen.add(d); return { title: j.text.slice(0, 120), date: day(j.createdAt)!, url: j.hostedUrl, location: typeof j?.categories?.location === 'string' ? j.categories.location : null, updated: day(j.updatedAt) } }))
      const found = settle(seen, domain); if (found === false) return { hiring: null, contradictory: true }
      if (postings.length) return { hiring: build('lever', postings, `https://jobs.lever.co/${token}`, found, 'domain', listTitles, new Set(leverTitles.map((t: string) => t.trim().toLowerCase())).size, titleFilter, lvAll, lvAllCount), contradictory: false, checked: null }
      if (!checked) checked = { board: 'lever', boardUrl: `https://jobs.lever.co/${token}`, allTitles: listTitles, listedCount: new Set(leverTitles.map((t: string) => t.trim().toLowerCase())).size, titleFilter, via: 'domain', domain: found, rawTotal: leverTitles.length, rawDatedStale: lvDatedStale, rawUnread: lvUnread, rawFreshExcluded: lvFreshExcluded, datedStale: listTitles.filter(t => lvStaleTitles.has(t.trim().toLowerCase())), allListed: lvAll, listedCountAll: lvAllCount }
    }
    const ashby = await get(`https://api.ashbyhq.com/posting-api/job-board/${token}`, fetchImpl)
    if (Array.isArray(ashby?.jobs) && ashby.jobs.length === 0 && !checked) checked = { board: 'ashby', boardUrl: `https://jobs.ashbyhq.com/${token}`, allTitles: [], listedCount: 0, titleFilter, via: 'domain', domain: null, rawTotal: 0, rawDatedStale: 0, rawUnread: 0, rawFreshExcluded: 0, datedStale: [], allListed: [], listedCountAll: 0 }
    if (Array.isArray(ashby?.jobs) && ashby.jobs.length > 0) {
      const seen = new Set<string>()
      const ashbyAllTitles = ashby.jobs.filter((j: AshbyPosting) => j?.isListed === true && typeof j.title === 'string').map((j: { title: string }) => j.title)
      const abAll = dedupeTitles(ashbyAllTitles), abAllCount = new Set(ashbyAllTitles.map((t: string) => t.trim().toLowerCase())).size
      const ashbyTitles = ashby.jobs.filter((j: AshbyPosting) => j?.isListed === true && typeof j.title === 'string' && roleOk(j.title)).map((j: { title: string }) => j.title)
      const listTitles = dedupeTitles(ashbyTitles)
      let abDatedStale = 0, abUnread = 0, abFreshExcluded = 0; const abStaleTitles = new Set<string>()
      for (const j of ashby.jobs.filter((x: AshbyPosting) => x?.isListed === true && typeof x.title === 'string' && roleOk(x.title))) { const dt = day(j.publishedAt); if (!dt) abUnread++; else if (!fresh(dt)) { abDatedStale++; abStaleTitles.add(j.title.slice(0, 120).trim().toLowerCase()) } else if (!(typeof j.jobUrl === 'string' && j.jobUrl.startsWith('https://')) || postingClosed(j.descriptionPlain ?? j.descriptionHtml)) abFreshExcluded++ }
      const postings = dedupe(ashby.jobs.filter((j: AshbyPosting): j is AshbyPosting & { title: string; jobUrl: string } => j?.isListed === true && typeof j.title === 'string' && roleOk(j.title) && typeof j.jobUrl === 'string' && j.jobUrl.startsWith('https://') && fresh(day(j.publishedAt)) && !postingClosed(j.descriptionPlain ?? j.descriptionHtml))
        .slice(0, MAX_DETAIL).map((j: AshbyPosting & { title: string; jobUrl: string }) => { for (const d of fieldDomains([j.descriptionPlain, j.descriptionHtml, j.description], token)) seen.add(d); return { title: j.title.slice(0, 120), date: day(j.publishedAt)!, url: j.jobUrl, location: typeof j.location === 'string' ? j.location : null, updated: day(j.updatedAt) } }))
      const found = settle(seen, domain); if (found === false) return { hiring: null, contradictory: true }
      if (postings.length) return { hiring: build('ashby', postings, `https://jobs.ashbyhq.com/${token}`, found, 'domain', listTitles, new Set(ashbyTitles.map((t: string) => t.trim().toLowerCase())).size, titleFilter, abAll, abAllCount), contradictory: false, checked: null }
      if (!checked) checked = { board: 'ashby', boardUrl: `https://jobs.ashbyhq.com/${token}`, allTitles: listTitles, listedCount: new Set(ashbyTitles.map((t: string) => t.trim().toLowerCase())).size, titleFilter, via: 'domain', domain: found, rawTotal: ashbyTitles.length, rawDatedStale: abDatedStale, rawUnread: abUnread, rawFreshExcluded: abFreshExcluded, datedStale: listTitles.filter(t => abStaleTitles.has(t.trim().toLowerCase())), allListed: abAll, listedCountAll: abAllCount }
    }
  }
  return { hiring: null, contradictory: false, checked }
}

function build(board: GtmHiring['board'], postings: GtmPosting[], boardUrl: string, domain: string | null, via: GtmHiring['via'], allTitles: string[] = [], listedCount = allTitles.length, titleFilter: GtmHiring['titleFilter'] = 'gtm', allListed: string[] = allTitles, listedCountAll = listedCount): GtmHiring {
  const sorted = [...postings].sort((a, b) => (a.date < b.date ? 1 : -1))
  return { board, postings: sorted, newest: sorted[0].date, url: sorted.length === 1 ? sorted[0].url : boardUrl, domain, via, allTitles, boardUrl, listedCount, titleFilter, allListed, listedCountAll }
}

// One evidence row PER posting (up to 3, newest first): role title, the posting's own URL, its publish date, the board and location, and when dazl read it.
// `unconfirmedNote` (set when the board is not established as the lead's) prefixes the value, leads the label and drops the confidence, exactly like the aggregate row. The update date, if the
// board has one, only appears in the label.
// Case-insensitive distinct titles, each capped, the list itself bounded: the audit trail stays complete without
// letting a pathological board write unbounded rows.
export function dedupeTitles(titles: string[], cap = 50): string[] {
  const seen = new Set<string>(); const out: string[] = []
  for (const t of titles) { const v = t.trim().slice(0, 120); const k = v.toLowerCase(); if (!v || seen.has(k)) continue; seen.add(k); out.push(v); if (out.length === cap) break }
  return out
}
// #533: one audit row per board-listing title NOT already stored as a per-posting evidence row, so a later review can
// answer "was the requested role anywhere on this board" from stored evidence instead of a top-3 sample. These rows
// carry no confidence and no posting date (the listing does not give one); they are an audit trail, not a signal.
// One coverage row per pass: how many titles the listing held vs how many audit rows were stored, and which filter
// was applied. A truncated or filtered sample can NEVER prove a role absent from the whole board (#533 review note).
export const COVERAGE_LABEL = 'Coverage of the stored hiring audit sample; not a hiring signal; audit rows are per-pass - the same title can appear once under each pass connector'
export function boardCoverageRow(g: GtmHiring, stored: number, dated: number, retrievedAt: number, checkedDate: string): { connector: string; kind: string; value: string; label: string; confidence: number | null; source_url: string; source_date: string; retrieved_at: number } {
  const truncated = g.listedCount > g.allTitles.length
  const filterText = g.titleFilter === 'all' ? 'all listed titles' : g.titleFilter === 'gtm' ? 'sales/GTM-role titles only' : 'requested-role-matching titles only'
  return {
    connector: `signals:${g.board}-gtm`, kind: 'hiring-board-coverage',
    value: `Board listing: ${g.listedCount} ${filterText}: ${dated} dated posting rows + ${stored} more as audit rows${truncated ? '; sample TRUNCATED at 50 - a title beyond the sample is not disproved' : ''}`.slice(0, 254),
    label: COVERAGE_LABEL.slice(0, 200),
    confidence: null, source_url: g.boardUrl.slice(0, 500), source_date: checkedDate, retrieved_at: retrievedAt,
  }
}
export function boardTitleAudit(g: GtmHiring, retrievedAt: number, checkedDate: string, unconfirmedNote: string | null): { connector: string; kind: string; value: string; label: string; confidence: number | null; source_url: string; source_date: string; retrieved_at: number }[] {
  // F-A (review): postingEvidence stores only the top 3 dated rows, so only those titles are "covered";
  // a 4th detailed posting has no dated row and must get an audit row rather than vanish from both stores.
  const covered = new Set(g.postings.slice(0, 3).map(p => p.title.trim().toLowerCase()))
  return g.allTitles.filter(t => !covered.has(t.trim().toLowerCase())).map(t => ({
    connector: `signals:${g.board}-gtm`, kind: 'hiring-role',
    value: `${unconfirmedNote ? 'Unconfirmed: ' : ''}${t}`.slice(0, 254),
    label: [unconfirmedNote, `Board listing audit (${g.titleFilter === 'all' ? 'all listed titles' : g.titleFilter === 'gtm' ? 'sales/GTM titles only' : 'requested-role matches only'}): title listed on the board; its posting date was not read`].filter(Boolean).join('; ').slice(0, 200),
    confidence: null, source_url: g.boardUrl.slice(0, 500), source_date: checkedDate, retrieved_at: retrievedAt,
  }))
}
// Zero-match trail (F-B): the listing was fetched and attributed, but nothing passed the freshness/role filter.
// Audit rows say exactly that - listed when checked, no fresh matching posting in the window, no dated row stored -
// and the coverage row records the zero so "board checked, nothing matching" is distinguishable from "never checked"
// (a fetch failure still stores nothing; that remaining gap is stated on the PR, not papered over).
export function checkedAuditRows(c: CheckedListing, windowDays: number, retrievedAt: number, checkedDate: string, unconfirmedNote: string | null): { connector: string; kind: string; value: string; label: string; confidence: number | null; source_url: string; source_date: string; retrieved_at: number }[] {
  const filterText = c.titleFilter === 'gtm' ? 'sales/GTM titles only' : 'requested-role matches only'
  const stale = new Set(c.datedStale.map(t => t.trim().toLowerCase()))
  return c.allTitles.map(t => ({
    connector: `signals:${c.board}-gtm`, kind: 'hiring-role',
    value: `${unconfirmedNote ? 'Unconfirmed: ' : ''}${t}`.slice(0, 254),
    label: [unconfirmedNote, stale.has(t.trim().toLowerCase())
      ? `Board listing audit (${filterText}): posting date read as older than the last ${windowDays} days (long-open; repost history unknown); no dated evidence row was stored`
      : `Board listing audit (${filterText}): title listed on the board when checked; its posting date was not read - freshness unknown`].filter(Boolean).join('; ').slice(0, 200),
    confidence: null, source_url: c.boardUrl.slice(0, 500), source_date: checkedDate, retrieved_at: retrievedAt,
  }))
}
export function checkedCoverageRow(c: CheckedListing, windowDays: number, retrievedAt: number, checkedDate: string): { connector: string; kind: string; value: string; label: string; confidence: number | null; source_url: string; source_date: string; retrieved_at: number } {
  const truncated = c.listedCount > c.allTitles.length
  const filterText = c.titleFilter === 'gtm' ? 'sales/GTM-role titles only' : 'requested-role-matching titles only'
  const core = c.listedCount === 0
    ? `0 fresh postings in the last ${windowDays} days; 0 ${filterText} listed on an empty board listing`
    : c.rawUnread === 0 && c.rawFreshExcluded === 0 && c.rawDatedStale === c.rawTotal
      ? `0 fresh postings in the last ${windowDays} days across the full listing (${c.listedCount} ${filterText}, all posting dates read)`
      : `posting dates read for ${c.rawDatedStale + c.rawFreshExcluded} of ${c.rawTotal} listed postings${c.rawDatedStale || c.rawFreshExcluded ? ` (${[c.rawDatedStale ? `${c.rawDatedStale} older than the last ${windowDays} days` : '', c.rawFreshExcluded ? `${c.rawFreshExcluded} fresh but closed or unusable` : ''].filter(Boolean).join(', ')})` : ''}; the other ${c.rawTotal - c.rawDatedStale - c.rawFreshExcluded} were never date-read, so absence is not proven`
  return {
    connector: `signals:${c.board}-gtm`, kind: 'hiring-board-coverage',
    value: `Board checked: ${core}; ${c.allTitles.length} stored as audit rows${truncated ? '; sample TRUNCATED at 50 - a title beyond the sample is not disproved' : ''}`.slice(0, 254),
    label: COVERAGE_LABEL.slice(0, 200),
    confidence: null, source_url: c.boardUrl.slice(0, 500), source_date: checkedDate, retrieved_at: retrievedAt,
  }
}
// --- Repost / history labeling (AC4) -----------------------------------------------------------------------
// Without a stable employer posting ID or board-provided repost history, a changed posting date can NEVER prove a
// repost or renewed demand, and the same title on two boards can NEVER be proven the same posting. So history is
// attached as honest labels on the NEW rows; existing rows are never rewritten (the trail stays as recorded).
export interface ExistingEvidenceRow { kind: string; connector: string; value: string; source_date: string; retrieved_at: number }
// A job TITLE can itself contain ' - posted '; only a trailing, date-shaped suffix is the posting date (last occurrence).
const splitPosted = (value: string): [string, string | null] => {
  const i = value.lastIndexOf(' - posted ')
  if (i < 0) return [value, null]
  const d = value.slice(i + ' - posted '.length)
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? [value.slice(0, i), d] : [value, null]
}
const evidenceTitle = (value: string): string => splitPosted(value.replace(/^Unconfirmed: /, ''))[0].trim().toLowerCase()
const boardOf = (connector: string): string => connector.replace(/^signals:/, '').replace(/-gtm$/, '')
export function withRepostHistory<T extends { connector: string; kind: string; value: string; label: string }>(rows: T[], board: GtmHiring['board'], existing: ExistingEvidenceRow[]): T[] {
  const mine = `signals:${board}-gtm`
  return rows.map(r => {
    if (r.kind !== 'hiring' && r.kind !== 'hiring-role') return r
    const t = evidenceTitle(r.value)
    if (!t) return r
    const notes: string[] = []
    const thisDate = r.kind === 'hiring' ? splitPosted(r.value)[1] : null
    const priors = existing.filter(e => e.connector === mine && e.kind === 'hiring' && evidenceTitle(e.value) === t && splitPosted(e.value)[1] !== null && splitPosted(e.value)[1] !== thisDate)
    if (priors.length) {
      const dates = [...new Set(priors.map(e => splitPosted(e.value)[1]))].sort()
      const firstSeen = new Date(Math.min(...priors.map(e => e.retrieved_at)) * 1000).toISOString().slice(0, 10)
      // The qualifier leads: label truncation (200) can only drop the parenthetical detail, never the honest qualifier itself.
      notes.push(`repost vs continued listing unknown, not renewed demand (board previously dated ${dates.join(', ')}, first seen ${firstSeen})`)
    }
    const otherBoards = [...new Set(existing.filter(e => (e.kind === 'hiring' || e.kind === 'hiring-role') && boardOf(e.connector) !== board && evidenceTitle(e.value) === t).map(e => boardOf(e.connector)))].sort()
    if (otherBoards.length) notes.push(`same posting unknown (also listed on ${otherBoards.join(', ')})`)
    if (!notes.length) return r
    // The qualifier notes are the load-bearing part: when the combined label exceeds the 200-char cap, shorten the
    // PRE-EXISTING base context, never the notes - a truncated 'repost vs continued listing' without 'unknown, not
    // renewed demand' would be a misleading claim. (The base detail also survives on the other rows for this lead.)
    const full = [r.label, ...notes].join('; ')
    if (full.length <= 200) return { ...r, label: full }
    const suffix = notes.join('; ')
    const room = 200 - suffix.length - 2
    const base = room > 0 ? r.label.slice(0, room) : ''
    return { ...r, label: ((base ? base + '; ' : '') + suffix).slice(0, 200) }
  })
}
// Breadth (#533): the UNFILTERED listing audit. Filtered passes (GTM / role-match) answer their own question; only the
// full listing can answer 'was the requested role anywhere on this board' from stored evidence. Rows for titles already
// covered by dated or filtered rows collapse via ON CONFLICT (same lead/connector/kind/value), so overlap costs nothing.
export function fullListingAuditRows(board: GtmHiring['board'], boardUrl: string, allListed: string[], coveredTitles: Set<string>, retrievedAt: number, checkedDate: string, unconfirmedNote: string | null): { connector: string; kind: string; value: string; label: string; confidence: number | null; source_url: string; source_date: string; retrieved_at: number }[] {
  return allListed.filter(t => !coveredTitles.has(t.trim().toLowerCase())).map(t => ({
    connector: `signals:${board}-gtm`, kind: 'hiring-role',
    value: `${unconfirmedNote ? 'Unconfirmed: ' : ''}${t}`.slice(0, 254),
    label: [unconfirmedNote, 'Board listing audit (all listed titles): title listed on the board; its posting date was not read'].filter(Boolean).join('; ').slice(0, 200),
    confidence: null, source_url: boardUrl.slice(0, 500), source_date: checkedDate, retrieved_at: retrievedAt,
  }))
}
export function fullListingCoverageRow(board: GtmHiring['board'], boardUrl: string, listedCountAll: number, allListed: string[], dated: number, stored: number, retrievedAt: number, checkedDate: string): { connector: string; kind: string; value: string; label: string; confidence: number | null; source_url: string; source_date: string; retrieved_at: number } {
  const truncated = listedCountAll > allListed.length
  return {
    connector: `signals:${board}-gtm`, kind: 'hiring-board-coverage',
    value: `Board listing: ${listedCountAll} all listed titles: ${dated} dated posting rows + ${stored} more as audit rows${truncated ? '; sample TRUNCATED at 50 - a title beyond the sample is not disproved' : ''}`.slice(0, 254),
    label: COVERAGE_LABEL.slice(0, 200),
    confidence: null, source_url: boardUrl.slice(0, 500), source_date: checkedDate, retrieved_at: retrievedAt,
  }
}
export function postingEvidence(g: GtmHiring, retrievedAt: number, unconfirmedNote: string | null): { connector: string; kind: string; value: string; label: string; confidence: number | null; source_url: string; source_date: string; retrieved_at: number }[] {
  return g.postings.slice(0, 3).map(p => ({
    connector: `signals:${g.board}-gtm`, kind: 'hiring',
    value: `${unconfirmedNote ? 'Unconfirmed: ' : ''}${p.title} - posted ${p.date}`.slice(0, 254),
    label: [unconfirmedNote, p.location ?? 'location not stated', BOARD_LABEL[g.board], p.updated && p.updated !== p.date ? `board updated ${p.updated}` : null].filter(Boolean).join('; ').slice(0, 200),
    confidence: unconfirmedNote ? null : 70, source_url: p.url.slice(0, 500), source_date: p.date, retrieved_at: retrievedAt,
  }))
}
