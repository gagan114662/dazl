import { isRecord, looksLikeHtml, statusNote, type Evidence, type SourceAdapter } from './types.ts'

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
// Validate every field consumed below before mapping. One malformed row must not throw through the envelope catch and
// discard its valid siblings. Missing/null optional fields keep the existing empty-text/unknown-date policy.
const optionalText = (v: unknown) => v == null || typeof v === 'string'
const topicId = (v: unknown) => (typeof v === 'string' || typeof v === 'number') && Number.isSafeInteger(Number(v)) && Number(v) > 0
const optionalEpoch = (v: unknown) => v == null || (typeof v === 'number' && Number.isFinite(v) && Number.isFinite(new Date(v * 1000).getTime()))


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

// Internal parse discriminator only: never an outbound app error type or a provider-supplied value.
const MALFORMED_ENVELOPE = Symbol('malformed envelope')

export const v2exAdapter: SourceAdapter = {
  id: 'v2ex',
  label: 'V2EX (public topics)',
  async collect({ keywords, http, note }) {
    if (keywords.length === 0) return []
    const q = keywords.slice(0, 4).join(' ')
    const hit = cache.get(q)
    if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit.items
    const now = Date.now()
    while (calls.length && now - calls[0] > WINDOW_MS) calls.shift()
    if (calls.length >= MAX_CALLS) { note?.('budget'); return [] }
    calls.push(now)
    // A fetch during which any failure was noted is never cached: a cache hit replays the items with no note,
    // so a repeat call inside the window would read a cached failure as a healthy empty - a false zero.
    let noted = false
    const noting = (code: string) => { noted = true; note?.(code) }
    let items: Evidence[] = []
    const r = await http(`https://www.sov2ex.com/api/search?q=${encodeURIComponent(q)}&size=15&sort=created`)
    if (!r) noting('unreachable')
    else if (r.status !== 200) noting(statusNote(r.status))
    else if (r.truncated) noting('oversize') // never parse a prefix
    else if (looksLikeHtml(r.body)) noting('challenge')
    else {
      try {
        const json = JSON.parse(r.body) as unknown
        // the search envelope: an object with a hits ARRAY; a row needs an _id and a _source object
        if (!isRecord(json) || !Array.isArray(json.hits)) throw MALFORMED_ENVELOPE
        const rows = (json.hits as unknown[]).filter((h): h is { _id: string; _source?: { title?: string; content?: string; created?: string } } => isRecord(h) && topicId(h._id) && isRecord(h._source) && optionalText(h._source.title) && optionalText(h._source.content) && optionalText(h._source.created))
        if (rows.length < json.hits.length) noting('malformed_rows')
        const topics = rows.map(h => ({ id: Number(h._id), title: h._source?.title ?? '', content: h._source?.content ?? '', created: Math.floor(new Date(h._source?.created ?? '').getTime() / 1000) })).filter(t => t.id > 0)
        items = toEvidence(topics, keywords)
      } catch (e) { noting(e === MALFORMED_ENVELOPE ? 'malformed' : 'unparseable'); items = [] }
    }
    if (items.length === 0) {
      const hot = await http('https://www.v2ex.com/api/topics/hot.json', { accept: 'application/json' })
      if (!hot) noting('unreachable')
      else if (hot.status !== 200) noting(statusNote(hot.status))
      else if (hot.truncated) noting('oversize') // never parse a prefix
      else if (looksLikeHtml(hot.body)) noting('challenge')
      else {
        try {
          const parsed = JSON.parse(hot.body) as unknown
          if (!Array.isArray(parsed)) throw MALFORMED_ENVELOPE
          const rows = parsed.filter((t): t is { id: number; title?: string; content?: string; created?: number } => isRecord(t) && typeof t.id === 'number' && topicId(t.id) && optionalText(t.title) && optionalText(t.content) && optionalEpoch(t.created))
          if (rows.length < parsed.length) noting('malformed_rows')
          const topics = rows.map(t => ({ id: t.id, title: t.title ?? '', content: t.content ?? '', created: t.created ?? 0 }))
          const kws = keywords.map(k => k.toLowerCase())
          items = toEvidence(topics.filter(t => kws.some(k => `${t.title} ${t.content}`.toLowerCase().includes(k))), keywords)
          // which backend answered: evidence from the hot list is a fallback, not the keyword search; the run says so and it is never cached as a search answer
          if (items.length) noting('answered_by_hot_fallback')
        } catch (e) { noting(e === MALFORMED_ENVELOPE ? 'malformed' : 'unparseable'); items = [] }
      }
    }
    if (!noted) cache.set(q, { at: now, items })
    return items
  },
}
