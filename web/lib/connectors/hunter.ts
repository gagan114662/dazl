import type { Enrichment } from './store.ts'

// Hunter (https://hunter.io/api-documentation/v2): domain search by company name. Official API, the user's own key.
// An email is kept only if Hunter lists at least one source page with a URL and a date. We use the most recent
// last_seen_on (falling back to extracted_on). Emails without a dated source are discarded.
const BASE = 'https://api.hunter.io/v2'
const TIMEOUT_MS = 15_000

export type KeyCheck = 'valid' | 'invalid' | 'unavailable'

export async function validateHunterKey(key: string, fetchImpl: typeof fetch = fetch): Promise<KeyCheck> {
  try {
    const res = await fetchImpl(`${BASE}/account`, { headers: { 'X-API-KEY': key }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (res.ok) return 'valid'
    return res.status === 401 || res.status === 403 ? 'invalid' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

interface HunterSource { uri?: unknown; extracted_on?: unknown; last_seen_on?: unknown; still_on_page?: unknown }
interface HunterEmail { value?: unknown; type?: unknown; confidence?: unknown; first_name?: unknown; last_name?: unknown; position?: unknown; sources?: unknown }

const DATE = /^\d{4}-\d{2}-\d{2}$/
const isHttp = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//i.test(u) && u.length <= 500

export type HunterResult = { ok: true; enrichments: Enrichment[]; rawCount: number } | { ok: false; reason: 'auth' | 'rate_limited' | 'error' }

export function parseDomainSearch(json: unknown, now = Math.floor(Date.now() / 1000)): { enrichments: Enrichment[]; rawCount: number } {
  const emails = ((json as { data?: { emails?: unknown } })?.data?.emails ?? []) as unknown
  const list = Array.isArray(emails) ? (emails as HunterEmail[]) : []
  const out: Enrichment[] = []
  for (const e of list) {
    if (typeof e.value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.value) || e.value.length > 254) continue
    const sources = (Array.isArray(e.sources) ? (e.sources as HunterSource[]) : []).filter(s => isHttp(s.uri) && (DATE.test(String(s.last_seen_on)) || DATE.test(String(s.extracted_on))))
    if (sources.length === 0) continue
    const dated = sources.map(s => ({ url: s.uri as string, date: DATE.test(String(s.last_seen_on)) ? String(s.last_seen_on) : String(s.extracted_on) })).sort((a, b) => (a.date < b.date ? 1 : -1))[0]
    const name = [e.first_name, e.last_name].filter(x => typeof x === 'string' && x).join(' ')
    const position = typeof e.position === 'string' ? e.position : ''
    const label = [name, position].filter(Boolean).join(', ').slice(0, 200) || null
    out.push({
      connector: 'hunter', kind: e.type === 'generic' ? 'generic_email' : 'email', value: e.value, label,
      confidence: typeof e.confidence === 'number' ? Math.max(0, Math.min(100, Math.round(e.confidence))) : null,
      source_url: dated.url, source_date: dated.date, retrieved_at: now,
    })
  }
  return { enrichments: out, rawCount: list.length }
}

export async function hunterDomainSearch(key: string, company: string, fetchImpl: typeof fetch = fetch, limit = 5): Promise<HunterResult> {
  try {
    const url = `${BASE}/domain-search?company=${encodeURIComponent(company)}&limit=${limit}`
    const res = await fetchImpl(url, { headers: { 'X-API-KEY': key }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (res.status === 401) return { ok: false, reason: 'auth' }
    if (res.status === 403 || res.status === 429) return { ok: false, reason: 'rate_limited' }
    if (!res.ok) return { ok: false, reason: 'error' }
    return { ok: true, ...parseDomainSearch(await res.json()) }
  } catch {
    return { ok: false, reason: 'error' }
  }
}
