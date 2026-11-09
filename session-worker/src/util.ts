// Shared helpers for the session worker. No dependencies, Node 22+.

// The post's own author as the platform reports it; fields the platform does not carry are null, never inferred.
// url is the author's profile website exactly as the platform payload reports it (the expanded link, never a
// redirect wrapper): the only affiliation-adjacent field X carries - the poster's SELF-ASSERTED claim, captured as
// attributed context for review, never verification of affiliation or a company.
export interface WorkerAuthor { name: string | null; headline: string | null; company: string | null; url: string | null }
export interface WorkerItem { url: string; title: string; quote: string; date: string | null; login_walled: boolean; author?: WorkerAuthor }

// The app's verifier works on latin text (its normalizer strips CJK), so CJK-only quotes can never
// verify. Fetchers for Chinese platforms filter to latin-usable quotes, same as the V2EX adapter.
export const latinRun = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/[^ -~]+/g, ' ').replace(/\s+/g, ' ').trim()
export const latinUsable = (s: string) => { const t = latinRun(s); return t.length >= 24 && /[a-z]{3}/i.test(t) }

export interface FetchOptions { cookie?: string; headers?: Record<string, string>; timeoutMs?: number }

// Why a supported fetch produced no list. Each is its own outcome, never a zero-result search:
// the platform rejected the session (auth), throttled it, or answered with something that is not
// the JSON this fetcher reads (schema). Anything else (network, 5xx, timeout) is upstream.
// 'challenge' (a checkpoint / captcha / bot block) is only produced by the LinkedIn engagers reader (src/linkedin-engagers.ts).
export type FailureKind = 'auth_failed' | 'throttled' | 'challenge' | 'schema_error' | 'upstream_error'
export class FetchFailure extends Error {
  readonly kind: FailureKind
  constructor(kind: FailureKind) { super(kind); this.kind = kind }
}

// Plain GET JSON with the tenant's session cookie. 15s cap, 1MB body cap, no redirects off-site.
// Returns the parsed body or throws FetchFailure - a failed request is never an empty result.
export async function getJson(url: string, opts: FetchOptions = {}): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        accept: 'application/json',
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...opts.headers,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    })
  } catch { throw new FetchFailure('upstream_error') }
  if (res.status === 401 || res.status === 403) throw new FetchFailure('auth_failed')
  if (res.status === 429) throw new FetchFailure('throttled')
  if (!res.ok) throw new FetchFailure('upstream_error')
  let text: string
  try { text = await res.text() } catch { throw new FetchFailure('upstream_error') }
  if (text.length > 1_000_000) throw new FetchFailure('schema_error')
  try { return JSON.parse(text) } catch { throw new FetchFailure('schema_error') }
}

export const item = (url: string, title: string, quote: string, date: string | null, login_walled = true): WorkerItem | null => {
  const q = latinRun(quote).slice(0, 300)
  if (!/^https:\/\/[^\s]{4,480}$/.test(url) || q.length < 20) return null
  return { url, title: latinRun(title).slice(0, 200) || url, quote: q, date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null, login_walled }
}

export const epochDay = (v: unknown): string | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n) || n <= 0) return null
  const d = new Date(n > 1e12 ? n : n * 1000)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}
