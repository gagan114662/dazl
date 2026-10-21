import type { Evidence, SourceAdapter } from './types.ts'

// V2EX public topics. Keyword search goes through sov2ex.com, a third-party search service
// (the keywords are sent to it). When that is down the adapter falls back to the official
// hot-topics API. Most V2EX posts are Chinese; the shared verifier works on latin text, so
// only topics with a latin-rich quote are returned - everything else would be dropped anyway.
const WINDOW_MS = 60 * 60 * 1000
const MAX_CALLS = Number(process.env.SOURCES_V2EX_PER_HOUR || 30)
const calls: number[] = []
const cache = new Map<string, { at: number; items: Evidence[] }>()

export function resetV2exState() { calls.length = 0; cache.clear() }

const latinRun = (s: string) => s.replace(/[^ -~]+/g, ' ').replace(/\s+/g, ' ').trim()
const usable = (s: string) => { const t = latinRun(s); return t.length >= 24 && /[a-z]{3}/i.test(t) }

export function pickQuote(title: string, content: string, keywords: string[]): string {
  const text = latinRun(content)
  for (const k of keywords) {
    const at = text.toLowerCase().indexOf(k)
    if (at >= 0) {
      const slice = text.slice(Math.max(0, at - 60), at + 240).trim()
      if (usable(slice)) return slice.slice(0, 300)
    }
  }
  if (usable(text)) return text.slice(0, 300)
  const t = latinRun(title)
  return usable(t) ? t.slice(0, 300) : ''
}

interface Topic { id: number; title: string; content: string; created: number }

export function toEvidence(topics: Topic[], keywords: string[]): Evidence[] {
  const out: Evidence[] = []
  for (const t of topics) {
    const quote = pickQuote(t.title ?? '', (t.content ?? '').slice(0, 4000), keywords)
    if (!quote) continue
    const d = new Date((t.created ?? 0) * 1000)
    out.push({ source: 'v2ex', url: `https://www.v2ex.com/t/${t.id}`, title: latinRun(t.title ?? '').slice(0, 200) || `V2EX topic ${t.id}`, quote, date: Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10) })
  }
  return out.slice(0, 10)
}

export const v2exAdapter: SourceAdapter = {
  id: 'v2ex',
  label: 'V2EX (public topics)',
  async collect({ keywords, http }) {
    if (keywords.length === 0) return []
    const q = keywords.slice(0, 4).join(' ')
    const hit = cache.get(q)
    if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit.items
    const now = Date.now()
    while (calls.length && now - calls[0] > WINDOW_MS) calls.shift()
    if (calls.length >= MAX_CALLS) return []
    calls.push(now)
    let items: Evidence[] = []
    const r = await http(`https://www.sov2ex.com/api/search?q=${encodeURIComponent(q)}&size=15&sort=created`)
    if (r && r.status === 200) {
      try {
        const json = JSON.parse(r.body) as { hits?: { _id: string; _source?: { title?: string; content?: string; created?: string } }[] }
        const topics = (json.hits ?? []).map(h => ({ id: Number(h._id), title: h._source?.title ?? '', content: h._source?.content ?? '', created: Math.floor(new Date(h._source?.created ?? '').getTime() / 1000) })).filter(t => t.id > 0)
        items = toEvidence(topics, keywords)
      } catch { items = [] }
    }
    if (items.length === 0) {
      const hot = await http('https://www.v2ex.com/api/topics/hot.json', { accept: 'application/json' })
      if (hot && hot.status === 200) {
        try {
          const topics = (JSON.parse(hot.body) as { id: number; title?: string; content?: string; created?: number }[]).map(t => ({ id: t.id, title: t.title ?? '', content: t.content ?? '', created: t.created ?? 0 }))
          const kws = keywords.map(k => k.toLowerCase())
          items = toEvidence(topics.filter(t => kws.some(k => `${t.title} ${t.content}`.toLowerCase().includes(k))), keywords)
        } catch { items = [] }
      }
    }
    cache.set(q, { at: now, items })
    return items
  },
}
