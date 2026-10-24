import type { Evidence, SourceAdapter } from './types.ts'

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
  async collect({ keywords, http }) {
    const terms = keywords.slice(0, 4)
    if (terms.length === 0) return []
    const q = terms.join(' ')
    const hit = cache.get(q)
    if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit.items
    const now = Date.now()
    while (calls.length && now - calls[0] > WINDOW_MS) calls.shift()
    if (calls.length >= MAX_CALLS) return []
    calls.push(now)
    const r = await http(`https://api.github.com/search/repositories?q=${encodeURIComponent(`${q} in:description,readme`)}&sort=updated&order=desc&per_page=15`, { accept: 'application/vnd.github+json', headers: { 'x-github-api-version': '2022-11-28' } })
    if (!r || r.status !== 200) return []
    let json: { items?: Record<string, unknown>[] }
    try { json = JSON.parse(r.body) } catch { return [] }
    const out: Evidence[] = []
    for (const it of json.items ?? []) {
      const desc = typeof it.description === 'string' ? it.description.replace(/\s+/g, ' ').trim() : ''
      const url = typeof it.html_url === 'string' ? it.html_url : ''
      // pushed_at is when the repo was last updated, not when anything relevant happened: it is kept as `updated`, never as the event date.
      const pushed = typeof it.pushed_at === 'string' ? it.pushed_at.slice(0, 10) : null
      if (desc.length < 20 || !/^https:\/\/github\.com\//.test(url)) continue
      out.push({ source: 'github', url, title: String(it.full_name ?? '').slice(0, 200), quote: desc.slice(0, 300), date: null, updated: pushed && /^\d{4}-\d{2}-\d{2}$/.test(pushed) ? pushed : null, origin: 'owner_self_description' })
    }
    cache.set(q, { at: now, items: out })
    return out
  },
}
