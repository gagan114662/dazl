// Shared helpers for the session worker. No dependencies, Node 22+.

export interface WorkerItem { url: string; title: string; quote: string; date: string | null; login_walled: boolean }

// The app's verifier works on latin text (its normalizer strips CJK), so CJK-only quotes can never
// verify. Fetchers for Chinese platforms filter to latin-usable quotes, same as the V2EX adapter.
export const latinRun = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/[^ -~]+/g, ' ').replace(/\s+/g, ' ').trim()
export const latinUsable = (s: string) => { const t = latinRun(s); return t.length >= 24 && /[a-z]{3}/i.test(t) }

export interface FetchOptions { cookie?: string; headers?: Record<string, string>; timeoutMs?: number }

// Plain GET JSON with the tenant's session cookie. 15s cap, 1MB body cap, no redirects off-site.
export async function getJson(url: string, opts: FetchOptions = {}): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        accept: 'application/json',
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...opts.headers,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    })
    if (!res.ok) return null
    const text = await res.text()
    if (text.length > 1_000_000) return null
    return JSON.parse(text)
  } catch { return null }
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
