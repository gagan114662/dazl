// What a reply says, safely (#368): the NEW text of one Gmail message, from its MIME tree, without quoted history.
// Pure: no network, no model, nothing stored. Used by reply sync (lib/outreach/replies.ts) to classify replies.
//   - Walks nested multipart; skips attachments and forwarded or attached messages (message/rfc822).
//   - Prefers text/plain; falls back to text/html, reduced to text with scripts, styles and markup removed.
//   - Quoted history is dropped: HTML quote containers (blockquote, Gmail/Yahoo/Outlook/Thunderbird reply blocks) and
//     everything after them, then ">" lines and "On ... wrote:" style headers in several languages.
//   - A body that cannot be decoded is reported as malformed, never as an empty (harmless) reply.
export interface GPart { mimeType?: string; filename?: string; body?: { data?: string; attachmentId?: string; size?: number }; parts?: GPart[]; headers?: { name: string; value: string }[] }
export type TextStatus = 'ok' | 'empty' | 'malformed'
export interface ExtractedText { text: string; status: TextStatus; source: 'plain' | 'html' | 'none' }

const MAX_DEPTH = 12
const B64URL = /^[A-Za-z0-9_-]*={0,2}$/

const hdr = (p: GPart, n: string) => p.headers?.find(h => h.name.toLowerCase() === n)?.value ?? ''
const isAttachment = (p: GPart) => !!p.filename || /^\s*attachment\b/i.test(hdr(p, 'content-disposition')) || !!p.body?.attachmentId

// Decodes one body: base64url bytes in the part's charset. null: not decodable.
function decode(p: GPart): string | null {
  const data = p.body?.data
  if (!data) return ''
  if (!B64URL.test(data)) return null
  const bytes = Buffer.from(data, 'base64url')
  const charset = (/charset="?([\w.:-]+)"?/i.exec(hdr(p, 'content-type'))?.[1] ?? 'utf-8').toLowerCase()
  let text: string
  try { text = new TextDecoder(charset, { fatal: false }).decode(bytes) } catch { text = new TextDecoder('utf-8').decode(bytes) }
  // mostly replacement characters: not text in the charset it claims
  const bad = (text.match(/�/g) ?? []).length
  if (text.length && bad / text.length > 0.05) return null
  return text.replace(/\0/g, '')
}

// The first readable body of a type, depth-first, outside attachments and forwarded messages.
function find(p: GPart | undefined, type: string, depth = 0): { text: string | null } | undefined {
  if (!p || depth > MAX_DEPTH) return undefined
  const mt = (p.mimeType ?? '').toLowerCase()
  if (mt === 'message/rfc822' || (depth > 0 && isAttachment(p))) return undefined
  if (mt === type) return { text: decode(p) }
  for (const c of p.parts ?? []) { const r = find(c, type, depth + 1); if (r && r.text !== '') return r }
  return undefined
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: '...' }
function entities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ' }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}
// Where quoted history starts in an HTML reply: everything from the first of these on is the earlier conversation.
const HTML_QUOTE = /<blockquote\b|<div[^>]*\bclass=["'][^"']*\b(gmail_quote|gmail_attr|yahoo_quoted|moz-cite-prefix|OutlookMessageHeader)\b|<[^>]*\bid=["'](divRplyFwdMsg|appendonsend|reply-intro|isForwardContent)["']|<hr[^>]*\bid=["']stopSpelling["']/i
export function htmlToText(html: string): string {
  let h = html.slice(0, 500_000)
  const q = HTML_QUOTE.exec(h)
  if (q) h = h.slice(0, q.index)
  h = h.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|title|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d|p|div|li|tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
  return entities(h).replace(/[ \t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').trim()
}

// Lines that start quoted history in a plain-text reply ("On <date>, <name> wrote:" and its translations, Outlook
// headers, forwarded-message separators). Cut at the first one; ">" lines are dropped wherever they are.
const QUOTE_HEADER = new RegExp([
  String.raw`On .{0,160}wrote:`, String.raw`El .{0,160}escribi[oó]:`, String.raw`Le .{0,160}a [ée]crit\s?:`, String.raw`Am .{0,160}schrieb.{0,80}:`,
  String.raw`Em .{0,160}escreveu:`, String.raw`Il .{0,160}ha scritto:`, String.raw`Op .{0,160}schreef.{0,80}:`,
  String.raw`-{2,}\s*(Original Message|Mensaje original|Message d'origine|Urspr[üu]ngliche Nachricht|Mensagem original|Messaggio originale|Oorspronkelijk bericht)`,
  String.raw`-{2,}\s*Forwarded message`, String.raw`(From|De|Von|Da|Van|Från|Fra)\s?: .{0,200}`,
].map(s => `(?:${s})`).join('|'), 'i')
export function newText(t: string): string {
  const lines = t.split(/\r?\n/)
  const out: string[] = []
  for (const l of lines) {
    if (QUOTE_HEADER.test(l.trim()) && /^(?:-{2,}|(?:on|el|le|am|em|il|op|from|de|von|da|van|från|fra)(?![\p{L}]))/iu.test(l.trim())) break
    if (l.trimStart().startsWith('>')) continue
    out.push(l)
  }
  return out.join(' ').replace(/\s+/g, ' ').trim()
}

// The new text of one message. Plain text first; HTML when there is no plain part (or it is empty).
export function messageText(payload: GPart | undefined): ExtractedText {
  if (!payload) return { text: '', status: 'empty', source: 'none' }
  const plain = find(payload, 'text/plain')
  if (plain && plain.text === null) return { text: '', status: 'malformed', source: 'plain' }
  if (plain && plain.text) { const t = newText(plain.text); if (t) return { text: t, status: 'ok', source: 'plain' } }
  const html = find(payload, 'text/html')
  if (html && html.text === null) return { text: '', status: 'malformed', source: 'html' }
  if (html && html.text) { const t = newText(htmlToText(html.text)); if (t) return { text: t, status: 'ok', source: 'html' } }
  return { text: '', status: 'empty', source: plain ? 'plain' : html ? 'html' : 'none' }
}

// The whole readable body (no quote removal): what a delivery-failure notice says, wherever it says it.
export function fullText(payload: GPart | undefined): string {
  const p = find(payload, 'text/plain'), h = find(payload, 'text/html')
  return [p?.text ?? '', h?.text ? entities(h.text.replace(/<[^>]*>/g, ' ')) : ''].join('\n')
}
