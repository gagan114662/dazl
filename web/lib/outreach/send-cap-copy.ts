// #1805: the plain words for a reached daily send cap, shared by every surface that reports it.
// One line: how many were sent today, and when the rest can be sent — the reset instant (the manual cap
// restarts at the next midnight in the account's own zone, send-budget.ts #2054) formatted in the user's
// own timezone, falling back to UTC when the timezone is missing or unreadable, and naming the zone either
// way so the reader can tell whose midnight it is. Never a raw error code.
// Pure and client-safe: Intl only, no server imports.
import { dayNumber, zoneOrFallback } from '../account-zone.ts'

export function dailyCapMessage(cap: number, resetsAt: number | null, timeZone?: string | null, now: number = Math.floor(Date.now() / 1000)): string {
  const first = `You've sent today's ${cap} emails.`
  if (!resetsAt) return `${first} You can send the rest tomorrow.`
  const tz = zoneOrFallback(timeZone)
  // A reset at the reader's own midnight reads as "after midnight", not "12:00 AM". The copy never
  // promises the rest send themselves: a refused send returns to approved and the user sends it again.
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(resetsAt * 1000))
  if (hm === '00:00') return `${first} You can send the rest after midnight (${tz} time).`
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(resetsAt * 1000))
  const diff = dayNumber(resetsAt, tz) - dayNumber(now, tz)
  const day = diff <= 0 ? 'today' : diff === 1 ? 'tomorrow' : new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(new Date(resetsAt * 1000))
  return `${first} You can send the rest ${day} at ${time} (${tz} time).`
}
