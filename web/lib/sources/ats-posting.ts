// #533: a job posting on a public ATS board (Ashby, Greenhouse, Lever), read from the board's own public API record and
// never from the posting page. The page is a JavaScript app that a plain read sees as a thin shell or a bot wall (live
// check on staging 2026-11-12: two Ashby postings held as "blocked_by_site" with no date, although the board's API
// stated publishedAt 2026-10-15 / 2026-10-19), and lib/legal/policy.ts already promises that board URLs "are parsed and
// translated to" the API hosts, never fetched.
//
// The verifier's page fetcher (lib/scan/fetch-page.ts) reads the record for a posting URL and renders it as the page:
// the title, location, the board's own first-published day and the posting's text. That day is the posting's own
// structured publish date for exactly this URL (the #460 contract: Greenhouse first_published, Ashby publishedAt, Lever
// createdAt; never updated_at), so a hiring candidate cited to this URL can be dated by it (lib/scan/runner.ts).
// A posting the board no longer lists is "not found" (a closed posting), never a guess.
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export type AtsKind = 'ashby' | 'greenhouse' | 'lever'
export interface AtsPostingRef { kind: AtsKind; org: string; id: string }

// The posting a URL names, or null. Only the documented posting shapes:
//   https://jobs.ashbyhq.com/{org}/{uuid}[/application]
//   https://boards.greenhouse.io/{org}/jobs/{number}, https://job-boards.greenhouse.io/{org}/jobs/{number}
//   (EU-hosted Greenhouse boards are not claimed: their API host is not one the policy lists, so they keep the page read)
//   https://jobs.lever.co/{org}/{uuid}[/apply]
// Query strings (?action=apply, utm_...) and a trailing slash are ignored; anything else is not a posting.
export function atsPostingRef(raw: string): AtsPostingRef | null {
  let u: URL
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null
  const host = u.hostname.toLowerCase(), parts = u.pathname.split('/').filter(Boolean)
  if (host === 'jobs.ashbyhq.com' && (parts.length === 2 || (parts.length === 3 && parts[2] === 'application')) && TOKEN.test(parts[0]) && UUID.test(parts[1])) return { kind: 'ashby', org: parts[0], id: parts[1].toLowerCase() }
  if (/^(?:boards|job-boards)\.greenhouse\.io$/.test(host) && parts.length === 3 && parts[1] === 'jobs' && TOKEN.test(parts[0]) && /^\d{1,15}$/.test(parts[2])) return { kind: 'greenhouse', org: parts[0], id: parts[2] }
  if (host === 'jobs.lever.co' && (parts.length === 2 || (parts.length === 3 && parts[2] === 'apply')) && TOKEN.test(parts[0]) && UUID.test(parts[1])) return { kind: 'lever', org: parts[0], id: parts[1].toLowerCase() }
  return null
}

// The board's public API URL for the record (the hosts lib/legal/policy.ts lists as public sources). Ashby has no
// single-posting endpoint: its board endpoint lists the postings and the record is picked by id.
export function atsRecordUrl(r: AtsPostingRef): string {
  if (r.kind === 'ashby') return `https://api.ashbyhq.com/posting-api/job-board/${r.org}`
  if (r.kind === 'greenhouse') return `https://boards-api.greenhouse.io/v1/boards/${r.org}/jobs/${r.id}`
  return `https://api.lever.co/v0/postings/${r.org}/${r.id}?mode=json`
}
const RECORD_HOSTS = new Set(['api.ashbyhq.com', 'boards-api.greenhouse.io', 'api.lever.co'])
export const isAtsRecordUrl = (raw: string): boolean => { try { const u = new URL(raw); return u.protocol === 'https:' && RECORD_HOSTS.has(u.hostname) } catch { return false } }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')
// A posting's day: the UTC calendar day of the instant the board states (an ISO timestamp, offsets honoured, or Lever's
// epoch milliseconds). ONE rule for every path that dates a posting, the job-board source (lib/sources/jobboards.ts) and
// the board record read here, so the same posting gets the same day whichever path found it. Null for anything that is
// not a real date (the text must start with a valid calendar day) or is before 2000.
export function postingDay(v: unknown): string | null {
  let t: number
  if (typeof v === 'number') t = Number.isFinite(v) ? v : NaN
  else if (typeof v === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim()); if (!m) return null
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null
    // a time without a zone is read as UTC, never as this server's local time
    const iso = v.trim(), zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) || !/T\d/.test(iso)
    t = Date.parse(zoned ? iso : `${iso}Z`)
  } else return null
  const at = new Date(t) // out of the Date range (e.g. 1e16 ms) is not a date, never a throw
  if (!Number.isFinite(t) || Number.isNaN(at.getTime())) return null
  const day = at.toISOString().slice(0, 10)
  return +day.slice(0, 4) >= 2000 ? day : null
}
const BOARD: Record<AtsKind, string> = { ashby: 'Ashby', greenhouse: 'Greenhouse', lever: 'Lever' }

// The record for exactly this posting: its title, location, first-published day (null when the record states none:
// an undated page, judged by the normal rules) and description (html: Greenhouse sends escaped HTML; the caller turns it
// into text). Null when the body is not this posting's record (another id, no title): read as a failed read.
// header: the posting page's own header fields, in the order the board's page shows them (#533 live check: candidate
// quotes are cut from that header, e.g. "<title> Location <x> Employment Type Full time")
// company: the employer's name as the board's record states it (#1126: Greenhouse company_name; the Ashby job-board and
// Lever postings APIs state none, checked against the live APIs 2026-11-13), '' when not stated. org is the board slug.
export interface AtsRecord { title: string; location: string; header: string; posted: string | null; description: string; html: boolean; board: string; org: string; company: string }
// 'missing': an Ashby board that answered but does not list this posting (closed or unlisted).
export function atsRecord(body: unknown, r: AtsPostingRef): AtsRecord | 'missing' | null {
  let job: Record<string, unknown> | null = null
  if (r.kind === 'ashby') {
    if (!isObj(body) || !Array.isArray(body.jobs)) return null
    // the posting with exactly this id; a jobUrl ending in it only when no posting has the id
    const jobs = body.jobs.filter(isObj)
    job = jobs.find(j => str(j.id).toLowerCase() === r.id) ?? jobs.find(j => str(j.jobUrl).toLowerCase().split(/[?#]/)[0].replace(/\/+$/, '').endsWith(`/${r.id}`)) ?? null
    if (!job || job.isListed === false) return 'missing'
    // listed only when the board says so (true), as the job-board source reads it; any other value proves nothing
    if (job.isListed !== true) return null
  } else if (isObj(body)) job = body
  if (!job) return null
  if (r.kind === 'greenhouse' && String(job.id ?? '') !== r.id) return null
  if (r.kind === 'lever' && str(job.id).toLowerCase() !== r.id) return null
  const title = str(r.kind === 'lever' ? job.text : job.title)
  // the documented first-published fields only; updated_at is never a posting date
  const posted = postingDay(r.kind === 'ashby' ? job.publishedAt : r.kind === 'greenhouse' ? job.first_published : job.createdAt)
  if (!title) return null
  const location = r.kind === 'greenhouse' ? str(isObj(job.location) ? job.location.name : '') : r.kind === 'lever' ? str(isObj(job.categories) ? job.categories.location : '') : str(job.location)
  // Lever keeps the responsibilities / requirements bullets in lists[] and the closing text in additionalPlain: all of
  // the posting's own text is read, so a quote from a bullet is found
  const lever = r.kind === 'lever' ? [
    ...(Array.isArray(job.lists) ? job.lists.flatMap(l => isObj(l) ? [str(l.text), str(typeof l.content === 'string' ? l.content.replace(/<[^>]+>/g, ' ') : '')] : []) : []),
    str(job.additionalPlain),
  ].filter(Boolean).join(' ') : ''
  const description = r.kind === 'greenhouse' ? (typeof job.content === 'string' ? job.content : '') : [typeof job.descriptionPlain === 'string' ? job.descriptionPlain : '', lever].filter(Boolean).join(' ')
  // the whole header is kept (within the page-text budget): a quote is often cut from its END (review on #1128)
  return { title: title.slice(0, 200), location: location.slice(0, 120), header: headerOf(r.kind, job, title, location).slice(0, 20_000), posted, description: description.slice(0, 200_000), html: r.kind === 'greenhouse', board: BOARD[r.kind], org: r.org, company: r.kind === 'greenhouse' ? str(job.company_name).slice(0, 200) : '' }
}

// The header block the board's own posting page shows above the description, from the record's fields, in page order:
//   Ashby:      <title> Location <location> Employment Type <Full time> Location Type <Remote> Department <department>
//   Lever:      <title> <all locations, " / "> <department> – <team> / <commitment> / <Workplace> Apply for this job
//   Greenhouse: <title> <location>
// Only fields the record states are written; nothing is invented.
const EMPLOYMENT: Record<string, string> = { FullTime: 'Full time', PartTime: 'Part time', Intern: 'Intern', Contract: 'Contract', Temporary: 'Temporary' }
const WORKPLACE: Record<string, string> = { hybrid: 'Hybrid', remote: 'Remote', onsite: 'On-site', 'on-site': 'On-site' } // Ashby workplaceType: Remote / Hybrid / OnSite
function headerOf(kind: AtsKind, job: Record<string, unknown>, title: string, location: string): string {
  if (kind === 'ashby') {
    const et = str(job.employmentType), dept = str(job.department), wt = str(job.workplaceType)
    return [title, location && `Location ${location}`, et && `Employment Type ${EMPLOYMENT[et] ?? et}`, wt && `Location Type ${WORKPLACE[wt.toLowerCase()] ?? wt}`, dept && `Department ${dept}`].filter(Boolean).join(' ')
  }
  if (kind === 'lever') {
    const cat = isObj(job.categories) ? job.categories : {}
    const all = Array.isArray(cat.allLocations) ? cat.allLocations.map(str).filter(Boolean) : []
    const locs = all.length ? all : location ? [location] : []
    const dt = [str(cat.department), str(cat.team)].filter(Boolean).join(' – ')
    const wt = str(job.workplaceType).toLowerCase()
    const meta = [dt, str(cat.commitment), WORKPLACE[wt] ?? ''].filter(Boolean).join(' / ')
    return [title, locs.join(' / '), meta, 'Apply for this job'].filter(Boolean).join(' ')
  }
  return [title, location].filter(Boolean).join(' ')
}

// The page text the verifier reads: the posting page's header block (headerOf), the posting's own text, then one line
// naming the board. The first-published day is NOT written into the text: it travels only as the page's postedAt, so it
// can date a hiring candidate for exactly this posting and can never be bound by the text rules to any other claim.
// #1126: who posted it travels only as the page's structured board identity (the board's stated company name, else its
// slug), matched by lib/scan/evidence.ts boardNamesCompany as a whole company key. The slug is never written into the
// text or the title: "acme-health" read as words would name "Health" and "Acme" alone, and the closing line is dazl's own
// wording, so a quote cut to include it must not name the company through it. The title is "<posting title> @ <stated
// name>" when the board states one, else the posting title alone; it is display only for every company check
// (evidence.ts pageHeadingNames reads the board identity instead).
// slug null: no slug identity at all (a held copy of a Greenhouse posting, below): only a quote naming the company binds it.
export interface BoardIdentity { title: string; company: string | null; slug: string | null }

// #1126 (XHawk on #1143): a TinyFish copy held for a posting URL whose board API read was blocked is still a board
// posting, never an ordinary page whose title is phrase-matched (that title is the board page's own, e.g. "<title> @
// acme-health"). Its identity comes from the posting URL, not the copy:
//   Ashby / Lever: the URL's board slug, matched as a whole name (evidence.ts boardNamesCompany);
//   Greenhouse:   none: the slug is not trusted for Greenhouse (its record states company_name, which a copy does not
//                 carry), so only a quote that names the company binds it.
// Undefined for any URL that is not a board posting (the copy is an ordinary page).
export function heldCopyBoard(sourceUrl: string, title: string): BoardIdentity | undefined {
  const r = atsPostingRef(sourceUrl)
  if (!r) return undefined
  return { title: title.slice(0, 300), company: null, slug: r.kind === 'greenhouse' ? null : r.org }
}
export function atsPageText(rec: AtsRecord, descriptionText: string): { text: string; title: string; board: BoardIdentity } {
  const body = descriptionText.replace(/\s+/g, ' ').trim()
  return {
    text: [rec.header || rec.title, body, `Job posting on the ${rec.board} job board.`].filter(Boolean).join(' ').slice(0, 100_000),
    title: (rec.company ? `${rec.title} @ ${rec.company}` : rec.title).slice(0, 300),
    board: { title: rec.title, company: rec.company || null, slug: rec.org },
  }
}
