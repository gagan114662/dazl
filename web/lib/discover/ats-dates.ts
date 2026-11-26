// #1910 DATES: the date a hiring lead was published, read from the job board's own API record. The posting page on
// Greenhouse, Lever, Workable and Ashby print no reliable date, but the board publishes the same posting as a record that
// carries one. That record is the proof page's own data (no third party), so the day it names counts.
//
// Never invent a date: a field that is missing, unparseable, in the future or older than the window gives nothing.
export type AtsPlatform = 'greenhouse' | 'lever' | 'workable' | 'ashby'

export interface AtsPosting {
  platform: AtsPlatform
  apiUrl: string
  // the field(s) that carry the published day, in order of preference, read from the API body
  read: (body: unknown) => unknown
}

export interface AtsDate {
  date: string
  sourceUrl: string
  platform: AtsPlatform
}

// A posting older than this is background, not a reason to write now (same horizon as the rest of discovery).
export const ATS_DATE_MAX_AGE_DAYS = 730

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {})

export function atsPosting(url: string | URL): AtsPosting | null {
  let u: URL
  try { u = typeof url === 'string' ? new URL(url) : url } catch { return null }
  const host = u.hostname.toLowerCase(), seg = u.pathname.split('/').filter(Boolean)
  const enc = encodeURIComponent

  if (/(^|\.)greenhouse\.io$/.test(host) && seg.length >= 3 && seg[1] === 'jobs' && /^\d+$/.test(seg[2]))
    return {
      platform: 'greenhouse',
      apiUrl: `https://boards-api.greenhouse.io/v1/boards/${enc(seg[0])}/jobs/${seg[2]}`,
      read: j => obj(j).first_published, // an edit date (updated_at) is not a posting date
    }

  if (/^jobs\.(?:eu\.)?lever\.co$/.test(host) && seg.length >= 2 && /^[0-9a-f-]{36}$/i.test(seg[1]))
    return {
      platform: 'lever',
      apiUrl: `${host === 'jobs.eu.lever.co' ? 'https://api.eu.lever.co' : 'https://api.lever.co'}/v0/postings/${enc(seg[0])}/${seg[1]}`,
      read: j => obj(j).createdAt,
    }

  if (host === 'apply.workable.com' && seg.length >= 3 && seg[1] === 'j')
    return {
      platform: 'workable',
      apiUrl: `https://apply.workable.com/api/v1/accounts/${enc(seg[0])}/jobs/${enc(seg[2])}`,
      read: j => { const r = obj(j); return r.published_on ?? r.published ?? r.created_at },
    }
  const wa = /^([a-z0-9-]+)\.workable\.com$/.exec(host)
  if (wa && seg.length >= 2 && seg[0] === 'j')
    return {
      platform: 'workable',
      apiUrl: `https://apply.workable.com/api/v1/accounts/${enc(wa[1])}/jobs/${enc(seg[1])}`,
      read: j => { const r = obj(j); return r.published_on ?? r.published ?? r.created_at },
    }

  if (host === 'jobs.ashbyhq.com' && seg.length >= 2 && /^[0-9a-f-]{36}$/i.test(seg[1]))
    return {
      platform: 'ashby',
      apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${enc(seg[0])}`,
      read: j => {
        const jobs = obj(j).jobs
        const id = seg[1]
        const hit = Array.isArray(jobs) ? jobs.map(obj).find(x => x.id === id || String(x.jobUrl ?? '').includes(id)) : null
        return obj(hit).publishedAt
      },
    }

  return null
}

export interface AtsList {
  platform: AtsPlatform
  apiUrl: string
  // every posting the board lists, with the URL it is linked at and the raw day field
  read: (body: unknown) => { id: string; url: string; date: unknown }[]
}

const lastSeg = (u: string): string => {
  try { return (new URL(u).pathname.split('/').filter(Boolean).pop() ?? '').toLowerCase() } catch { return '' }
}

// A careers index page on the board links to its postings but prints no dates; the board's own list record carries them.
export function atsList(url: string | URL): AtsList | null {
  let u: URL
  try { u = typeof url === 'string' ? new URL(url) : url } catch { return null }
  const host = u.hostname.toLowerCase(), seg = u.pathname.split('/').filter(Boolean)
  const enc = encodeURIComponent
  const ofJobs = (v: unknown): Record<string, unknown>[] => {
    const r = obj(v)
    const list = Array.isArray(v) ? v : Array.isArray(r.jobs) ? r.jobs : Array.isArray(r.result) ? r.result : []
    return list.map(obj)
  }

  if (host === 'apply.workable.com' && seg.length === 1)
    return {
      platform: 'workable',
      apiUrl: `https://apply.workable.com/api/v1/accounts/${enc(seg[0])}/jobs?details=true`,
      read: j => ofJobs(j).map(x => ({ id: String(x.shortcode ?? lastSeg(String(x.url ?? ''))), url: String(x.url ?? ''), date: x.published_on ?? x.published ?? x.created_at })),
    }
  const wa = /^([a-z0-9-]+)\.workable\.com$/.exec(host)
  if (wa && seg.length === 0)
    return {
      platform: 'workable',
      apiUrl: `https://apply.workable.com/api/v1/accounts/${enc(wa[1])}/jobs?details=true`,
      read: j => ofJobs(j).map(x => ({ id: String(x.shortcode ?? lastSeg(String(x.url ?? ''))), url: String(x.url ?? ''), date: x.published_on ?? x.published ?? x.created_at })),
    }

  if (/^jobs\.(?:eu\.)?lever\.co$/.test(host) && seg.length === 1)
    return {
      platform: 'lever',
      apiUrl: `${host === 'jobs.eu.lever.co' ? 'https://api.eu.lever.co' : 'https://api.lever.co'}/v0/postings/${enc(seg[0])}?mode=json`,
      read: j => ofJobs(j).map(x => ({ id: String(x.id ?? lastSeg(String(x.hostedUrl ?? ''))), url: String(x.hostedUrl ?? ''), date: x.createdAt })),
    }

  if (host === 'jobs.ashbyhq.com' && seg.length === 1)
    return {
      platform: 'ashby',
      apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${enc(seg[0])}`,
      read: j => ofJobs(j).map(x => ({ id: String(x.id ?? lastSeg(String(x.jobUrl ?? ''))), url: String(x.jobUrl ?? ''), date: x.publishedAt })),
    }

  if (/(^|\.)greenhouse\.io$/.test(host) && seg.length === 1)
    return {
      platform: 'greenhouse',
      apiUrl: `https://boards-api.greenhouse.io/v1/boards/${enc(seg[0])}/jobs`,
      read: j => ofJobs(j).map(x => ({ id: String(x.id ?? lastSeg(String(x.absolute_url ?? ''))), url: String(x.absolute_url ?? ''), date: x.first_published })),
    }

  return null
}

// The day this board lists for one posting: only when the posting is listed with exactly one date the window accepts. Two different
// days for the same posting, an entry with no date, or no entry at all give nothing - the list has not settled the fact.
export async function atsListDate(
  indexUrl: string | URL,
  postingUrl: string | URL,
  fetchImpl: typeof fetch,
  now: Date = new Date(),
  maxAgeDays = ATS_DATE_MAX_AGE_DAYS,
  timeoutMs = 8_000,
): Promise<AtsDate | null> {
  const list = atsList(indexUrl), post = atsPosting(postingUrl)
  if (!list || !post || list.platform !== post.platform) return null
  const want = typeof postingUrl === 'string' ? lastSeg(postingUrl) : lastSeg(postingUrl.toString())
  if (!want) return null
  try {
    const r = await fetchImpl(list.apiUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(Math.min(timeoutMs, 8_000)),
      headers: { accept: 'application/json' },
    })
    if (!r.ok) return null
    const hits = list.read(await r.json()).filter(e => e.id.toLowerCase() === want || lastSeg(e.url) === want)
    const days = new Set(hits.map(h => dayOf(h.date, now, maxAgeDays)).filter((d): d is string => !!d))
    if (days.size !== 1) return null
    return { date: [...days][0], sourceUrl: list.apiUrl, platform: list.platform }
  } catch { return null }
}

// A day counts only when the value really is one, is not after today, and is inside the window. Everything else is null.
export function dayOf(v: unknown, now: Date, maxAgeDays = ATS_DATE_MAX_AGE_DAYS): string | null {
  let t: number
  if (typeof v === 'number') t = v
  else if (typeof v === 'string') {
    const s = v.trim()
    if (!s) return null
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) t = Date.parse(`${s}T00:00:00Z`)
    else if (/^\d{10,13}$/.test(s)) t = Number(s) < 1e12 ? Number(s) * 1000 : Number(s)
    else t = Date.parse(s)
  } else return null
  if (!Number.isFinite(t)) return null
  if (typeof v === 'number' && t < 1e12) t *= 1000 // epoch seconds
  const age = Math.floor(now.getTime() / 86_400_000) - Math.floor(t / 86_400_000)
  if (age < -1 || age > maxAgeDays) return null
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

export async function atsDate(
  url: string | URL,
  fetchImpl: typeof fetch,
  now: Date = new Date(),
  maxAgeDays = ATS_DATE_MAX_AGE_DAYS,
  timeoutMs = 8_000,
): Promise<AtsDate | null> {
  const rec = atsPosting(url)
  if (!rec) return null
  try {
    const r = await fetchImpl(rec.apiUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(Math.min(timeoutMs, 8_000)),
      headers: { accept: 'application/json' },
    })
    if (!r.ok) return null
    const date = dayOf(rec.read(await r.json()), now, maxAgeDays)
    return date ? { date, sourceUrl: rec.apiUrl, platform: rec.platform } : null
  } catch { return null }
}
