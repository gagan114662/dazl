// Shared helpers for the session worker. No dependencies, Node 22+.

export interface WorkerItem { url: string; title: string; quote: string; date: string | null; login_walled: boolean }

// The app's verifier works on latin text (its normalizer strips CJK), so CJK-only quotes can never
// verify. Fetchers for Chinese platforms filter to latin-usable quotes, same as the V2EX adapter.
export const latinRun = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/[^ -~]+/g, ' ').replace(/\s+/g, ' ').trim()
export const latinUsable = (s: string) => { const t = latinRun(s); return t.length >= 24 && /[a-z]{3}/i.test(t) }

export interface FetchOptions { cookie?: string; headers?: Record<string, string>; timeoutMs?: number }

// Plain GET JSON with the tenant's session cookie. 15s cap, 1MB body cap, no redirects off-site.
// Why a fetch returned nothing, so the app can tell a genuine empty search from one that never happened (#436):
//   unsupported  this worker cannot read the platform at all (no request is made)
//   auth         the session is missing what the platform needs, or the platform refused it (401/403)
//   throttled    the platform rate limited the request (429)
//   schema       the platform answered with something that is not the expected shape (or not JSON)
//   upstream     the platform failed or could not be reached
export type FailureCode = 'unsupported' | 'auth' | 'throttled' | 'schema' | 'upstream'
export class WorkerFailure extends Error {
  readonly code: FailureCode
  constructor(code: FailureCode) { super(code); this.code = code }
}

// GET a JSON document. Throws WorkerFailure for every way it can fail; returns the parsed JSON otherwise.
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
  } catch { throw new WorkerFailure('upstream') }
  if (res.status === 401 || res.status === 403) throw new WorkerFailure('auth')
  if (res.status === 429) throw new WorkerFailure('throttled')
  if (!res.ok) throw new WorkerFailure('upstream')
  let text: string
  try { text = await res.text() } catch { throw new WorkerFailure('upstream') }
  if (text.length > 1_000_000) throw new WorkerFailure('schema')
  try { return JSON.parse(text) } catch { throw new WorkerFailure('schema') }
}
// The expected container is present in a parsed answer; otherwise it is not the shape we read.
export function expectShape(ok: boolean): void { if (!ok) throw new WorkerFailure('schema') }

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
