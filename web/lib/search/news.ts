// Free news search: the GDELT Project DOC 2.0 API (https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/). A second
// search backend beside TinyFish, so lead finding does not depend on one provider's quota or coverage, and still works
// when TinyFish is off. Global news in 65+ languages, each article with its publisher URL, date and language. GDELT data
// is open for any use, commercial included, with attribution ("GDELT Project"), so evidence from here is labelled so.
// (Bing News RSS was tried first and dropped: its feed terms forbid commercial use.)
//
// Nothing here is business- or place-specific: the queries are the scan's own (already carrying the buyer's place),
// the language filter is the ICP's. GDELT asks for at most one request every 5 seconds, so every request in this
// process goes through one shared queue.
import type { SafeGet } from '../sources/types.ts'
import type { SearchHit } from './tinyfish.ts'

export const newsEnabled = (env: Record<string, string | undefined> = process.env) => env.NEWS_SEARCH_ENABLED !== '0'
export const NEWS_PER_SCAN = 3
export const NEWS_SOURCE = 'news:gdelt'
const GAP_MS = 5_100

// ISO 639-1 -> GDELT sourcelang name. Unknown codes mean no language filter (never a guess).
const LANG: Record<string, string> = { en: 'english', pt: 'portuguese', es: 'spanish', fr: 'french', de: 'german', it: 'italian', nl: 'dutch', hi: 'hindi', mr: 'marathi', ja: 'japanese', zh: 'chinese', ko: 'korean', ar: 'arabic', pl: 'polish', sv: 'swedish', tr: 'turkish', id: 'indonesian', ru: 'russian', uk: 'ukrainian', ro: 'romanian', cs: 'czech', da: 'danish', fi: 'finnish', no: 'norwegian', he: 'hebrew', th: 'thai', vi: 'vietnamese', ms: 'malay', bn: 'bengali', ta: 'tamil', te: 'telugu', ur: 'urdu', fa: 'persian', el: 'greek', hu: 'hungarian' }
export const gdeltLang = (language?: string) => (language ? LANG[language.toLowerCase()] ?? null : null)

// GDELT query syntax: quoted phrases and OR groups pass through; a language filter is appended when known.
export function newsUrl(query: string, lang: string | null, timespan = '1month'): string {
  const q = `${query.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 240)}${lang ? ` sourcelang:${lang}` : ''}`
  const p = new URLSearchParams({ query: q, mode: 'artlist', format: 'json', maxrecords: '15', timespan, sort: 'datedesc' })
  return `https://api.gdeltproject.org/api/v2/doc/doc?${p}`
}

// seendate is "20261021T061500Z". Titles come tokenized ("$1 . 5 million"); they are labels, never quoted as evidence.
export function parseGdelt(body: string, max = 15): SearchHit[] {
  let j: unknown
  try { j = JSON.parse(body) } catch { return [] }
  const arts = (j as { articles?: unknown })?.articles
  const out: SearchHit[] = []
  for (const a of Array.isArray(arts) ? arts : []) {
    const o = a as Record<string, unknown>
    if (typeof o.url !== 'string' || !/^https:\/\/[^\s]{4,480}$/.test(o.url) || typeof o.title !== 'string') continue
    const d = typeof o.seendate === 'string' ? o.seendate.match(/^(\d{4})(\d{2})(\d{2})T/) : null
    out.push({ url: o.url, title: o.title.replace(/\s+([.,:;!?%)])/g, '$1').replace(/([($])\s+/g, '$1').slice(0, 200), snippet: '', date: d ? `${d[1]}-${d[2]}-${d[3]}` : null })
    if (out.length >= max) break
  }
  return out
}

// One request at a time for the whole process, at least GAP_MS apart (GDELT's published limit).
let last = 0
let chain: Promise<unknown> = Promise.resolve()
export const resetNewsQueue = () => { last = 0; chain = Promise.resolve() }
function queued<T>(f: () => Promise<T>, gapMs: number, sleep: (ms: number) => Promise<void>): Promise<T> {
  const run = chain.then(async () => {
    const wait = last + gapMs - Date.now()
    if (wait > 0) await sleep(wait)
    try { return await f() } finally { last = Date.now() }
  })
  chain = run.catch(() => undefined)
  return run
}

// At most NEWS_PER_SCAN queries. A failed, limited or empty query only means fewer hits.
export async function newsSearch(http: SafeGet, queries: string[], language?: string, opts: { gapMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<SearchHit[]> {
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const lang = gdeltLang(language)
  const hits: SearchHit[] = []
  const seen = new Set<string>()
  for (const q of queries.slice(0, NEWS_PER_SCAN)) {
    const r = await queued(() => http(newsUrl(q, lang), { accept: 'application/json' }).catch(() => null), opts.gapMs ?? GAP_MS, sleep)
    if (!r || r.status !== 200 || !r.body) continue
    for (const h of parseGdelt(r.body)) if (!seen.has(h.url)) { seen.add(h.url); hits.push(h) }
  }
  return hits
}
