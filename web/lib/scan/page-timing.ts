// What the already-fetched page says about WHEN, kept apart from what the quote says happened.
//   published  - the day the PAGE was published (its own metadata, or a cued "Posted ..." / "Published ..." line near the quote). A page
//                can be republished, updated or recapped long after the event, so this is a LABEL ONLY: it is never assigned to the event
//                date and never lets a lead count as inside the window. Several different publication dates on one page (a news list, a
//                multi-article page) mean none belongs to this quote: none is reported.
//   olderYear  - the QUOTE itself names a past year ("opened in 2019"): the event is older than the window whatever the page date says.
//   note       - a human label: the publication day, or a season / "soon" with no date ("timing: fall, unconfirmed").
// Update stamps (updated, modified, last reviewed, copyright, expiry) are never cues.
const MONTHS: Record<string, number> = { january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12 }
const MON = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'
const DATE_RE = new RegExp(`\\b(\\d{4})-(\\d{2})-(\\d{2})\\b|\\b(${MON})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b|\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON})\\.?,?\\s+(\\d{4})\\b`, 'gi')
const CUE = /(?:posted|published|announced|date)\b[^.\n]{0,25}$/i
const NOT_EVENT = /(?:updated?|modified|revised|reviewed|copyright|©|expires?|valid (?:until|through)|last)\b[^.\n]{0,20}$/i
const SEASON = /\b(?:this |early |late |mid-?)?(spring|summer|fall|autumn|winter)(?:\s+(?:of\s+)?(\d{4}))?\b/i
const SOON = /\b(?:coming soon|opening soon|opens soon|launching soon|later this year|next year)\b/i

const iso = (y: number, m: number, d: number): string | null => {
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null
  const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null
}
const BACKGROUND_YEAR = /\b(?:founded|established|incorporated|formed|est\.?|since|in business since|operating since|dating back to)\s+(?:in\s+)?$/i
export interface PageTiming { published: string | null; olderYear: number | null; note: string | null }
// `published` is the page's own metadata when the fetcher found exactly one publication date in the markup (fetch-page.ts publishedDate).
export function resolveTiming(pageText: string, quote: string, published: string | null | undefined, nowYear: number): PageTiming {
  // 1. The quote names an old year: the claim itself is old. (Years before last year only; last year alone is left to the window gate.)
  // Company background ("founded in 2020", "established 2019", "since 2015") says when the company began, not when this event happened.
  const q = quote.replace(/\s+/g, ' ')
  const years = [...q.matchAll(/\b(19[89]\d|20\d{2})\b/g)].filter(m => !BACKGROUND_YEAR.test(q.slice(Math.max(0, m.index! - 40), m.index!))).map(m => +m[1]).filter(y => y <= nowYear - 2)
  const olderYear = years.length ? Math.min(...years) : null
  // 2. Publication day of the page.
  let pub: string | null = published && /^\d{4}-\d{2}-\d{2}$/.test(published) ? published : null
  let how = 'the page\'s own publication metadata'
  const text = pageText.replace(/\s+/g, ' ')
  if (!pub) {
    const q = quote.replace(/\s+/g, ' ').slice(0, 80).toLowerCase()
    const at = q ? text.toLowerCase().indexOf(q) : -1
    const hits: { date: string; at: number }[] = []
    for (const m of text.matchAll(DATE_RE)) {
      const date = m[1] ? iso(+m[1], +m[2], +m[3]) : m[4] ? iso(+m[6], MONTHS[m[4].toLowerCase().replace(/\./g, '')] ?? MONTHS[m[4].toLowerCase().slice(0, 3)], +m[5]) : iso(+m[9], MONTHS[m[8].toLowerCase().replace(/\./g, '')] ?? MONTHS[m[8].toLowerCase().slice(0, 3)], +m[7])
      if (!date) continue
      const before = text.slice(Math.max(0, m.index! - 40), m.index!)
      if (NOT_EVENT.test(before.slice(-30)) || !CUE.test(before)) continue // only a cued "Posted/Published/Announced <date>"
      if (!(m.index! < 600 || (at >= 0 && Math.abs(m.index! - at) <= 300))) continue
      hits.push({ date, at: m.index! })
    }
    const distinct = [...new Set(hits.map(h => h.date))]
    if (distinct.length === 1) { pub = distinct[0]; how = 'a "Posted/Published" line on the page' } // several different dates = a list of items: none is this quote's
  }
  const near = (() => { const q = quote.replace(/\s+/g, ' ').slice(0, 80).toLowerCase(); const at = q ? text.toLowerCase().indexOf(q) : -1; return at >= 0 ? text.slice(Math.max(0, at - 300), at + q.length + 300) : text.slice(0, 600) })()
  const s = SEASON.exec(near)
  const season = s ? `timing: ${s[1].toLowerCase().replace('autumn', 'fall')}${s[2] ? ` ${s[2]}` : ''}, unconfirmed (no dated source yet)` : SOON.test(near) ? 'timing: "soon", unconfirmed (no dated source yet)' : null
  const pubNote = pub ? `page published ${pub} (from ${how}); a publication date only - the event date is unknown and this does not place the event in the window` : null
  return { published: pub, olderYear, note: [pubNote, season].filter(Boolean).join('; ') || null }
}
