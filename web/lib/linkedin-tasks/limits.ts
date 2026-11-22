// The dazl LinkedIn extension's pacing rules (#1122). Every one is enforced by the SERVER when it hands out a task
// (lib/linkedin-tasks/store.ts nextTask); the extension only asks, so it cannot read faster, later or more than these.
// The extension READS pages in the user's own browser. There are no write kinds: connection requests and messages are not
// task kinds at all, so no request, flag or extension build can make dazl send one.
export const TASK_KINDS = ['company_people', 'profile', 'post_engagement'] as const
export type TaskKind = typeof TASK_KINDS[number]
export const isTaskKind = (v: unknown): v is TaskKind => typeof v === 'string' && (TASK_KINDS as readonly string[]).includes(v)

export const LIMITS = {
  viewsPerDay: 40,          // every task opens one LinkedIn page: at most 40 a day per workspace
  connectionsPerDay: 15,    // reserved for a later, separately approved write kind; no write kind exists today
  minGapS: 45,              // a random 45-180 s pause between two tasks
  maxGapS: 180,
  openHour: 9,              // tasks are served 09:00-16:59 in the workspace's own time zone
  closeHour: 17,
  leaseS: 5 * 60,           // a served task must be completed within 5 minutes, or it is handed out again once
  maxAttempts: 2,
} as const

// A valid IANA zone, or null. Anything Intl cannot use is refused (no guessing a zone).
export function validZone(tz: unknown): string | null {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return null
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); return tz } catch { return null }
}

// The local hour (0-23) and calendar day (YYYY-MM-DD) of an instant in a zone.
export function localClock(nowS: number, tz: string): { hour: number; day: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(nowS * 1000))
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  return { hour: Number(get('hour')) % 24, day: `${get('year')}-${get('month')}-${get('day')}` }
}

export const inWorkingHours = (nowS: number, tz: string): boolean => { const h = localClock(nowS, tz).hour; return h >= LIMITS.openHour && h < LIMITS.closeHour }

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
