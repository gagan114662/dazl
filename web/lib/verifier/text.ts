// Source text primitives for the independent evidence verifier (#780, part of #395). Written for the verifier alone on
// purpose: none of the scan's own extraction, date or place code is reused, so a defect in the pipeline that discovered
// a lead cannot make the verifier agree with it.
import { getDomain } from 'tldts'

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: '...' }

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

// Visible text of an HTML page: scripts, styles and markup removed, block boundaries kept as line breaks.
export function htmlToText(html: string): string {
  return decodeEntities(html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n[\n ]*/g, '\n')
    .trim()
}

// Case, quote marks, dashes and whitespace folded so matching is robust to how a page typesets the same text.
export function fold(s: string): string {
  return s.normalize('NFKC').toLowerCase()
    .replace(/[‘’‚‛′`]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim()
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Every position where `needle` occurs in `hay` (both folded) as a whole token: no letter or digit on either side.
export function tokenPositions(hay: string, needle: string): number[] {
  const n = fold(needle)
  if (!n) return []
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, 'gu')
  return [...fold(hay).matchAll(re)].map(m => m.index!)
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?'
const monthIndex = (m: string) => MONTHS.findIndex(x => x.startsWith(m.toLowerCase().replace('.', '').slice(0, 3)))

export function isoDay(y: number, m: number, d: number): string | null {
  const t = Date.UTC(y, m - 1, d)
  const x = new Date(t)
  if (y < 1900 || y > 2100 || x.getUTCMonth() !== m - 1 || x.getUTCDate() !== d) return null
  return x.toISOString().slice(0, 10)
}

export interface DateMention { iso: string; index: number; end: number }
// Calendar days stated in folded text, as whole tokens only (2026-10-080123 and 18 October are not October 8). Forms: ISO
// 2026-10-08, "October 8, 2026", "Oct. 8 2026", "8 October 2026".
export function datesIn(folded: string): DateMention[] {
  const out: DateMention[] = []
  const B = '(?<![\\p{L}\\p{N}])', E = '(?![\\p{L}\\p{N}])'
  const forms: [RegExp, (m: RegExpMatchArray) => string | null][] = [
    [new RegExp(`${B}(\\d{4})-(\\d{2})-(\\d{2})${E}`, 'gu'), m => isoDay(+m[1], +m[2], +m[3])],
    [new RegExp(`${B}${MON} (\\d{1,2})(?:st|nd|rd|th)?,? (\\d{4})${E}`, 'gu'), m => isoDay(+m[3], monthIndex(m[1]) + 1, +m[2])],
    [new RegExp(`${B}(\\d{1,2})(?:st|nd|rd|th)? ${MON},? (\\d{4})${E}`, 'gu'), m => isoDay(+m[3], monthIndex(m[2]) + 1, +m[1])],
  ]
  for (const [re, toIso] of forms) for (const m of folded.matchAll(re)) {
    const iso = toIso(m)
    if (iso) out.push({ iso, index: m.index!, end: m.index! + m[0].length })
  }
  return out.sort((a, b) => a.index - b.index)
}

// A date printed as the page's own stamp ("Published", "Updated", "Posted on ...") is when the page was written, not when
// the event happened.
const STAMP = /(?:^|[^\p{L}])(?:published|updated|posted|modified|last edited|republished|dated?)(?: on| at)?:?\s*$/u
export function isStamp(folded: string, m: DateMention): boolean {
  return STAMP.test(folded.slice(Math.max(0, m.index - 30), m.index))
}

// The sentence around position i (folded text).
export function sentenceAt(folded: string, i: number, j = i): string {
  const start = Math.max(folded.lastIndexOf('. ', i), folded.lastIndexOf('\n', i), folded.lastIndexOf('! ', i), folded.lastIndexOf('? ', i))
  const ends = ['. ', '\n', '! ', '? '].map(t => folded.indexOf(t, j)).filter(x => x >= 0)
  return folded.slice(start + 1, ends.length ? Math.min(...ends) : folded.length).trim()
}

// Publication / modification days the page declares in metadata (meta tags, JSON-LD, <time datetime>).
export function metadataDays(html: string): string[] {
  const out = new Set<string>()
  const add = (v: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim()); const d = m && isoDay(+m[1], +m[2], +m[3]); if (d) out.add(d) }
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0]
    if (/(?:property|name|itemprop)\s*=\s*["']?(?:article:(?:published|modified)_time|og:updated_time|date|pubdate|datepublished|datemodified|dc\.date[^"']*)["'\s>]/i.test(tag)) {
      const c = /content\s*=\s*["']([^"']+)["']/i.exec(tag)
      if (c) add(c[1])
    }
  }
  for (const m of html.matchAll(/"date(?:Published|Modified|Created)"\s*:\s*"([^"]+)"/g)) add(m[1])
  for (const m of html.matchAll(/<time\b[^>]*datetime\s*=\s*["']([^"']+)["']/gi)) add(m[1])
  return [...out].sort()
}

export function registrable(hostOrUrl: string): string | null {
  let host = hostOrUrl.trim().toLowerCase()
  try { if (/^https?:\/\//.test(host)) host = new URL(host).hostname } catch { return null }
  return getDomain(host.replace(/^\.+|\.+$/g, '')) ?? null
}

// Registrable domains the page links to, and its declared canonical URL.
export function linkedDomains(html: string): Set<string> {
  const out = new Set<string>()
  for (const m of html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const href = decodeEntities(m[1])
    if (/^mailto:/i.test(href)) { const d = registrable(href.slice(7).split('?')[0].split('@')[1] ?? ''); if (d) out.add(d) }
    else if (/^https?:\/\//i.test(href)) { const d = registrable(href); if (d) out.add(d) }
  }
  return out
}

export function canonicalOf(html: string): string | null {
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel\s*=\s*["']?canonical["'\s>]/i.test(m[0])) continue
    const h = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[0])
    if (h && /^https?:\/\//i.test(h[1])) return normalizeUrl(decodeEntities(h[1]))
  }
  return null
}

// Scheme, www., fragment, query and trailing slash ignored: two URLs that differ only there are one document.
export function normalizeUrl(u: string): string {
  try {
    const x = new URL(u)
    return `${x.hostname.toLowerCase().replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}`
  } catch { return u.trim().toLowerCase() }
}
