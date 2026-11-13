// #878: a public social post's OWN publish time, read from the structured data its page carries, for exactly the post the
// URL names. Live check (2026-11-13, the scan's own user agent, the three Instagram posts the staging dental leads cite):
// instagram.com answers a plain read with either a server-rendered page (the caption and "December 16, 2025" in the text)
// or a script shell the fetcher calls blocked; both carry the post's own media record, `"code":"<shortcode>","taken_at":<unix
// seconds>` followed by its `"caption":{..."text":...}`, and the "more posts" grid lists other shortcodes with no time. YouTube
// carries a schema.org VideoObject (@id = the watch URL, uploadDate). The other platforms' public pages come back as script
// shells or refusals to a plain read; a rendered page is read by the same rules: a schema.org post entity naming exactly this
// post, TikTok's item record (id, desc, createTime), X's permalink <time datetime> for exactly this status id.
//
// Rules: a profile, feed, hashtag or search page names no post, so nothing on it dates anything; a time read for another
// post (a feed's newest post, a comment, a quoted post, a related video) is never this post's; modified / edited times,
// "3 days ago" / "47w" text and the retrieval time are never read; two different days for the post are no day. The day is
// the UTC calendar day (lib/sources/ats-posting.ts postingDay), never before 2000 and never after today.
//
// What the day may prove is decided by socialPostBound below, through the existing binding rule (event-date-binding.ts):
// the post's time is the dateline of the post's OWN text, so it dates a claim only when the quote is in that text and the
// binding rule ties the day to this company and this event there. A quote from the page around the post (a comment, a
// sidebar) is never dated by it.
import { postingDay } from '../sources/ats-posting.ts'
import { eventDateBound } from './event-date-binding.ts'
import { datePositions, eventYears } from './date-in-text.ts'

export type SocialPlatform = 'instagram' | 'facebook' | 'linkedin' | 'x' | 'tiktok' | 'youtube'
export interface SocialPostRef { platform: SocialPlatform; id: string }
// day: the post's own publish day; texts: the post's own text fields (caption / body / title / description), as the same record states them
export interface SocialPost extends SocialPostRef { day: string; texts: string[] }

const YT_ID = /^[A-Za-z0-9_-]{11}$/
// The post a URL names, or null (profiles, feeds, hashtags, search, short links that only redirect). Query strings that do
// not name the post (utm_..., igsh=...) are ignored.
export function socialPostRef(raw: string): SocialPostRef | null {
  let u: URL
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.username || u.password || (u.port && u.port !== '443' && u.port !== '80')) return null
  const host = u.hostname.toLowerCase().replace(/^(?:www|m|mobile|web)\./, ''), path = u.pathname.replace(/\/+$/, ''), q = u.searchParams
  let m: RegExpExecArray | null
  if (host === 'instagram.com') {
    if ((m = /^(?:\/[A-Za-z0-9._]{1,30})?\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,40})$/.exec(path))) return { platform: 'instagram', id: m[1] }
    return null
  }
  if (host === 'facebook.com') {
    if ((m = /^\/[A-Za-z0-9.\-]{1,80}\/(?:posts|videos)\/([A-Za-z0-9]{5,80})$/.exec(path))) return { platform: 'facebook', id: m[1] }
    if ((m = /^\/reel\/(\d{5,25})$/.exec(path))) return { platform: 'facebook', id: m[1] }
    const fbid = (path === '/permalink.php' || path === '/story.php') ? q.get('story_fbid') : (path === '/photo' || path === '/photo.php') ? q.get('fbid') : path === '/watch' ? q.get('v') : null
    return fbid && /^[A-Za-z0-9]{5,80}$/.test(fbid) ? { platform: 'facebook', id: fbid } : null
  }
  if (host === 'linkedin.com') {
    if ((m = /^\/posts\/[^/]*?-(?:activity|share|ugcpost)-(\d{15,22})-[A-Za-z0-9_-]{1,10}$/i.exec(path))) return { platform: 'linkedin', id: m[1] }
    if ((m = /^\/feed\/update\/urn:li:(?:activity|share|ugcPost):(\d{15,22})$/i.exec(decodeURIComponent(path)))) return { platform: 'linkedin', id: m[1] }
    return null
  }
  if (host === 'x.com' || host === 'twitter.com') {
    if ((m = /^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status(?:es)?\/(\d{5,25})(?:\/(?:photo|video)\/\d)?$/.exec(path))) return { platform: 'x', id: m[1] }
    return null
  }
  if (host === 'tiktok.com') {
    if ((m = /^\/@[A-Za-z0-9._-]{1,40}\/(?:video|photo)\/(\d{5,25})$/.exec(path))) return { platform: 'tiktok', id: m[1] }
    return null
  }
  if (host === 'youtube.com') {
    const v = path === '/watch' ? q.get('v') : (m = /^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})$/.exec(path)) ? m[1] : null
    return v && YT_ID.test(v) ? { platform: 'youtube', id: v } : null
  }
  if (host === 'youtu.be') { const v = path.slice(1); return YT_ID.test(v) ? { platform: 'youtube', id: v } : null }
  return null
}
const same = (a: SocialPostRef | null, b: SocialPostRef | null) => !!a && !!b && a.platform === b.platform && a.id === b.id

// The post's day from a stated instant: ISO text (offsets honoured, a zoneless time read as UTC) or epoch seconds. Null for
// anything that is not a real instant, before 2000, or after today (UTC) at `now`.
export function postDay(v: unknown, now: number): string | null {
  const n = typeof v === 'string' && /^\d{9,11}$/.test(v) ? Number(v) : v
  const day = typeof n === 'number' ? (Number.isInteger(n) && n > 0 ? postingDay(n * 1000) : null) : typeof n === 'string' && /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(n.trim()) ? postingDay(n) : null
  return day && day <= new Date(now).toISOString().slice(0, 10) ? day : null
}

// --- a minimal JSON reader for one object inside a page's embedded script data (never evaluates anything) ---
function skipString(s: string, i: number): number { for (i++; i < s.length; i++) { if (s[i] === '\\') i++; else if (s[i] === '"') return i + 1 } return -1 }
function skipValue(s: string, i: number): number {
  const c = s[i]
  if (c === '"') return skipString(s, i)
  if (c === '{' || c === '[') {
    let depth = 0
    while (i < s.length) {
      const ch = s[i]
      if (ch === '"') { i = skipString(s, i); if (i < 0) return -1; continue }
      if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') { if (--depth === 0) return i + 1 }
      i++
    }
    return -1
  }
  const m = /^[-+0-9.eEa-z]{1,40}/.exec(s.slice(i, i + 40)); return m ? i + m[0].length : -1
}
// From a key inside an object, the rest of THAT object's own keys (nested objects are values, never read as its keys).
// Bounded; a malformed object ends the read with what was read so far.
function restOfObject(s: string, i: number, max = 400_000): Map<string, unknown> {
  const out = new Map<string, unknown>(), end = Math.min(s.length, i + max)
  const ws = () => { while (i < end && /\s/.test(s[i])) i++ }
  while (i < end) {
    ws(); if (s[i] === ',') { i++; continue }
    if (s[i] !== '"') return out
    const ke = skipString(s, i); if (ke < 0) return out
    let key: unknown; try { key = JSON.parse(s.slice(i, ke)) } catch { return out }
    i = ke; ws(); if (s[i] !== ':') return out
    i++; ws(); const ve = skipValue(s, i); if (ve < 0 || ve > end) return out
    let val: unknown; try { val = JSON.parse(s.slice(i, ve)) } catch { val = undefined }
    if (typeof key === 'string' && !out.has(key)) out.set(key, val)
    i = ve
  }
  return out
}
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// line breaks are kept: a caption ends its sentences with them as often as with punctuation
const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n\s*/g, '\n').trim().slice(0, 5000) : '')
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const toText = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, e: string) => {
  if (e[0] !== '#') return ENT[e.toLowerCase()] ?? ' '
  const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
  return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : ' '
}).replace(/\s+/g, ' ').trim()

type Found = { day: string; texts: string[] }
const POST_TYPES = new Set(['SocialMediaPosting', 'DiscussionForumPosting', 'VideoObject', 'ImageObject', 'BlogPosting'])
// schema.org: a post entity at the top of a JSON-LD block (or in its @graph) whose url / @id / mainEntityOfPage names exactly
// this post. Its own datePublished, else uploadDate, else dateCreated; nested entities (comments, the author) are not it.
function fromJsonLd(html: string, ref: SocialPostRef, now: number): Found[] {
  const out: Found[] = []
  let n = 0
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    if (++n > 24) break
    if (m[1].length > 400_000) continue
    let j: unknown; try { j = JSON.parse(m[1]) } catch { continue }
    const top = (Array.isArray(j) ? j : [j]).flatMap(x => (x && typeof x === 'object' && Array.isArray((x as { '@graph'?: unknown })['@graph']) ? [x, ...((x as { '@graph': unknown[] })['@graph'])] : [x]))
    for (const e of top) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) continue
      const o = e as Record<string, unknown>
      const types = (Array.isArray(o['@type']) ? o['@type'] : [o['@type']]).map(t => String(t).replace(/^https?:\/\/schema\.org\//, ''))
      if (!types.some(t => POST_TYPES.has(t))) continue
      const main = o.mainEntityOfPage
      const ids = [o.url, o['@id'], typeof main === 'string' ? main : main && typeof main === 'object' ? (main as Record<string, unknown>)['@id'] : null].filter((x): x is string => typeof x === 'string')
      if (!ids.some(u => same(socialPostRef(u), ref))) continue
      const day = postDay(o.datePublished ?? o.uploadDate ?? o.dateCreated, now)
      if (day) out.push({ day, texts: [o.articleBody, o.text, o.headline, o.name, o.description].map(str).filter(Boolean) })
    }
  }
  return out
}
// Instagram's embedded media record for exactly this shortcode (observed live 2026-11-13): "code":"<sc>","taken_at":<seconds>,
// and the same object's caption text. A record of another shortcode is another post.
function fromInstagram(html: string, ref: SocialPostRef, now: number): Found[] {
  const out: Found[] = []
  for (const m of html.matchAll(new RegExp(`"code"\\s*:\\s*"${esc(ref.id)}"\\s*,\\s*"taken_at"\\s*:\\s*(\\d{9,11})\\b`, 'g'))) {
    const day = postDay(Number(m[1]), now); if (!day) continue
    const rest = restOfObject(html, m.index!)
    const cap = rest.get('caption')
    out.push({ day, texts: [str(cap && typeof cap === 'object' ? (cap as Record<string, unknown>).text : null)].filter(Boolean) })
  }
  return out
}
// TikTok's item record for exactly this video id: "id":"<id>" with the same object's createTime and desc.
function fromTikTok(html: string, ref: SocialPostRef, now: number): Found[] {
  const out: Found[] = []
  for (const m of html.matchAll(new RegExp(`"id"\\s*:\\s*"${esc(ref.id)}"`, 'g'))) {
    const rest = restOfObject(html, m.index!)
    if (!rest.has('createTime')) continue
    const day = postDay(rest.get('createTime'), now); if (!day) continue
    out.push({ day, texts: [str(rest.get('desc'))].filter(Boolean) })
  }
  return out
}
// X (a rendered page): the <time datetime> inside the permalink to exactly this status id, and the first tweetText of the
// same <article> (the post's own text; a quoted post's text comes after it and has its own permalink and time).
function fromX(html: string, ref: SocialPostRef, now: number): Found[] {
  const out: Found[] = []
  const re = new RegExp(`<a\\b[^>]*\\bhref\\s*=\\s*["'](?:https?://(?:www\\.|mobile\\.)?(?:x|twitter)\\.com)?/[A-Za-z0-9_]{1,15}/status/${esc(ref.id)}["'][^>]*>\\s*<time\\b[^>]*\\bdatetime\\s*=\\s*["']([^"']{8,40})["']`, 'gi')
  for (const m of html.matchAll(re)) {
    const day = postDay(m[1], now); if (!day) continue
    const a = html.lastIndexOf('<article', m.index!), z = html.indexOf('</article>', m.index!)
    const texts: string[] = []
    if (a >= 0 && z > m.index! && html.lastIndexOf('</article>', m.index!) < a) {
      const body = html.slice(a, z), t = /<div\b[^>]*data-testid\s*=\s*["']tweetText["'][^>]*>/i.exec(body)
      if (t) {
        let depth = 1; const i = t.index + t[0].length
        for (const d of body.slice(i).matchAll(/<(\/?)div\b[^>]*>/gi)) { depth += d[1] ? -1 : 1; if (depth === 0) { texts.push(str(toText(body.slice(i, i + d.index!)))); break } }
      }
    }
    out.push({ day, texts: texts.filter(Boolean) })
  }
  return out
}

// The post's own publish day and text, read from the page's structured data, or null. `rawUrl` is the URL the lead cites;
// `finalUrl` the one the page was read from after redirects: both must name the same post (a redirect to a login page, a
// profile or another post names none). One distinct day across everything read, or none.
export function socialPostOf(rawUrl: string, finalUrl: string, html: string, now: number = Date.now()): SocialPost | null {
  const ref = socialPostRef(rawUrl)
  if (!ref || !same(ref, socialPostRef(finalUrl))) return null
  const found = [...fromJsonLd(html, ref, now), ...(ref.platform === 'instagram' ? fromInstagram(html, ref, now) : ref.platform === 'tiktok' ? fromTikTok(html, ref, now) : ref.platform === 'x' ? fromX(html, ref, now) : [])]
  const days = new Set(found.map(f => f.day))
  if (days.size !== 1) return null
  return { ...ref, day: [...days][0], texts: [...new Set(found.flatMap(f => f.texts))] }
}

const ws = (s: string) => s.replace(/\s+/g, ' ').trim()
// #878 review (CHANGES at ad04c841): the post's time is the event's day only when NOTHING in the quote or in the post's sentence
// that carries it says when: any stated day (datePositions), any year, a month or weekday name, today / tomorrow / yesterday /
// tonight, this / last / next <anything>, a season, "N days ago", "for five years", "since ...", "recently", "back in", and
// future or ongoing wording (opening, opens, will, coming, soon, upcoming, planned). Any of them means the statement carries its
// own time (or none we can read), so the post day is not taken: the text binding alone decides, as on any page. Fail closed.
const MONTH = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i
const MAY = /\bMay\b/   // "may" the verb is not a month: only the capitalised word counts (in any position)
const WHEN = /\b(?:(?:mon|tues|wednes|thurs|fri|satur|sun)days?|weekends?|today|tonight|tomorrow|yesterday|(?:this|last|next|past|coming|previous|following|same|that)\s+(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day|week|weekend|month|year|season|morning|afternoon|evening|night|day|time|spring|summer|fall|autumn|winter|quarter)|spring|summer|fall|autumn|winter|ago|since|recent(?:ly)?|earlier|later|back\s+in|for\s+(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|many|a\s+few|over|more\s+than|nearly|almost)\b[^.!?]{0,20}?\b(?:days?|weeks?|months?|years?|decades?)|years?\s+(?:of|in\s+business)|anniversary|throwback|flashback|tbt|opening|opens|will|shall|going\s+to|coming|soon|upcoming|plan(?:s|ning)?\s+to|planned|next|holidays?|christmas|xmas|easter|thanksgiving|hanukk?ah|diwali|eid|ramadan|halloween|valentine'?s?|new\s+year'?s?|the\s+other\s+(?:day|week|month)|one\s+day|a\s+while|a\s+few\s+(?:days|weeks|months|years)|before|after|during|until|till|throughout|around\s+the|by\s+the\s+end|in\s+time\s+for|decades?|centur(?:y|ies))\b|\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+Day\b/i
const YEAR = /\b(?:19|20)\d\d\b/
function statesTime(s: string): string | null {
  if (datePositions(s).length) return 'a stated day'
  if (YEAR.test(s) || eventYears(s).length) return 'a year'
  if (MONTH.test(s.replace(/\bmay\b/g, ' ')) || MAY.test(s)) return 'a month'
  const w = WHEN.exec(s); return w ? `"${w[0]}"` : null
}
// A post about another company's event: the company is named only after a congratulation / thanks / "at" / "to" / "for" / "with"
// ("Congrats to our friends at Northwind Dental on opening ..."): the post's author is someone else and its day is theirs.
function thirdParty(sentence: string, company: string): boolean {
  const name = ws(company).toLowerCase(), low = sentence.toLowerCase()
  if (name.length < 2) return false
  const at: number[] = []
  for (let i = low.indexOf(name); i >= 0; i = low.indexOf(name, i + 1)) at.push(i)
  if (!at.length) return false
  if (/\b(?:congrat\w*|kudos|thanks?|thank\s+you|shout\s*-?\s*out|cheers|proud\s+of|happy\s+for|excited\s+for)\b/i.test(sentence.slice(0, at[0]))) return true
  // every mention is an object ("at / to / for / with / from / of / by" right before it): the company is never the one speaking
  return at.every(i => !/\bwelcome\s+to\s+$/i.test(sentence.slice(0, i)) && /\b(?:at|to|for|with|from|of|by)\s+(?:(?:our|the|my|your)\s+)?(?:(?:friends?|neighbou?rs?|team|folks|people|partners?|clients?)\s+(?:at|from)\s+)?$/i.test(sentence.slice(0, i)))
}

// #878 review round 2 (8e38655d): a blocklist of time words always leaks ("is set to open", "on the 25th", "in Q3", any other
// language), so the post day is taken only on an ALLOW-LIST; anything else is undated (fail closed). For the quote's own sentence
// (the post's sentences that the quote overlaps; a line break, ". ", "! ", "? " or ": " ends one):
//  (a) the sentence that names the company states a COMPLETED event in English, from a fixed list for the kind the claim needs;
//  (b) no digits, except a street address after "at" / "on" (a number and a street word) and a postcode;
//  (c) no time or future wording (statesTime, the round-1 list, kept as a second guard);
//  (d) English: no non-English function words, and non-ASCII letters do not dominate.
// Other sentences of the caption ("open late Mondays", "you will love our team", "at 2050 Queen St E") never block.
const STREET = String.raw`(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Way|Lane|Ln|Cres|Crescent|Pl|Place|Ct|Court|Pkwy|Parkway|Sq|Square|Terrace|Trail|Line|Sideroad|Concession)`
const ADDRESS = new RegExp(String.raw`\b(?:at|on)\s+(?:(?:unit|suite|ste)\s*\d{1,5}[A-Za-z]?\s*[,-]?\s*)?\d{1,6}[A-Za-z]?(?:-\d{1,6})?\s+(?:[A-Z][\w'’.-]*\s+){0,4}${STREET}\b\.?(?:\s+(?:N|S|E|W|North|South|East|West)\b\.?)?|\b(?:at|on)\s+(?:Hwy|Highway|Route|Regional\s+Road)\s+\d{1,4}\b`, 'g')
const NAMED_STREET = new RegExp(String.raw`\b(?:[A-Z][\w'’-]*\s+){1,3}${STREET}\b\.?(?:\s+(?:N|S|E|W|North|South|East|West)\b\.?)?`, 'g')
const POSTCODE = /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b|\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\s+\d{5}(?:-\d{4})?\b/g
const FOREIGN_STRONG = /\b(?:hace|semanas|wochen|vor\s+\w+\s+(?:tagen|wochen|monaten|jahren)|depuis|il\s+y\s+a|atr[áa]s|abri[óo]|abre|abrimos|nueva|nuevo|cl[ií]nica|semana|pr[óo]xim[oa]|ouvre|ouvert|ouverture|nouvelle|nouveau|bient[ôo]t|clinique|semaine|er[öo]ffnet|er[öo]ffnung|n[äa]chste|neue|praxis|woche|aperto|apre|nuova|apriamo|abriu|aberta|inaugur\w+)\b/i
const FOREIGN_WEAK = /\b(?:el|la|los|las|del|una|un|y|con|por|para|est[áa]|le|les|des|une|et|à|au|aux|est|dans|pour|avec|der|die|das|und|ein|eine|mit|ist|im|zur|zum|il|di|che|della|nel|e|o|em|os|da|do|uma)\b/gi
function englishEnough(s: string): boolean {
  if (FOREIGN_STRONG.test(s)) return false
  const weak = new Set((s.match(FOREIGN_WEAK) ?? []).map(w => w.toLowerCase()).filter(w => w !== 'a' && w !== 'e' && w !== 'o'))
  if (weak.size >= 2) return false
  const letters = [...s.matchAll(/\p{L}/gu)].length, other = [...s.matchAll(/[^\x00-\x7F]/gu)].filter(m => /\p{L}/u.test(m[0])).length
  return letters === 0 || other / letters <= 0.15
}
// sentences as [start, end) spans; "St." / "Ave." / "Dr." and the like do not end one
function sentenceSpans(t: string): [number, number][] {
  const out: [number, number][] = []; let start = 0
  for (const m of t.matchAll(/\n+|[.!?:]+(?=\s)/g)) {
    if (m[0][0] === '.' && /\b(?:St|Ave|Rd|Dr|Blvd|Cres|Pl|Ct|Ln|Mr|Mrs|Ms|Dr|Inc|Ltd|Co|No|Ste|N|S|E|W)$/.test(t.slice(Math.max(0, m.index! - 5), m.index!))) continue
    const end = m.index! + m[0].length
    if (end > start) out.push([start, end])
    start = end
  }
  if (start < t.length) out.push([start, t.length])
  return out
}

// #878 review round 3 (e7592d02): the SHAPE of the whole sentence is allow-listed, not only its predicate ("bookings now open", "is
// open late", "opened a GoFundMe", "opened when the pandemic hit" all carried an allowed predicate). The quote's sentence must be,
// and be nothing but (emoji aside):
//   [lead-in: "Big news", "We're thrilled to announce", "Huge thanks to our team", ... ending in ":" "!" "," or "that"]
//   <the company, or We / Our team> [has/have/is/are/'s/'re/'ve] [just/officially/finally/now] <predicate>
//   [for "opened" only: a/our/the [new] [second ...] location/clinic/office/practice/branch/studio/store/shop/doors]
//   [in/at/on <Capitalised Place words or a street address>]{0,2} [", <City>"]
//   [", our [second ...] [new] clinic/location/..."] [" for patients / new patients / business / appointments"]
// or the greeting "Welcome to <company> [<Place>][, our second clinic], now open [in <Place>] [for patients]". Predicates: opening
// "opened" (also has/have/just/officially/finally opened) or "now / officially / just / finally open" (bare "is open" and "open for
// business" are not read); hiring "is / are / 're / now hiring [a|an] <up to 4 role words> [for|at our <Place> clinic|team ...]".
// "first", "originally", "initially", "re-opened", "reopen", "again" anywhere refuse. Every other sentence the quote overlaps must
// be a lead-in alone. The time (b, c) and English (d) guards still apply.
const ci = (w: string) => w.replace(/[A-Za-z]/, c => `[${c.toLowerCase()}${c.toUpperCase()}]`)   // the first letter in either case ("Now open")
// review round 4 (79df6607): a capitalised word in the place / city / role slots is never a time or an occasion ("in Lent", "at Year
// End", "in Pride Month", ", Back Then", "a hygienist previously"): these words, and any -ly word, are refused there.
const NOT_PLACE = String.raw`(?:Month|Week|Weekend|Season|Year|End|Then|Ago|Lockdown|Pandemic|COVID(?:-19)?|Lent|Passover|Advent|Pride|Midsummer|Mayo|Holiday|Holidays|Eve|Christmas|Easter|Ramadan|Diwali|Hanukkah|Thanksgiving|Halloween|Day|Night|Morning|Today|Tonight|Now|[A-Za-z]+ly)\b`
const CAP = String.raw`(?:(?!${NOT_PLACE})[A-Z][\w'’.&-]*)`
const PLACE_WORDS = String.raw`${CAP}(?:\s+(?:${CAP}|of|on|the|de|du))*`
const ADDR = String.raw`\d{1,6}[A-Za-z]?\s+(?:${CAP}\s+){0,4}${STREET}\.?(?:\s+(?:N|S|E|W|North|South|East|West)\.?)?|(?:Hwy|Highway|Route)\s+\d{1,4}`
const PLACE = String.raw`(?:\s+(?:in|at|on)\s+(?:the\s+)?(?:${ADDR}|${PLACE_WORDS})){0,2}(?:,\s+${CAP}(?:\s+${CAP})?)?`
const NTH = String.raw`(?:(?:second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d{1,2}(?:st|nd|rd|th))\s+)?`
// a role word: not a preposition (no "for <event>" tail), not a time / occasion word, not an -ly word
const ROLE = String.raw`(?!(?:for|at|in|on|during|before|after|since|until|till|with|from|to|of|by|when|while|then|ago|back|previously|again|${NOT_PLACE.slice(3, -3)})\b)[\w'’-]+`
const NOUN = String.raw`(?:location|clinic|office|practice|branch|studio|store|shop)`
const TRAIL = String.raw`(?:,?\s+(?:our|the|its)\s+${NTH}(?:new\s+)?${NOUN}(?:\s+in\s+${PLACE_WORDS})?)?(?:,?\s+(?:now\s+open\s+)?for\s+(?:patients|new\s+patients|business|appointments))?`
const LEADIN = String.raw`(?:(?:Big|Great|Exciting|Good|Happy|Some)\s+news|We['’]re\s+(?:so\s+)?(?:thrilled|excited|happy|proud|delighted)(?:\s+to\s+(?:announce|share))?|So\s+excited|Exciting\s+times|Huge\s+thanks\s+to\s+our\s+team|Thank\s+you(?:\s+to\s+our\s+(?:team|patients|community))?)`
const LEAD_ONLY = new RegExp(String.raw`^${LEADIN}\s*[:!,.]?$`, 'i')
const RETRO_WORDS = /\b(?:first|originally|initially|re-?opened|re-?open(?:s|ing)?|again)\b/i
const stripEmoji = (s: string) => s.replace(/[\p{Extended_Pictographic}‍️⃣]/gu, ' ').replace(/\s+/g, ' ').trim()
function shapeOf(sentence: string, company: string, kind: 'event' | 'hiring'): 'main' | 'lead' | null {
  const t = stripEmoji(sentence).replace(/\s*[.!]+$/, '')
  if (!t) return 'lead'
  if (LEAD_ONLY.test(t)) return 'lead'
  if (RETRO_WORDS.test(t)) return null
  const co = ws(company).split(' ').map(w => ci(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('\\s+')
  const subj = String.raw`(?:${co}|${ci('we')}|${ci('our')}\s+team)`
  const lead = String.raw`(?:${LEADIN}\s*(?:[:!,]|\s+that)\s*)?`
  const pred = kind === 'hiring'
    ? String.raw`(?:\s+(?:is|are)|['’]re)?\s+(?:${ci('now')}\s+)?hiring(?:\s+(?:an?\s+)?(?:${ROLE}\s+){0,3}${ROLE})?(?:\s+(?:for|at)\s+our\s+(?:${CAP}\s+)?(?:${NOUN}|team))?`
    : String.raw`(?:(?:\s+(?:has|have)|['’]ve)?(?:\s+(?:just|officially|finally))?\s+opened(?:\s+(?:a|our|the|its)\s+(?:brand[- ]new\s+|new\s+)?${NTH}(?:new\s+)?(?:${NOUN}|doors))?|(?:\s+(?:is|are)|['’](?:s|re))?\s+(?:now|officially|just|finally)(?:\s+(?:now|officially))?\s+open)`
  const main = new RegExp(String.raw`^${lead}${subj}${pred}${PLACE}${TRAIL}$`)
  if (main.test(t)) return 'main'
  if (kind !== 'hiring' && new RegExp(String.raw`^${ci('welcome')}\s+to\s+(?:the\s+)?${co}(?:\s+${CAP}){0,2}(?:,\s+our\s+${NTH}(?:new\s+)?${NOUN})?,?\s+(?:now|officially)\s+open${PLACE}(?:\s+for\s+(?:patients|new\s+patients|business|appointments))?$`).test(t)) return 'main'
  return null
}

// review round 4 (79df6607): a time anywhere in the post's own text (another line, a heading such as "Last week:" or "Back in 2019:",
// a closing "That was in 2019") may date the statement, so the WHOLE caption is checked: any year or stated day outside a street
// address / postcode, any month name, ago / back in / remember / that was / since / anniversary / throwback / #tbt, last / this / next
// / past + a time word, and "<N> years / months / weeks / days ago / later". Weekday and opening-hours wording in another sentence
// ("Open late Mondays") stays allowed.
const WHOLE_WHEN = /\b(?:ago|back\s+in|remember(?:ing)?|that\s+was|since|anniversary|throwback|flashback|tbt|(?:last|this|next|past)\s+(?:week|weekend|month|year|season|spring|summer|fall|autumn|winter|quarter|day|night|morning|time|(?:mon|tues|wednes|thurs|fri|satur|sun)day)|(?:years?|months?|weeks?|days?)\s+(?:ago|later|earlier))\b/i
function postTimeGuard(raw: string): string | null {
  const t = raw.replace(ADDRESS, ' ').replace(POSTCODE, ' ').replace(NAMED_STREET, ' ')
  if (datePositions(t).length) return 'a stated day'
  if (YEAR.test(t) || eventYears(t).length) return 'a year'
  if (MONTH.test(t.replace(/\bmay\b/g, ' ')) || MAY.test(t)) return 'a month'
  const w = WHOLE_WHEN.exec(t); return w ? `"${w[0]}"` : null
}
// A first-person statement ("We opened ...") is the post author's. A post that congratulates or speaks of the company as a client /
// friend anywhere is someone else's, so its "we" is not the company.
const OTHERS_POST = /\b(?:congrat\w*|kudos|shout\s*-?\s*outs?|proud\s+of\s+(?:our\s+)?(?:clients?|friends?|partners?|neighbou?rs?)|(?:our\s+)?(?:clients?|friends?|partners?|neighbou?rs?|customers?)\s+(?:at|from)\b)/i

// Does the post's own publish time date THIS company's event in THIS quote? Only when the quote is in the post's own text, its
// sentences pass the allow-list above, the post is not another party's (thirdParty), and the existing binding rule (eventDateBound)
// ties the day to this company and event when the post's day stands as the dateline of that sentence.
// kind: the claim the lead makes ('hiring' reads the hiring predicates, anything else the opening predicates).
export function socialPostBound(post: SocialPost | null | undefined, quote: string, company: string, kind: 'event' | 'hiring' = 'event'): { bound: boolean; why: string } {
  if (!post) return { bound: false, why: 'no social post record' }
  const q = ws(quote).replace(/^(?:\.{3,}|…)+\s*/, '').replace(/\s*(?:\.{3,}|…)+$/, '')
  if (q.length < 20) return { bound: false, why: 'no quote' }
  const raw = post.texts.find(t => ws(t).toLowerCase().includes(q.toLowerCase()))
  if (raw === undefined) return { bound: false, why: "the quote is not in the post's own text" }
  const whole = postTimeGuard(raw)
  if (whole) return { bound: false, why: `the post's own text states another time (${whole}), so its publish day may not be its event's day` }
  const text = raw.replace(/[ \t\r\f\v]+/g, ' ')
  const m = new RegExp(q.split(' ').map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'i').exec(text)
  if (!m) return { bound: false, why: "the quote is not in the post's own text" }
  const qs = m.index, qe = m.index + m[0].length
  const spans = sentenceSpans(text).filter(([a, b]) => a < qe && b > qs)
  const name = ws(company).toLowerCase()
  let main: { sentence: string } | null = null
  for (const [a, b] of spans) {
    const sentence = ws(text.slice(a, b))
    if (!englishEnough(sentence)) return { bound: false, why: 'the sentence is not English, so its wording cannot be read' }
    // a street address ("at 2050 Queen St E", "on Spring Garden Road") and a postcode are places, not times
    const place = sentence.replace(ADDRESS, ' ').replace(POSTCODE, ' ').replace(NAMED_STREET, ' ')
    if (/\d/.test(place)) return { bound: false, why: "the quote's sentence carries a number that is not a street address, so it may state its own time" }
    const when = statesTime(place)
    if (when) return { bound: false, why: `the quote's sentence states its own time (${when}), so the post's day is not its event's day` }
    const shape = shapeOf(sentence, company, kind)
    if (!shape) return { bound: false, why: `the quote's sentence is not a plain statement that this company ${kind === 'hiring' ? 'is hiring' : 'opened or is now open'} (the allowed sentence shape)` }
    if (shape === 'main' && !main) main = { sentence }
  }
  if (!main) return { bound: false, why: `the quote's sentence states no completed ${kind === 'hiring' ? 'hiring' : 'opening'} event in the allowed shape` }
  if (thirdParty(main.sentence, company)) return { bound: false, why: "the post speaks about this company from someone else's side" }
  // first person ("We're hiring ...", "Our team opened ..."): the post's own statement; the company it belongs to is the verifier's
  // check (the quote or the page heading names it). The text binding below needs the company named, so it is not asked.
  if (!main.sentence.toLowerCase().includes(name) && OTHERS_POST.test(raw)) return { bound: false, why: "a first-person statement in a post that speaks of this company as someone else's" }
  if (!main.sentence.toLowerCase().includes(name)) return { bound: true, why: `the ${post.platform} post's own structured publish time for exactly this post URL, as the dateline of its own first-person text` }
  // the post's day stands as the dateline of the statement about the company: from its first mention in that sentence (what comes
  // before it, a greeting such as "Welcome to", was judged by thirdParty above)
  const from = main.sentence.slice(main.sentence.toLowerCase().indexOf(name))
  const b = eventDateBound(post.day, `${post.day} - ${from}`, from, company)
  return b.bound
    ? { bound: true, why: `the ${post.platform} post's own structured publish time for exactly this post URL, as the dateline of its own text` }
    : { bound: false, why: `the post's day is not tied to this company and event by its own text (${b.why})` }
}
