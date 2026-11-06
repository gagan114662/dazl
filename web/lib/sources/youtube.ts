import { isRecord, looksLikeHtml, statusNote, type Evidence, type SourceAdapter } from './types.ts'

// YouTube public videos, two keyless-for-the-user backends:
//  - the official YouTube Data API when the operator sets YOUTUBE_API_KEY (free daily quota, no per-lookup cost), or
//  - public Piped instances (third-party services; the keywords are sent to them).
// The evidence quote is the video title verbatim: the standard verifier fetches the watch page, and the
// title is the text its HTML carries. Videos whose titles are too short to verify are dropped here.
const WINDOW_MS = 60 * 60 * 1000
const MAX_CALLS = Number(process.env.SOURCES_YOUTUBE_PER_HOUR || 30)
const PIPED = (process.env.SOURCES_PIPED_INSTANCES || 'api.piped.private.coffee,pipedapi.kavin.rocks,pipedapi.adminforge.de').split(',').map(s => s.trim()).filter(Boolean)
const calls: number[] = []
const cache = new Map<string, { at: number; items: Evidence[] }>()

export function resetYoutubeState() { calls.length = 0; cache.clear() }

const latinRun = (s: string) => s.replace(/[^ -~]+/g, ' ').replace(/\s+/g, ' ').trim()
const usable = (s: string) => { const t = latinRun(s); return t.length >= 20 && /[a-z]{3}/i.test(t) }

interface Video { id: string; title: string; published: string | null }

export function toEvidence(videos: Video[]): Evidence[] {
  const out: Evidence[] = []
  for (const v of videos) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(v.id)) continue
    const title = latinRun(v.title)
    if (!usable(title)) continue
    out.push({ source: 'youtube', url: `https://www.youtube.com/watch?v=${v.id}`, title: title.slice(0, 200), quote: title.slice(0, 300), date: v.published && /^\d{4}-\d{2}-\d{2}$/.test(v.published) ? v.published : null })
  }
  return out.slice(0, 10)
}

async function viaDataApi(q: string, key: string, http: Parameters<SourceAdapter['collect']>[0]['http'], note?: (code: string) => void): Promise<Evidence[]> {
  const r = await http(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&maxResults=15&q=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`, { accept: 'application/json' })
  if (!r) { note?.('unreachable'); return [] }
  if (r.status !== 200) { note?.(statusNote(r.status)); return [] }
  if (r.truncated) { note?.('oversize'); return [] } // never parse a prefix
  if (looksLikeHtml(r.body)) { note?.('challenge'); return [] }
  try {
    const json = JSON.parse(r.body) as unknown
    if (!isRecord(json) || !Array.isArray(json.items)) { note?.('malformed'); return [] }
    const rows = (json.items as unknown[]).filter((it): it is { id?: { videoId?: string }; snippet?: { title?: string; publishedAt?: string } } => isRecord(it) && isRecord(it.id) && typeof it.id.videoId === 'string' && isRecord(it.snippet) && typeof it.snippet.title === 'string')
    if (rows.length < json.items.length) note?.('malformed_rows')
    return toEvidence(rows.map(it => ({ id: it.id?.videoId ?? '', title: it.snippet?.title ?? '', published: (it.snippet?.publishedAt ?? '').slice(0, 10) || null })))
  } catch { note?.('unparseable'); return [] }
}

async function viaPiped(q: string, http: Parameters<SourceAdapter['collect']>[0]['http'], note?: (code: string) => void): Promise<Evidence[]> {
  for (const inst of PIPED) {
    const r = await http(`https://${inst}/search?q=${encodeURIComponent(q)}&filter=videos`, { accept: 'application/json' })
    if (!r) { note?.('unreachable'); continue }
    if (r.status !== 200) { note?.(statusNote(r.status)); continue }
    if (r.truncated) { note?.('oversize'); continue } // never parse a prefix
    if (looksLikeHtml(r.body)) { note?.('challenge'); continue }
    try {
      const json = JSON.parse(r.body) as unknown
      if (!isRecord(json) || !Array.isArray(json.items)) { note?.('malformed'); continue }
      const rows = (json.items as unknown[]).filter((it): it is { type?: string; url?: string; title?: string; uploaded?: number; uploadDate?: string } => isRecord(it) && typeof it.url === 'string' && typeof it.title === 'string')
      if (rows.length < json.items.length) note?.('malformed_rows')
      const items = toEvidence(rows.filter(it => (it.type ?? 'stream') === 'stream').map(it => {
        const id = (it.url ?? '').match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1] ?? ''
        const uploaded = typeof it.uploaded === 'number' && it.uploaded > 0 ? new Date(it.uploaded).toISOString().slice(0, 10) : null
        return { id, title: it.title ?? '', published: uploaded ?? (it.uploadDate ?? null) }
      }))
      if (items.length > 0) return items
    } catch { note?.('unparseable') /* try the next instance */ }
  }
  return []
}

export const youtubeAdapter: SourceAdapter = {
  id: 'youtube',
  label: 'YouTube (public videos)',
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
    // so a repeat call inside the window would read a cached failure as a healthy empty/ok - a false zero.
    let noted = false
    const noting = (code: string) => { noted = true; note?.(code) }
    const key = process.env.YOUTUBE_API_KEY ?? ''
    const items = key ? await viaDataApi(q, key, http, noting) : await viaPiped(q, http, noting)
    if (!noted) cache.set(q, { at: now, items })
    return items
  },
}
