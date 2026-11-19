import { publicSourceHttps } from './http.ts'
import { looksLikeHtml, statusNote, type Evidence, type SafeGet, type SourceAdapter } from './types.ts'
import { paidVendorOn } from '../paid-vendors.ts'
import { classifyThin, htmlToText } from '../scan/fetch-page.ts'

// Jina Reader (https://r.jina.ai) reads a public page and returns it as markdown. It is a third-party
// service: the page URL is sent to it. Without a key it rate limits (about 20 requests/minute when this
// was written), so calls are capped per scan and per hour here and cached briefly. The evidence still
// cites the ORIGINAL page: the standard verifier fetches that page itself and checks the quote on it.
const WINDOW_MS = 60 * 60 * 1000
const MAX_CALLS = Number(process.env.SOURCES_JINA_PER_HOUR || 120)
const PER_SCAN = 3
const MAX_CACHED_QUOTES = 128
const calls: number[] = []
const cache = new Map<string, { at: number; items: Evidence[] }>()

function rememberQuote(key: string, val: { at: number; items: Evidence[] }) {
  cache.delete(key)
  if (cache.size >= MAX_CACHED_QUOTES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, val)
}

export function resetJinaState() { calls.length = 0; cache.clear() }

export function parseReader(md: string): { title: string; published: string | null; content: string } {
  const title = md.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? ''
  const pub = md.match(/^Published Time:\s*(.+)$/m)?.[1]?.trim()
  const content = md.split(/^Markdown Content:\s*$/m)[1] ?? md
  const d = pub ? new Date(pub) : null
  return { title: title.slice(0, 200), published: d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null, content }
}

// A quote the verifier can find on the original page: latin-alphanumeric text, 20-300 chars.
// Markdown syntax is stripped first - the original page shows the text, not the markup.
const stripMd = (s: string) => s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#*_\`>~|]/g, ' ')
const latinRun = (s: string) => stripMd(s).replace(/[^ -~]+/g, ' ').replace(/\s+/g, ' ').trim()
export function pickQuote(content: string, keywords: string[]): string {
  const paras = latinRun(content).split(/\n{2,}|\./).map(p => p.trim()).filter(p => p.length >= 40 && /[a-z0-9]/i.test(p))
  const hit = paras.find(p => keywords.some(k => p.toLowerCase().includes(k)))
  const chosen = hit ?? paras[0] ?? ''
  return chosen.slice(0, 300)
}

export const isReaderEnvelope = (body: string): boolean => !looksLikeHtml(body) && /^Markdown Content:\s*$/m.test(body) && /^(Title|URL Source):/m.test(body)

const DIRECT_REDIRECTS = new Set([301, 302, 303, 307, 308])
async function directRead(page: string, http: SafeGet) {
  let current: URL
  try { current = new URL(page) } catch { return null }
  const seen = new Set<string>()
  for (let hops = 0; hops <= 3; hops++) {
    current.hash = ''
    if (!publicSourceHttps(current) || seen.has(current.href)) return null
    seen.add(current.href)
    // Every hop uses the same guarded getter, including its per-request DNS
    // validation and the adapter's overall cancellation deadline.
    const r = await http(current.href)
    if (!r || !DIRECT_REDIRECTS.has(r.status) || !r.location || r.truncated) return r
    if (hops === 3) return null
    try { current = new URL(r.location, current) } catch { return null }
  }
  return null
}

export const jinaAdapter: SourceAdapter = {
  id: 'web',
  // Refs #1099 (lib/paid-vendors.ts): Jina Reader is a third-party service, used only when the operator named 'jina' in DAZL_PAID_VENDORS;
  // by default the page is read directly by dazl (the adapter's own guarded http, the same HTML-to-text as the verifier's fetch).
  get label() { return paidVendorOn('jina') ? 'Web pages (read via Jina Reader)' : 'Web pages (read directly by dazl)' },
  async collect({ keywords, pages = [], http, note }) {
    const out: Evidence[] = []
    const viaJina = paidVendorOn('jina')
    const terms = [...new Set(keywords.map(k => k.trim().toLowerCase()).filter(Boolean))].sort()
    for (const page of pages.slice(0, PER_SCAN)) {
      const cacheKey = JSON.stringify([viaJina ? 'jina' : 'direct', page, terms])
      const hit = cache.get(cacheKey)
      if (hit && Date.now() - hit.at < 15 * 60 * 1000) { out.push(...hit.items); continue }
      if (!viaJina) {
        const r = await directRead(page, http)
        if (!r) { note?.('unreachable'); continue }
        if (r.status !== 200) { note?.(statusNote(r.status)); continue }
        if (r.truncated) { note?.('oversize'); continue } // never parse a prefix
        if (!/^(text\/html|application\/xhtml\+xml)$/i.test(r.contentType?.split(';', 1)[0]?.trim() ?? '') || !looksLikeHtml(r.body)) { note?.('malformed'); continue }
        const { text, title, published } = htmlToText(r.body)
        // a bot wall or a JS-only shell is not a reading of the page (the verifier's fetch refuses the same pages)
        const thin = classifyThin(r.body, text)
        if (thin) { note?.(thin === 'blocked' ? 'challenge' : 'js_required'); continue }
        const quote = pickQuote(text, terms)
        if (quote.length < 20) { note?.('no_readable_text'); continue }
        const items = [{ source: 'web', url: page, title: title || page, quote, date: published }]
        rememberQuote(cacheKey, { at: Date.now(), items })
        out.push(...items)
        continue
      }
      const now = Date.now()
      while (calls.length && now - calls[0] > WINDOW_MS) calls.shift()
      if (calls.length >= MAX_CALLS) { note?.('budget'); break }
      calls.push(now)
      const r = await http(`https://r.jina.ai/${page}`)
      if (!r) { note?.('unreachable'); continue }
      if (r.status !== 200) { note?.(statusNote(r.status)); continue }
      if (r.truncated) { note?.('oversize'); continue } // never parse a prefix
      // #906: the reader's documented envelope (Title / URL Source / Markdown Content headers). An HTML page or arbitrary text
      // is not a reading of the page; a page with no readable passage is noted, never a silent nothing.
      if (!isReaderEnvelope(r.body)) { note?.(looksLikeHtml(r.body) ? 'challenge' : 'malformed'); continue }
      const { title, published, content } = parseReader(r.body)
      const quote = pickQuote(content, terms)
      if (quote.length < 20) { note?.('no_readable_text'); continue }
      const items = [{ source: 'web', url: page, title: title || page, quote, date: published }]
      rememberQuote(cacheKey, { at: now, items })
      out.push(...items)
    }
    return out
  },
}
