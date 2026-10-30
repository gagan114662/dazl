// The worker's /fetch answer for one request body, apart from HTTP plumbing, so it can be tested without a socket.
// A search the platform answered is 200 {items} (possibly empty: that really found nothing). Every other outcome is
// a non-2xx with {error: <kind>}, so the app never records a failure or an unsupported platform as an empty search
// (#436):
//   400 bad_request | unknown_platform     the request itself is wrong
//   400 no_session                         no session sent, or not the cookie the platform needs
//   501 unsupported (+ reason)             the platform has no fetcher (UNSUPPORTED); nothing is fetched
//   502 auth | throttled | schema | upstream | worker_error   the fetch failed, with why (util.ts FetchFailure)
import { FETCHERS, isPlatform, UNSUPPORTED, type Fetcher, type Platform } from './fetchers.ts'
import { FetchFailure } from './util.ts'

export interface Reply { status: number; body: Record<string, unknown> }
export async function handleFetch(raw: string, env: Record<string, string | undefined>, fetchers: Partial<Record<Platform, Fetcher>> = FETCHERS, timeoutMs = 40_000): Promise<Reply> {
  let parsed: { platform?: unknown; query?: unknown; session?: unknown }
  try { parsed = JSON.parse(raw) } catch { return { status: 400, body: { error: 'bad_request' } } }
  if (!isPlatform(parsed?.platform)) return { status: 400, body: { error: 'unknown_platform' } }
  const p = parsed.platform
  const fetcher = fetchers[p]
  if (UNSUPPORTED[p] || !fetcher) return { status: 501, body: { error: 'unsupported', reason: UNSUPPORTED[p] ?? 'no fetcher for this platform' } }
  const query = typeof parsed.query === 'string' ? parsed.query.slice(0, 300) : ''
  const session = typeof parsed.session === 'string' ? parsed.session.slice(0, 8000) : ''
  if (!query) return { status: 400, body: { error: 'bad_request' } }
  if (!session) return { status: 400, body: { error: 'no_session' } }
  let timer: NodeJS.Timeout | undefined
  try {
    const items = await Promise.race([
      fetcher(query, session, env),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new FetchFailure('upstream')), timeoutMs) }),
    ])
    return { status: 200, body: { items: items.slice(0, 20) } }
  } catch (e) {
    if (e instanceof FetchFailure) return { status: e.kind === 'no_session' ? 400 : 502, body: { error: e.kind } }
    return { status: 502, body: { error: 'worker_error' } } // a fetcher bug: still a failure, never "no results"
  } finally { clearTimeout(timer) }
}
