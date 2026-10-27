// Timing for a candidate whose model reply gave no date, read from the page text the scan ALREADY fetched (no new request).
// The resolved date is handed to the verifier exactly like a model-supplied claimed date: same stale / future / window rules, and it
// is never "verified" (a publication day does not bind the event to a day). A season or "soon" is only a LABEL: it never becomes a
// date and the candidate stays a researched opportunity until a real date exists. Sitemap lastmod, crawl times and page-update
// stamps are update times, not event dates, so "updated"/"last modified" are NOT cues here.
const MONTHS: Record<string, number> = { january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12 }
const MON = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'
const DATE_RE = new RegExp(`\\b(\\d{4})-(\\d{2})-(\\d{2})\\b|\\b(${MON})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b|\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON})\\.?,?\\s+(\\d{4})\\b`, 'gi')
const CUE = /(?:posted|published|announced|opened|opening|launched|date)\b[^.\n]{0,25}$/i
const NOT_EVENT = /(?:updated?|modified|revised|reviewed|copyright|©|expires?|valid (?:until|through)|last)\b[^.\n]{0,20}$/i
const SEASON = /\b(?:this |early |late |mid-?)?(spring|summer|fall|autumn|winter)(?:\s+(?:of\s+)?(\d{4}))?\b/i
const SOON = /\b(?:coming soon|opening soon|opens soon|launching soon|later this year|next year)\b/i

const iso = (y: number, m: number, d: number): string | null => {
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null
  const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null
}
export interface PageTiming { date: string | null; note: string | null }
export function resolveTiming(pageText: string, quote: string): PageTiming {
  const text = pageText.replace(/\s+/g, ' ')
  const q = quote.replace(/\s+/g, ' ').slice(0, 80).toLowerCase()
  const at = q ? text.toLowerCase().indexOf(q) : -1
  type Hit = { date: string; at: number; raw: string; cued: boolean }
  const hits: Hit[] = []
  for (const m of text.matchAll(DATE_RE)) {
    const date = m[1] ? iso(+m[1], +m[2], +m[3]) : m[4] ? iso(+m[6], MONTHS[m[4].toLowerCase().replace(/\./g, '')] ?? MONTHS[m[4].toLowerCase().slice(0, 3)], +m[5]) : iso(+m[9], MONTHS[m[8].toLowerCase().replace(/\./g, '')] ?? MONTHS[m[8].toLowerCase().slice(0, 3)], +m[7])
    if (!date) continue
    const before = text.slice(Math.max(0, m.index! - 40), m.index!)
    if (NOT_EVENT.test(before.slice(-30))) continue // an update / copyright / expiry stamp is not an event day
    hits.push({ date, at: m.index!, raw: m[0], cued: CUE.test(before) })
  }
  // A date counts when it is cued ("Posted ...", "Published ...") in the page head or within 300 characters of the quote, or stands
  // right before the quote (a news dateline). The nearest such date to the quote wins.
  const ok = hits.filter(h => (h.cued && (h.at < 600 || (at >= 0 && Math.abs(h.at - at) <= 300))) || (at >= 0 && h.at < at && at - h.at <= 80))
  if (ok.length) {
    const best = at >= 0 ? ok.sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0] : ok[0]
    return { date: best.date, note: `date read from the page text ("${best.raw}"), not stated by the source as the event day` }
  }
  const near = at >= 0 ? text.slice(Math.max(0, at - 300), at + q.length + 300) : text.slice(0, 600)
  const s = SEASON.exec(near)
  if (s) return { date: null, note: `timing: ${s[1].toLowerCase().replace('autumn', 'fall')}${s[2] ? ` ${s[2]}` : ''}, unconfirmed (no dated source yet)` }
  if (SOON.test(near)) return { date: null, note: 'timing: "soon", unconfirmed (no dated source yet)' }
  return { date: null, note: null }
}
