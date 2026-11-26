// #1910 DATES: the date a hiring lead was published, read from the job board's own API record. The posting page on
// Greenhouse, Lever, Workable, Ashby and BambooHR prints no reliable date, but the board publishes the same posting as a
// record that carries one. That record is the proof page's own data (no third party), so the day it names counts.
//
// Never invent a date: a field that is missing, unparseable, in the future or older than the window gives nothing.
export type AtsPlatform = 'greenhouse' | 'lever' | 'workable' | 'ashby' | 'bamboohr'

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

  const bh = /^([a-z0-9-]+)\.bamboohr\.com$/.exec(host)
  if (bh && seg.length >= 2 && seg[0] === 'careers' && /^\d+$/.test(seg[1]))
    return {
      platform: 'bamboohr',
      apiUrl: `https://${bh[1]}.bamboohr.com/careers/list`,
      read: j => {
        const r = obj(j)
        const list = Array.isArray(r.result) ? r.result : Array.isArray(obj(r.result).jobs) ? obj(r.result).jobs as unknown[] : []
        const hit = list.map(obj).find(x => String(x.id ?? '') === seg[1])
        return obj(hit).postedDate ?? obj(hit).publishedDate ?? obj(hit).posted
      },
    }

  return null
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
