// Shared helpers for the session worker. No dependencies, Node 22+.

export interface WorkerItem { url: string; title: string; quote: string; date: string | null; login_walled: boolean }

// The app's verifier works on latin text (its normalizer strips CJK), so CJK-only quotes can never
// verify. Fetchers for Chinese platforms filter to latin-usable quotes, same as the V2EX adapter.
export const latinRun = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/[^ -~]+/g, ' ').replace(/\s+/g, ' ').trim()
export const latinUsable = (s: string) => { const t = latinRun(s); return t.length >= 24 && /[a-z]{3}/i.test(t) }

export interface FetchOptions { cookie?: string; headers?: Record<string, string>; timeoutMs?: number }

// Why a fetch produced no answer, so the app can tell it apart from a search that genuinely found nothing (#436):
//   no_session  the session is missing what the platform needs (no cookie, or the wrong one)
//   auth        the platform refused the session (401/403)
//   throttled   the platform rate-limited it (429)
//   schema      the platform answered, but not with the JSON the fetcher reads (or too large)
//   upstream    anything else: network, timeout, a redirect, another HTTP error
export type FailureKind = 'no_session' | 'auth' | 'throttled' | 'schema' | 'upstream'
export class FetchFailure extends Error { kind: FailureKind; constructor(kind: FailureKind) { super(kind); this.kind = kind } }

// Plain GET JSON with the tenant's session cookie. 15s cap, 1MB body cap, no redirects off-site. Throws FetchFailure.
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
  } catch { throw new FetchFailure('upstream') }
  if (res.status === 401 || res.status === 403) throw new FetchFailure('auth')
  if (res.status === 429) throw new FetchFailure('throttled')
  if (!res.ok) throw new FetchFailure('upstream')
  let text: string
  try { text = await res.text() } catch { throw new FetchFailure('upstream') }
  if (text.length > 1_000_000) throw new FetchFailure('schema')
  try { return JSON.parse(text) } catch { throw new FetchFailure('schema') }
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
