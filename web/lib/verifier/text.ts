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

// Every tag in `html`, from its opening `<` through the matching (quote-aware) `>`. A naive `<[^>]+>` stops at the
// first `>`, including one inside a quoted attribute value - a page can hide readable-looking text there
// (`<div data-x="a > FAKE EVIDENCE">`) that a naive stripper would leave behind as though it were content.
function stripTags(s: string): string {
  let out = ''
  for (let i = 0; i < s.length;) {
    if (s[i] !== '<') { out += s[i]; i++; continue }
    i++
    let quote: string | null = null
    while (i < s.length && (quote || s[i] !== '>')) {
      if (quote) { if (s[i] === quote) quote = null }
      else if (s[i] === '"' || s[i] === "'") quote = s[i]
      i++
    }
    i++ // past the closing '>' (or end of string for an unterminated tag)
    out += ' '
  }
  return out
}

// A bare `<time datetime="...">` (no pubdate/itemprop) is ordinary page content, not a publication stamp
// (metadataDays below only counts the publication-flagged form) - but its ISO value is often the ONLY place the
// full year appears (a byline shows "Oct 20", the year lives only in the attribute). Inject it into the text
// stream next to the element's own visible text so datesIn/isStamp/near can read it like any other date mention,
// at the position where the element actually occurs - never floated to an unrelated passage.
function inlineTimeElements(html: string): string {
  return html.replace(/<time\b([^>]*)>([\s\S]*?)<\/time\s*>/gi, (whole, attrs: string, inner: string) => {
    const dt = /\bdatetime\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]
    if (!dt) return whole
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dt.trim())
    const iso = m && isoDay(+m[1], +m[2], +m[3])
    return iso ? `${inner} ${iso} ` : whole
  })
}

// Visible text of an HTML page: scripts, styles and markup removed, block boundaries kept as line breaks.
export function htmlToText(html: string): string {
  return decodeEntities(stripTags(inlineTimeElements(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)\b[^>]*>/gi, '\n')))
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

// Publication / modification days the page declares in metadata (meta tags, JSON-LD, a publication-flagged <time>).
// A bare <time datetime="..."> with no pubdate attribute or publication itemprop is ordinary page content (an event
// date, say) - htmlToText's inlineTimeElements puts its value in the visible text stream instead, where normal
// passage-binding and isStamp() wording checks apply to it like any other date mention.
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
  for (const m of html.matchAll(/<time\b[^>]*>/gi)) {
    const tag = m[0]
    if (!/\bpubdate\b/i.test(tag) && !/\bitemprop\s*=\s*["']?(?:datepublished|datemodified)["'\s>]/i.test(tag)) continue
    const dt = /\bdatetime\s*=\s*["']([^"']+)["']/i.exec(tag)
    if (dt) add(dt[1])
  }
  return [...out].sort()
}

// allowPrivateDomains: without it, tldts normalizes a known multi-tenant host suffix (github.io, vercel.app, ...) only
// down to the public suffix itself, so two unrelated tenants (realco.github.io, otherco.github.io) would both
// normalize to "github.io" and compare equal - scan/lookalike-discovery.ts enables the same option for the same
// reason. A host with no registrable domain at all (an IP, a bare TLD) returns null here, and sameDomain (checks.ts)
// never treats two nulls as a match.
export function registrable(hostOrUrl: string): string | null {
  let host = hostOrUrl.trim().toLowerCase()
  try { if (/^https?:\/\//.test(host)) host = new URL(host).hostname } catch { return null }
  return getDomain(host.replace(/^\.+|\.+$/g, ''), { allowPrivateDomains: true }) ?? null
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

// 8-word shingles of the folded text; overlap of two pages' shingles relative to the smaller page (syndicated copies
// share nearly all). Used only by provenanceGroups (checks.ts) to count copies of one source as one source.
export function shingles(folded: string, k = 8): Set<string> {
  const w = folded.replace(/[^\p{L}\p{N} ]+/gu, ' ').split(' ').filter(Boolean)
  const out = new Set<string>()
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(' '))
  return out
}
export function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let n = 0
  for (const x of a) if (b.has(x)) n++
  return n / Math.min(a.size, b.size)
}
