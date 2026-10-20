import type { Evidence, SourceAdapter } from './types.ts'

// RSS 2.0 and Atom. Same job as the feedparser backend in Agent Reach, written as a tiny parser with no dependency.
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
export function decodeText(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim()
}

const tag = (block: string, name: string) => block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))?.[1]

export function toDate(v: string | undefined): string | null {
  if (!v) return null
  const d = new Date(decodeText(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

export function parseFeed(xml: string, max = 30): Omit<Evidence, 'source'>[] {
  const items = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].slice(0, max)
  const out: Omit<Evidence, 'source'>[] = []
  for (const [, , block] of items) {
    const title = decodeText(tag(block, 'title') ?? '')
    const linkText = tag(block, 'link')
    const href = block.match(/<link[^>]*\shref=["']([^"']+)["']/i)?.[1]
    const url = decodeText(href ?? linkText ?? '')
    if (!/^https:\/\//.test(url) || url.length > 500 || title.length < 20) continue
    out.push({ url, title: title.slice(0, 200), quote: title.slice(0, 300), date: toDate(tag(block, 'pubDate') ?? tag(block, 'published') ?? tag(block, 'updated') ?? tag(block, 'dc:date')) })
  }
  return out
}

export const rssAdapter: SourceAdapter = {
  id: 'rss',
  label: 'RSS and Atom feeds',
  async collect({ keywords, feeds, http }) {
    const out: Evidence[] = []
    for (const feed of feeds.slice(0, 5)) {
      const r = await http(feed, { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9' })
      if (!r || r.status !== 200) continue
      for (const e of parseFeed(r.body)) {
        const hay = e.title.toLowerCase()
        if (keywords.length === 0 || keywords.some(k => hay.includes(k))) out.push({ source: 'rss', ...e })
      }
    }
    return out.slice(0, 30)
  },
}
