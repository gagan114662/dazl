// A source or evidence date as a calendar day ("21 Oct 2026"), the same day in every time zone. Date-only values
// (YYYY-MM-DD) and the date part of an ISO timestamp are read from their own digits, never through new Date(), which
// would place a date-only value at UTC midnight and show the previous day west of UTC (Toronto). Anything else is
// returned as given; null stays null.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function calendarDay(d: string | null | undefined): string | null {
  if (!d) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(d.trim())
  if (!m) return d
  const month = Number(m[2]), day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return d
  return `${day} ${MONTHS[month - 1]} ${m[1]}`
}
