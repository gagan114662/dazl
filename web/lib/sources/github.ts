import { isRecord, looksLikeHtml, statusNote, type Evidence, type SourceAdapter } from './types.ts'

// GitHub official REST search (public data, no token). Same job as the gh backend in Agent Reach.
// Unauthenticated limit is 60 requests an hour per server IP (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api),
// shared by all tenants, so calls are capped here and the result is cached briefly.
const WINDOW_MS = 60 * 60 * 1000
const MAX_CALLS = Number(process.env.SOURCES_GITHUB_PER_HOUR || 30)
const calls: number[] = []
const cache = new Map<string, { at: number; items: Evidence[] }>()

export function resetGithubState() { calls.length = 0; cache.clear() }

export const githubAdapter: SourceAdapter = {
  id: 'github',
  label: 'GitHub (public repositories)',
  async collect({ keywords, http, note: report }) {
    // A fetch during which anything was noted is never cached (a cache hit replays items with no note: a false healthy result).
    let noted = false
    const note = (code: string) => { noted = true; report?.(code) }
    const terms = keywords.slice(0, 4)
    if (terms.length === 0) return []
    const q = terms.join(' ')
    const hit = cache.get(q)
    if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit.items
    const now = Date.now()
    while (calls.length && now - calls[0] > WINDOW_MS) calls.shift()
    if (calls.length >= MAX_CALLS) { note('budget'); return [] }
    calls.push(now)
    const r = await http(`https://api.github.com/search/repositories?q=${encodeURIComponent(`${q} in:description,readme`)}&sort=updated&order=desc&per_page=15`, { accept: 'application/vnd.github+json', headers: { 'x-github-api-version': '2022-11-28' } })
    if (!r) { note('unreachable'); return [] }
    if (r.status !== 200) { note(statusNote(r.status)); return [] }
    if (r.truncated) { note('oversize'); return [] } // never parse a prefix
    if (looksLikeHtml(r.body)) { note('challenge'); return [] }
    let json: unknown
    try { json = JSON.parse(r.body) } catch { note('unparseable'); return [] }
    // the documented search envelope: an object with an items ARRAY. {} / null / items: {} is a schema failure, not "no repositories".
    if (!isRecord(json) || !Array.isArray(json.items)) { note('malformed'); return [] }
    if (json.incomplete_results === true) note('incomplete')
    const out: Evidence[] = []
    let bad = 0
    for (const it of json.items as unknown[]) {
      if (!isRecord(it) || typeof it.html_url !== 'string' || typeof it.full_name !== 'string') { bad++; continue }
      const desc = typeof it.description === 'string' ? it.description.replace(/\s+/g, ' ').trim() : ''
      const url = typeof it.html_url === 'string' ? it.html_url : ''
      // pushed_at is when the repo was last updated, not when anything relevant happened: it is kept as `updated`, never as the event date.
      const pushed = typeof it.pushed_at === 'string' ? it.pushed_at.slice(0, 10) : null
      if (desc.length < 20 || !/^https:\/\/github\.com\//.test(url)) continue
      out.push({ source: 'github', url, title: String(it.full_name ?? '').slice(0, 200), quote: desc.slice(0, 300), date: null, updated: pushed && /^\d{4}-\d{2}-\d{2}$/.test(pushed) ? pushed : null, origin: 'owner_self_description' })
    }
    if (bad) note('malformed_rows')   // the valid repositories are kept; the run reads partial
    if (!noted) cache.set(q, { at: now, items: out })
    return out
  },
}
