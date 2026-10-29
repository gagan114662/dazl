// A calendar day shown as the calendar day it is. "2026-10-21" is 21 Oct whatever the viewer's timezone: new Date('2026-10-21') is midnight UTC, which toLocaleDateString renders as 20 Oct in America/Toronto.
// This reads the digits and never builds a Date, so no timezone can move it. Anything that is not a plain YYYY-MM-DD (optionally followed by a time) is returned as it was stored, never guessed into a date.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function calendarDay(v: string | null | undefined): string | null {
  if (!v) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(v.trim())
  if (!m) return v
  const mo = Number(m[2]), d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return v
  const last = new Date(Date.UTC(Number(m[1]), mo, 0)).getUTCDate()   // days in that month, computed in UTC so no local zone is involved
  return d > last ? v : `${d} ${MONTHS[mo - 1]} ${m[1]}`
}
