import type { Evidence, SourceAdapter } from './types.ts'
import { mentionsKeyword } from './keywords.ts'
import { scriptOf } from '../text/multilingual.ts'

// Jina Reader (https://r.jina.ai) reads a public page and returns it as markdown. It is a third-party
// service: the page URL is sent to it. Without a key it rate limits (about 20 requests/minute when this
// was written), so calls are capped per scan and per hour here and cached briefly. The evidence still
// cites the ORIGINAL page: the standard verifier fetches that page itself and checks the quote on it.
const WINDOW_MS = 60 * 60 * 1000
const MAX_CALLS = Number(process.env.SOURCES_JINA_PER_HOUR || 120)
const PER_SCAN = 3
const calls: number[] = []
const cache = new Map<string, { at: number; items: Evidence[] }>()

export function resetJinaState() { calls.length = 0; cache.clear() }

export function parseReader(md: string): { title: string; published: string | null; content: string } {
  const title = md.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? ''
  const pub = md.match(/^Published Time:\s*(.+)$/m)?.[1]?.trim()
  const content = md.split(/^Markdown Content:\s*$/m)[1] ?? md
  const d = pub ? new Date(pub) : null
  return { title: title.slice(0, 200), published: d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null, content }
}

// A quote the verifier can find on the original page: text of any script (the verifier's norm keeps Arabic, Devanagari and
// Japanese since #391's predecessor; erasing them here left a Japanese page with no quote), 20-300 chars. Markdown syntax is
// stripped first - the original page shows the text, not the markup. Sentences end at '.', '。' or '۔'.
const stripMd = (s: string) => s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#*_\`>~|]/g, ' ')
const textRun = (s: string) => stripMd(s).replace(/[^\p{L}\p{M}\p{N}\p{P}\p{S} ]+/gu, ' ').replace(/\s+/g, ' ').trim()
const longEnough = (p: string) => scriptOf(p) === 'latin' || scriptOf(p) === 'none' ? p.length >= 40 : [...p].length >= 15
export function pickQuote(content: string, keywords: string[]): string {
  const paras = textRun(content).split(/\n{2,}|[.。۔]/).map(p => p.trim()).filter(p => longEnough(p) && /[\p{L}\p{N}]/u.test(p))
  const hit = keywords.length ? paras.find(p => mentionsKeyword(p, keywords)) : undefined
  const chosen = hit ?? paras[0] ?? ''
  return chosen.slice(0, 300)
}

export const jinaAdapter: SourceAdapter = {
  id: 'web',
  label: 'Web pages (read via Jina Reader)',
  async collect({ keywords, pages = [], http }) {
    const out: Evidence[] = []
    for (const page of pages.slice(0, PER_SCAN)) {
      const hit = cache.get(page)
      if (hit && Date.now() - hit.at < 15 * 60 * 1000) { out.push(...hit.items); continue }
      const now = Date.now()
      while (calls.length && now - calls[0] > WINDOW_MS) calls.shift()
      if (calls.length >= MAX_CALLS) break
      calls.push(now)
      const r = await http(`https://r.jina.ai/${page}`)
      if (!r || r.status !== 200) continue
      const { title, published, content } = parseReader(r.body)
      const quote = pickQuote(content, keywords)
      if (quote.length < 20) continue
      const items = [{ source: 'web', url: page, title: title || page, quote, date: published }]
      cache.set(page, { at: now, items })
      out.push(...items)
    }
    return out
  },
}
