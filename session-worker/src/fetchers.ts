// Platform fetchers. Each takes the tenant's own session cookie (they opted in and accepted the
// risk notice) and a query, and returns items for the app's evidence pipeline. Platforms that
// disallow automated access (X, Instagram, Facebook, LinkedIn) can rate-limit or ban the account:
// that risk is the tenant's acknowledged choice, and calls are rate-limited server-side.
import { epochDay, FetchFailure, getJson, item, latinRun, latinUsable, type FailureKind, type WorkerItem } from './util.ts'

export type Platform = 'x' | 'reddit' | 'instagram' | 'facebook' | 'bilibili' | 'xiaohongshu' | 'linkedin'
export type Fetcher = (query: string, session: string, env: Record<string, string | undefined>) => Promise<WorkerItem[]>

// --- A 200 JSON answer is not always a search result (#436). Each platform has its own error envelope (a login wall,
// a rate limit, a blocked request) and its own result container. Before parsing, every fetcher checks its answer:
//   - a known error envelope is that failure (auth_failed / throttled; any other platform error is upstream_error);
//   - an answer without the platform's result container is schema_error (a JSON login page, a changed API), never [];
//   - a result container that is present and empty is a genuine search that found nothing: [].
// Checks read only the envelope, never the items, so a changed item shape still degrades to fewer items, not a failure.
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)
const fail = (kind: FailureKind): never => { throw new FetchFailure(kind) }
// The recursive walkers (X, LinkedIn) on a hostile, deeply nested answer: a stack overflow is an unreadable answer.
const readable = <T>(f: () => T): T => { try { return f() } catch (e) { if (e instanceof RangeError) throw new FetchFailure('schema_error'); throw e } }
const httpKind = (status: unknown): FailureKind => (status === 401 || status === 403 ? 'auth_failed' : status === 429 ? 'throttled' : 'upstream_error')

// Reddit: {kind: 'Listing', data: {children: [...]}}; errors come back as {error: <http status>, message}.
export function checkReddit(raw: unknown): void {
  const o = obj(raw) ?? fail('schema_error')
  if (o.error !== undefined && o.error !== null) fail(httpKind(Number(o.error)))
  if (!Array.isArray(obj(o.data)?.children)) fail('schema_error')
}
// X GraphQL: {data: {search_by_raw_query: ...}}; a refusal is {errors: [{code}]} without data. 32/64/89/215/326 = the
// session is not authenticated, suspended or locked; 88 = rate limit.
const X_AUTH = new Set([32, 64, 89, 215, 326])
export function checkX(raw: unknown): void {
  const o = obj(raw) ?? fail('schema_error')
  const data = obj(o.data)
  if (Array.isArray(o.errors) && o.errors.length > 0 && !data?.search_by_raw_query) {
    const codes = o.errors.map(e => Number(obj(e)?.code))
    fail(codes.some(c => X_AUTH.has(c)) ? 'auth_failed' : codes.includes(88) ? 'throttled' : 'upstream_error')
  }
  if (!data || !('search_by_raw_query' in data)) fail('schema_error')
}
// Bilibili: {code: 0, data: {...}}; non-zero codes are refusals even on HTTP 200. -101 = not signed in, -111 = csrf;
// -352 (risk control), -412 (request blocked), -509 / -799 (too frequent) = throttled.
const BILI_AUTH = new Set([-101, -111]), BILI_THROTTLE = new Set([-352, -412, -509, -799])
export function checkBilibili(raw: unknown): void {
  const o = obj(raw) ?? fail('schema_error')
  if (typeof o.code !== 'number' || !Number.isInteger(o.code)) fail('schema_error')
  const code = o.code as number
  if (code !== 0) fail(BILI_AUTH.has(code) ? 'auth_failed' : BILI_THROTTLE.has(code) ? 'throttled' : 'upstream_error')
  const data = obj(o.data) ?? fail('schema_error')
  // No hits: Bilibili omits result or sends an empty one with numResults 0. Anything else without a list is a changed API.
  if (!Array.isArray(data.result) && !(data.result === undefined && data.numResults === 0)) fail('schema_error')
}
// Instagram topsearch: {users: [...], status: 'ok'}; a refusal is {status: 'fail', message, require_login?, spam?}.
export function checkInstagram(raw: unknown): void {
  const o = obj(raw) ?? fail('schema_error')
  if (o.status === 'fail') {
    const msg = typeof o.message === 'string' ? o.message.toLowerCase() : ''
    fail(o.require_login === true || msg === 'login_required' || msg === 'checkpoint_required' || msg === 'challenge_required' ? 'auth_failed'
      : o.spam === true || msg.includes('wait a few minutes') || msg === 'rate_limited' ? 'throttled' : 'upstream_error')
  }
  if (!Array.isArray(o.users)) fail('schema_error')
}
// LinkedIn voyager: {data, included} or {elements}; a refusal is {status: <http status>} without them.
export function checkLinkedin(raw: unknown): void {
  const o = obj(raw) ?? fail('schema_error')
  const hasResult = obj(o.data) !== null || Array.isArray(o.included) || Array.isArray(o.elements)
  if (!hasResult && typeof o.status === 'number') fail(httpKind(o.status))
  if (!hasResult) fail('schema_error')
}

// --- Reddit: public search JSON with the session cookie. ---
export function parseReddit(raw: unknown): WorkerItem[] {
  const children = (raw as { data?: { children?: { data?: Record<string, unknown> }[] } })?.data?.children ?? []
  const out: WorkerItem[] = []
  for (const c of children.slice(0, 15)) {
    const d = c.data ?? {}
    const permalink = typeof d.permalink === 'string' ? d.permalink : ''
    const quote = latinRun(typeof d.selftext === 'string' && d.selftext.length >= 20 ? d.selftext : String(d.title ?? ''))
    const it = item(`https://www.reddit.com${permalink}`, String(d.title ?? ''), quote, epochDay(d.created_utc))
    if (it) out.push(it)
  }
  return out
}
const reddit: Fetcher = async (query, session) => {
  const json = await getJson(`https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&limit=15&raw_json=1`, { cookie: session, headers: { referer: 'https://www.reddit.com/search/' } })
  checkReddit(json)
  return parseReddit(json)
}

// --- X: the web app's GraphQL SearchTimeline with the tenant's auth_token/ct0 cookies.
// The query id rotates; override with X_SEARCH_QUERY_ID when X changes it. ---
const X_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
export function parseX(raw: unknown): WorkerItem[] {
  const seen = new Set<string>()
  const out: WorkerItem[] = []
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return
    if (Array.isArray(v)) { for (const e of v) walk(e); return }
    const o = v as Record<string, unknown>
    const legacy = (o.tweet_results as { result?: { legacy?: Record<string, unknown>; core?: { user_results?: { result?: { legacy?: { screen_name?: string } } } } } })?.result?.legacy ?? (o.legacy as Record<string, unknown> | undefined)
    const user = (o.tweet_results as { result?: { core?: { user_results?: { result?: { legacy?: { screen_name?: string } } } } } })?.result?.core?.user_results?.result?.legacy
    if (legacy && typeof legacy.full_text === 'string' && typeof legacy.id_str === 'string' && !seen.has(legacy.id_str)) {
      seen.add(legacy.id_str)
      const screen = user?.screen_name ?? 'i'
      const d = typeof legacy.created_at === 'string' ? new Date(legacy.created_at) : null
      const it = item(`https://x.com/${screen}/status/${legacy.id_str}`, `${screen} on X`, legacy.full_text, d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null)
      if (it) out.push(it)
      if (out.length >= 15) return
    }
    for (const e of Object.values(o)) walk(e)
  }
  walk(raw)
  return out
}
const x: Fetcher = async (query, session, env) => {
  const authToken = session.match(/auth_token=([a-f0-9]{40})/)?.[1]
  const ct0 = session.match(/ct0=([a-f0-9]{32,})/)?.[1]
  const qid = env.X_SEARCH_QUERY_ID ?? 'nK1dw4tV3a2UD7G2b5E1AA' // SearchTimeline query id; rotates
  // No usable auth cookies: an auth failure, not a search that found nothing.
  if (!authToken || !ct0) throw new FetchFailure('auth_failed')
  const variables = JSON.stringify({ rawQuery: query, count: 15, querySource: 'typed_query', product: 'Latest' })
  const features = JSON.stringify({ rweb_video_screen_enabled: false, payments_enabled: false, profile_label_improvements_pcf_label_in_post_enabled: true })
  const url = `https://x.com/i/api/graphql/${qid}/SearchTimeline?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`
  const json = await getJson(url, { cookie: `auth_token=${authToken}; ct0=${ct0}`, headers: { authorization: `Bearer ${decodeURIComponent(X_BEARER)}`, 'x-csrf-token': ct0, 'x-twitter-active-user': 'yes', 'x-twitter-auth-type': 'OAuth2Session', referer: 'https://x.com/search' } })
  checkX(json)
  return readable(() => parseX(json))
}

// --- Bilibili: official web search API with the session cookie (SESSDATA). ---
export function parseBilibili(raw: unknown): WorkerItem[] {
  const result = (raw as { data?: { result?: Record<string, unknown>[] } })?.data?.result ?? []
  const out: WorkerItem[] = []
  for (const r of result.slice(0, 15)) {
    const bvid = typeof r.bvid === 'string' ? r.bvid : ''
    const quote = latinRun(String(r.description ?? '')) || latinRun(String(r.title ?? ''))
    if (!latinUsable(quote)) continue
    const it = item(`https://www.bilibili.com/video/${bvid}`, String(r.title ?? '').replace(/<[^>]+>/g, ''), quote, epochDay(r.pubdate))
    if (it) out.push(it)
  }
  return out
}
const bilibili: Fetcher = async (query, session) => {
  const json = await getJson(`https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(query)}`, { cookie: session, headers: { referer: 'https://search.bilibili.com/' } })
  checkBilibili(json)
  return parseBilibili(json)
}

// --- Instagram: web topsearch with sessionid. Best effort; IG rotates its requirements often. ---
export function parseInstagram(raw: unknown): WorkerItem[] {
  const users = (raw as { users?: { user?: { username?: string; full_name?: string; biography?: string } }[] })?.users ?? []
  const out: WorkerItem[] = []
  for (const u of users.slice(0, 10)) {
    const usr = u.user ?? {}
    if (!usr.username) continue
    const quote = latinRun(`${usr.full_name ?? ''} ${usr.biography ?? ''}`)
    const it = item(`https://www.instagram.com/${usr.username}/`, `${usr.full_name ?? usr.username} on Instagram`, quote, null)
    if (it) out.push(it)
  }
  return out
}
const instagram: Fetcher = async (query, session) => {
  const json = await getJson(`https://www.instagram.com/api/v1/web/search/topsearch/?query=${encodeURIComponent(query)}`, { cookie: session, headers: { 'x-ig-app-id': '936619743392459', referer: 'https://www.instagram.com/' } })
  checkInstagram(json)
  return parseInstagram(json)
}

// --- LinkedIn: voyager search with li_at + JSESSIONID. Highest ban risk; the app caps it at 3/hour. ---
const linkedin: Fetcher = async (query, session) => {
  const liAt = session.match(/li_at=([^;]+)/)?.[1]
  const jsession = session.match(/JSESSIONID="?([^";]+)"?/)?.[1]
  if (!liAt || !jsession) throw new FetchFailure('auth_failed')
  const json = await getJson(`https://www.linkedin.com/voyager/api/search/blended?keywords=${encodeURIComponent(query)}&count=10`, {
    cookie: `li_at=${liAt}; JSESSIONID="${jsession}"`,
    headers: { 'csrf-token': jsession, 'x-restli-protocol-version': '2.0.0', referer: 'https://www.linkedin.com/search/results/all/' },
  })
  checkLinkedin(json)
  // Voyager payloads shift; walk for posts with commentary text.
  const out: WorkerItem[] = []
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return
    if (Array.isArray(v)) { for (const e of v) walk(e); return }
    const o = v as Record<string, unknown>
    const text = (o.commentary as { text?: { text?: string } } | undefined)?.text?.text
    const urn = typeof o.trackingUrn === 'string' ? o.trackingUrn : ''
    const idMatch = urn.match(/activity:(\d+)/)
    if (typeof text === 'string' && idMatch && out.length < 10) {
      const it = item(`https://www.linkedin.com/feed/update/urn:li:activity:${idMatch[1]}/`, 'LinkedIn post', text, null)
      if (it) out.push(it)
    }
    for (const e of Object.values(o)) walk(e)
  }
  readable(() => walk(json))
  return out
}

// --- Not fetchable without a real browser or request signing. Declared unsupported in CAPABILITY:
// the server refuses them before any fetch, so the app records 'unsupported' - never a fake
// zero-result 'empty' search. The stubs stay so FETCHERS remains total; the gate makes them
// unreachable, and they never make a network call. ---
const facebook: Fetcher = async () => [] // FB has no cookie-only JSON search; needs a browser worker
const xiaohongshu: Fetcher = async () => [] // XHS signs every web request (x-s/x-t); signing is not implemented

// What this worker build can actually fetch. The app mirrors this declaration
// (web/lib/advanced/config.ts PLATFORM_SUPPORT; pinned equal by test/advanced-capability-sync.test.ts):
// 'unsupported' is its own outcome, distinct from a genuine successful empty result, an auth
// failure, throttling, or a schema failure.
export interface PlatformCapability { supported: boolean; reason: string | null }
export const CAPABILITY: Record<Platform, PlatformCapability> = {
  x: { supported: true, reason: null },
  reddit: { supported: true, reason: null },
  instagram: { supported: true, reason: null },
  facebook: { supported: false, reason: 'Facebook has no cookie-only JSON search; it needs a browser worker that is not built' },
  bilibili: { supported: true, reason: null },
  xiaohongshu: { supported: false, reason: 'XiaoHongShu signs every web request (x-s/x-t); signing is not implemented' },
  linkedin: { supported: true, reason: null },
}

export const FETCHERS: Record<Platform, Fetcher> = { x, reddit, instagram, facebook, bilibili, xiaohongshu, linkedin }
export const isPlatform = (v: unknown): v is Platform => typeof v === 'string' && Object.hasOwn(FETCHERS, v)
