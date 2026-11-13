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
    t = Date.parse(v.trim())
  } else return null
  if (!Number.isFinite(t)) return null
  const day = new Date(t).toISOString().slice(0, 10)
  return +day.slice(0, 4) >= 2000 ? day : null
}
const BOARD: Record<AtsKind, string> = { ashby: 'Ashby', greenhouse: 'Greenhouse', lever: 'Lever' }

// The record for exactly this posting: its title, location, first-published day (null when the record states none:
// an undated page, judged by the normal rules) and description (html: Greenhouse sends escaped HTML; the caller turns it
// into text). Null when the body is not this posting's record (another id, no title): read as a failed read.
export interface AtsRecord { title: string; location: string; posted: string | null; description: string; html: boolean; board: string; org: string }
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
  return { title: title.slice(0, 200), location: location.slice(0, 120), posted, description: description.slice(0, 200_000), html: r.kind === 'greenhouse', board: BOARD[r.kind], org: r.org }
}

// The page text the verifier reads: one line naming the posting and its board, then the posting's own text. The
// first-published day is NOT written into the text: it travels only as the page's postedAt, so it can date a hiring
// candidate for exactly this posting and can never be bound by the text rules to any other claim (a funding round).
export function atsPageText(rec: AtsRecord, descriptionText: string): { text: string; title: string } {
  const head = `${rec.title}${rec.location ? ` (${rec.location})` : ''}. Job posting on the ${rec.org} ${rec.board} job board.`
  return { text: `${head} ${descriptionText.replace(/\s+/g, ' ').trim()}`.trim().slice(0, 100_000), title: `${rec.title} @ ${rec.org}`.slice(0, 300) }
}
