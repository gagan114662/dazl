// #1805: the plain words for a reached daily send cap, shared by every surface that reports it.
// One line: how many were sent today, and when the rest can be sent — the reset instant (the manual cap
// restarts at the next Toronto midnight, send-budget.ts) formatted in the user's own timezone,
// falling back to America/Toronto when the timezone is missing or unreadable. Never a raw error code.
// Pure and client-safe: Intl only, no server imports.

const FALLBACK_TZ = 'America/Toronto'

function zoneOrFallback(timeZone?: string | null): string {
  if (timeZone) { try { new Intl.DateTimeFormat('en-US', { timeZone }); return timeZone } catch { /* fall through */ } }
  return FALLBACK_TZ
}

// The calendar day of an instant in a zone, as a day number, so "today" / "tomorrow" are judged the
// way the user sees them, not by UTC.
function dayNumber(unixS: number, tz: string): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(unixS * 1000))
  const get = (t: string) => Number(p.find(x => x.type === t)?.value ?? 0)
  return Math.floor(Date.UTC(get('year'), get('month') - 1, get('day')) / 86400000)
}

export function dailyCapMessage(cap: number, resetsAt: number | null, timeZone?: string | null, now: number = Math.floor(Date.now() / 1000)): string {
  const first = `You've sent today's ${cap} emails.`
  if (!resetsAt) return `${first} You can send the rest tomorrow.`
  const tz = zoneOrFallback(timeZone)
  // A reset at the reader's own midnight reads as "after midnight", not "12:00 AM". The copy never
  // promises the rest send themselves: a refused send returns to approved and the user sends it again.
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(resetsAt * 1000))
  if (hm === '00:00') return `${first} You can send the rest after midnight.`
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(resetsAt * 1000))
  const diff = dayNumber(resetsAt, tz) - dayNumber(now, tz)
  const day = diff <= 0 ? 'today' : diff === 1 ? 'tomorrow' : new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(new Date(resetsAt * 1000))
  return `${first} You can send the rest ${day} at ${time}.`
}
