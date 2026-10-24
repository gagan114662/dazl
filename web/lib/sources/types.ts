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

export interface HttpResult { status: number; body: string }
export type SafeGet = (url: string, opts?: { accept?: string; headers?: Record<string, string> }) => Promise<HttpResult | null>

export interface AdapterInput {
  query: string
  keywords: string[]
  feeds: string[]
  pages?: string[] // page URLs the user asked to read; only the web (Jina) adapter uses it
  discovered?: string[] // URLs this scan's own search returned (raw hits and candidates); only the job-board adapter derives boards from them
  http: SafeGet
  credential?: string // reserved for future user-approved connectors; no adapter below uses it
}

export interface SourceAdapter {
  id: string
  label: string
  collect(input: AdapterInput): Promise<Evidence[]>
}
