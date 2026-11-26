// The dazl LinkedIn extension's pacing rules (#1122). Every one is enforced by the SERVER when it hands out a task
// (lib/linkedin-tasks/store.ts nextTask); the extension only asks, so it cannot read faster, later or more than these.
// The extension READS pages in the user's own browser. There are no write kinds: connection requests and messages are not
// task kinds at all, so no request, flag or extension build can make dazl send one.
export const TASK_KINDS = ['company_people', 'profile', 'post_engagement', 'company_posts'] as const
export type TaskKind = typeof TASK_KINDS[number]
export const isTaskKind = (v: unknown): v is TaskKind => typeof v === 'string' && (TASK_KINDS as readonly string[]).includes(v)

export const LIMITS = {
  viewsPerDay: 40,          // every task opens one LinkedIn page: at most 40 a day per workspace
  connectionsPerDay: 15,    // reserved for a later, separately approved write kind; no write kind exists today
  minGapS: 45,              // a random 45-180 s pause between two tasks
  maxGapS: 180,
  openMin: 9 * 60,          // default window: tasks are served 09:00-16:59 in the workspace's own time zone (a per-workspace setting)
  closeMin: 17 * 60,
  leaseS: 5 * 60,           // a served task must be completed within 5 minutes, or it is handed out again once
  maxAttempts: 2,
} as const

// A valid IANA zone, or null. Anything Intl cannot use is refused (no guessing a zone).
export function validZone(tz: unknown): string | null {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return null
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); return tz } catch { return null }
}

// The local time of an instant in a zone: hour (0-23), minute, second and calendar day (YYYY-MM-DD).
export function localClock(nowS: number, tz: string): { hour: number; minute: number; second: number; day: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(nowS * 1000))
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  return { hour: Number(get('hour')) % 24, minute: Number(get('minute')), second: Number(get('second')), day: `${get('year')}-${get('month')}-${get('day')}` }
}
const minuteOfDay = (nowS: number, tz: string) => { const c = localClock(nowS, tz); return c.hour * 60 + c.minute }
// The last second of the local calendar day that contains nowS (for "tonight only" overrides).
export function endOfLocalDay(nowS: number, tz: string): number { const c = localClock(nowS, tz); return nowS + (86_400 - (c.hour * 3600 + c.minute * 60 + c.second)) - 1 }

// The window that applies now: the workspace's own (default 09:00-17:00), or a later close that the workspace set for today only.
export interface Window { openMin: number; closeMin: number; overrideCloseMin?: number | null; overrideUntil?: number | null }
export function inWorkingHours(nowS: number, tz: string, w: Window = { openMin: LIMITS.openMin, closeMin: LIMITS.closeMin }): boolean {
  const m = minuteOfDay(nowS, tz)
  const close = w.overrideCloseMin != null && w.overrideUntil != null && nowS <= w.overrideUntil ? Math.max(w.closeMin, w.overrideCloseMin) : w.closeMin
  return m >= w.openMin && m < close
}
// "HH:MM" -> minutes of the day, or null.
export function parseHm(v: unknown): number | null {
  const m = typeof v === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v) : null
  return m ? Number(m[1]) * 60 + Number(m[2]) : (v === '24:00' ? 1440 : null)
}

// The next pause, drawn uniformly from [minGapS, maxGapS]. rand is injectable for tests.
export const nextGapS = (rand: () => number = Math.random): number => LIMITS.minGapS + Math.floor(Math.min(0.999999, Math.max(0, rand())) * (LIMITS.maxGapS - LIMITS.minGapS + 1))

// The LinkedIn URL a task may open: https on www.linkedin.com, and only the page shapes a kind reads.
export function taskUrlOk(kind: TaskKind, raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let u: URL
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'https:' || u.hostname !== 'www.linkedin.com' || u.username || u.password || u.port) return null
  const p = u.pathname
  const ok = kind === 'company_people' ? /^\/company\/[A-Za-z0-9%_.-]{1,100}\/people\/?$/.test(p)
    : kind === 'company_posts' ? /^\/(?:company\/[A-Za-z0-9%_.-]{1,100}|in\/[A-Za-z0-9%_-]{2,100})\/?$/.test(p)
    : kind === 'profile' ? /^\/in\/[A-Za-z0-9%_-]{2,100}\/?$/.test(p)
    : /^\/(?:posts\/[A-Za-z0-9%_.-]{3,200}|feed\/update\/urn:li:activity:\d{5,25})\/?$/.test(p)
  return ok ? `https://www.linkedin.com${p}` : null
}

// A person as the extension read them: a name, a title and their own public profile URL. Anything else is refused.
export interface ReadPerson { name: string; title: string; profile_url: string }
const clean = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
export function personOk(v: unknown): ReadPerson | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const name = clean(o.name, 120), title = clean(o.title, 200)
  const url = taskUrlOk('profile', o.profile_url)
  // "LinkedIn Member" is how LinkedIn shows a person it hides from the viewer: not a named person.
  if (!name || !title || !url || /^linkedin member$/i.test(name)) return null
  return { name, title, profile_url: url }
}
export const MAX_PEOPLE = 100

// A post link as the extension read it on a competitor's own page: the post's own URL, its own date (YYYY-MM-DD, or
// null when the page showed none), whether that day came from a timestamp or a relative marker resolved to its oldest
// plausible day, and the page that authored the post - a company page or a person's profile, never assumed. #1588: a
// post whose recency cannot be proven, or whose author the page did not name, is never opened.
export interface ReadPost { url: string; date: string | null; approx: boolean; author: string }
export const MAX_POSTS_PER_PAGE = 25
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
export function postOk(v: unknown): ReadPost | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const url = taskUrlOk('post_engagement', o.url)
  const author = taskUrlOk('company_posts', o.author)
  const date = typeof o.date === 'string' && ISO_DAY.test(o.date) ? o.date : null
  return url && author ? { url, date, approx: o.approx === true, author } : null
}

// A person engaging with a post, as the post page showed them: the ReadPerson fields plus what they did. A record from a
// comment card (the only engagement a post page shows without a click) is a comment; action 'like' marks a reaction row
// if LinkedIn renders one. The comment is the person's own words, capped; anything else is refused.
export interface EngagerPerson extends ReadPerson { action: 'comment' | 'like'; comment: string | null }
export function engagerOk(v: unknown): EngagerPerson | null {
  const p = personOk(v)
  if (!p) return null
  const o = v as Record<string, unknown>
  const action = o.action === 'like' ? 'like' : 'comment'
  const comment = typeof o.comment === 'string' && o.comment.trim() ? o.comment.replace(/\s+/g, ' ').trim().slice(0, 500) : null
  return { ...p, action, comment }
}
