// Source adapters collect public, dated evidence for a scan. They are deliberately small and isolated:
//  - they receive plain data (the request, keywords, feed URLs) and a guarded HTTP function,
//  - they never see the database, tenant keys or any credential,
//  - they return Evidence items, which the model may turn into leads. Every lead is then checked by the
//    normal verifier against the page it cites, exactly like web-search leads.
// Adapters that need a user's own approved credential (an OAuth token or API key) can be added later: the runner
// would pass that credential in via `AdapterInput.credential`, and only for that adapter.
export interface Evidence {
  source: string // adapter id
  url: string // public https page
  title: string
  quote: string // text expected to appear on that page, 20-300 chars
  date: string | null // YYYY-MM-DD: the date the SOURCE states for the event/post itself. Never a crawl, push or update time.
  updated?: string | null // YYYY-MM-DD: when the source was last changed (e.g. repo push). Context only, not an event date.
  origin?: 'owner_self_description' // text the item's owner wrote about their own project/product: evidence of what they build, not of a need
}

export interface HttpResult { status: number; body: string; truncated?: boolean; location?: string } // truncated: the body hit the byte cap and was cut; location: a 3xx answer's Location header (the getter never follows it)
// #906: what a non-answer is. A 200 whose body is an HTML page (a bot challenge, a login wall, an error page) is not data;
// 401/403/429 are auth or throttling, distinct from a generic HTTP error. Neither may ever read as a healthy empty.
export const looksLikeHtml = (body: string): boolean => /^\s*(<!doctype html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(body)
export const statusNote = (status: number): string => status === 401 || status === 403 ? 'auth_or_blocked' : status === 429 ? 'throttled' : 'http_error'
export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export type SafeGet = (url: string, opts?: { accept?: string; headers?: Record<string, string> }) => Promise<HttpResult | null>

export interface AdapterInput {
  query: string
  keywords: string[]
  feeds: string[]
  pages?: string[] // page URLs the user asked to read; only the web (Jina) adapter uses it
  page?: (url: string) => Promise<string | null> // the posting page's text via the scan's own page fetcher; null when it could not be fetched
  note?: (code: string) => void // an adapter reports a partial result (oversize, unparseable, unreachable, budget); a healthy empty reports nothing
  discovered?: string[] // URLs this scan's own search returned (raw hits and candidates); only the job-board adapter derives boards from them
  companies?: { name: string; domain?: string | null }[] // companies this scan itself found (leads / seed): the job-board adapter probes their public boards by slug guess
  tally?: Partial<Record<'greenhouse' | 'lever' | 'ashby', { probed: number; failed: number; evidence: number }>> // the job-board adapter reports how each public board API went (boards asked / failed / postings kept), for per-board progress
  http: SafeGet
  credential?: string // reserved for future user-approved connectors; no adapter below uses it
}

export interface SourceAdapter {
  id: string
  label: string
  collect(input: AdapterInput): Promise<Evidence[]>
}
