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
const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 5000) : '')
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
// The quote states its event at another time than the post's: "3 days ago", "last year", "yesterday", "since 2019", "back in",
// "soon", "tomorrow", "next month", "will open", "upcoming". The post's day is then not the event's day.
const OTHER_TIME = /\b(?:ago|last\s+(?:week|weekend|month|year|spring|summer|fall|autumn|winter)|yesterday|earlier\s+this|since|back\s+in|years?\s+(?:of|in\s+business)|soon|tomorrow|next\s+(?:week|weekend|month|year|spring|summer|fall|autumn|winter)|upcoming|will|shall|going\s+to)\b/i
// A post about another time altogether.
const RETRO = /\b(?:throwback|anniversary|flashback|tbt)\b/i

// Does the post's own publish time date THIS company's event in THIS quote? Only when the quote is in the post's own text,
// states no other time, and the existing binding rule (eventDateBound) ties the day to this company and event when the post's
// day stands as the dateline of the post's statement: "<day> - <the post's text from the quote on>".
export function socialPostBound(post: SocialPost | null | undefined, quote: string, company: string): { bound: boolean; why: string } {
  if (!post) return { bound: false, why: 'no social post record' }
  const q = ws(quote).replace(/^(?:\.{3,}|\u2026)+\s*/, '').replace(/\s*(?:\.{3,}|\u2026)+$/, '')
  if (q.length < 20) return { bound: false, why: 'no quote' }
  const own = post.texts.map(ws).find(t => t.toLowerCase().includes(q.toLowerCase()))
  if (!own) return { bound: false, why: "the quote is not in the post's own text" }
  if (RETRO.test(own)) return { bound: false, why: 'the post looks back at an earlier time' }
  if (OTHER_TIME.test(q)) return { bound: false, why: "the quote states another time than the post's" }
  const at = own.toLowerCase().indexOf(q.toLowerCase())
  const b = eventDateBound(post.day, `${post.day} - ${own.slice(at)}`, q, company)
  return b.bound
    ? { bound: true, why: `the ${post.platform} post's own structured publish time for exactly this post URL, as the dateline of its own text` }
    : { bound: false, why: `the post's day is not tied to this company and event by its own text (${b.why})` }
}
