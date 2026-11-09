// Platform fetchers. Each takes the tenant's own session cookie (they opted in and accepted the
// risk notice) and a query, and returns items for the app's evidence pipeline. Platforms that
// disallow automated access (X, Instagram, Facebook, LinkedIn) can rate-limit or ban the account:
// that risk is the tenant's acknowledged choice, and calls are rate-limited server-side.
import { epochDay, FetchFailure, getJson, item, latinRun, latinUsable, type FailureKind, type WorkerItem } from './util.ts'

export type Platform = 'x' | 'reddit' | 'instagram' | 'facebook' | 'bilibili' | 'xiaohongshu' | 'linkedin'
export type Fetcher = (query: string, session: string, env: Record<string, string | undefined>) => Promise<WorkerItem[]>

// --- A 200 JSON answer is not always a search result (#436). Each platform has its own error envelope (a login wall,
// a rate limit, a blocked request) and its own result container. Before parsing, every fetcher checks its answer:
//   - a known error envelope is that failure (auth_failed / throttled; any other platform error is upstream_error), and a
//     refusal marker wins even when a result container sits beside it (a login wall often sends an empty one, #632);
//   - an answer without the platform's result container is schema_error (a JSON login page, a changed API), never [];
//   - a result container that is present and empty is a genuine search that found nothing, [], only when the answer says
//     so explicitly (Reddit kind 'Listing', Bilibili numResults 0, Instagram status 'ok', LinkedIn paging.total 0).
// Checks read only the envelope, never the items, so a changed item shape still degrades to fewer items, not a failure.
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)
const fail = (kind: FailureKind): never => { throw new FetchFailure(kind) }
// The recursive walkers (X, LinkedIn) on a hostile, deeply nested answer: a stack overflow is an unreadable answer.
const readable = <T>(f: () => T): T => { try { return f() } catch (e) { if (e instanceof RangeError) throw new FetchFailure('schema_error'); throw e } }
const httpKind = (status: unknown): FailureKind => (status === 401 || status === 403 ? 'auth_failed' : status === 429 ? 'throttled' : 'upstream_error')
// An error code as a number: numbers as they are, numeric strings read, anything else NaN (never a coercion that throws).
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN)
const present = (v: unknown) => v !== undefined && v !== null

// Reddit: {kind: 'Listing', data: {children: [...]}}; errors come back as {error: <http status>, message}, and an error
// field wins over any listing beside it.
export function checkReddit(raw: unknown): void {
  const o = obj(raw) ?? fail('schema_error')
  if (present(o.error)) fail(httpKind(num(o.error)))
  if (o.kind !== 'Listing' || !Array.isArray(obj(o.data)?.children)) fail('schema_error')
}
// X GraphQL: {data: {search_by_raw_query: {search_timeline: {timeline: {instructions: [...]}}}}}; a refusal is
// {errors: [{code}]}. 32/64/89/215/326 = the session is not authenticated, suspended or locked; 88 = rate limit. Those
// codes are a refusal even beside a data block. Other errors beside timeline entries are partial errors (the entries are
// read); beside no entries, or no timeline, the answer is that error.
const X_AUTH = new Set([32, 64, 89, 215, 326])
export function checkX(raw: unknown): void {
  const o = obj(raw) ?? fail('schema_error')
  if (present(o.errors) && !Array.isArray(o.errors)) fail('schema_error')
  const errors: unknown[] = Array.isArray(o.errors) ? o.errors : []
  const codes = errors.map(e => num(obj(e)?.code))
  if (codes.some(c => X_AUTH.has(c))) fail('auth_failed')
  if (codes.includes(88)) fail('throttled')
  const instructions = obj(obj(obj(obj(o.data)?.search_by_raw_query)?.search_timeline)?.timeline)?.instructions
  if (!Array.isArray(instructions)) fail(errors.length > 0 ? 'upstream_error' : 'schema_error')
  if (errors.length > 0 && (instructions as unknown[]).length === 0) fail('upstream_error')
}
// Bilibili: {code: 0, data: {...}}; non-zero codes are refusals even on HTTP 200. -101 = not signed in, -111 = csrf;
// -352 (risk control), -412 (request blocked), -509 / -799 (too frequent) = throttled. Risk control can also answer code 0
// with a v_voucher challenge in place of results: throttled.
const BILI_AUTH = new Set([-101, -111]), BILI_THROTTLE = new Set([-352, -412, -509, -799])
export function checkBilibili(raw: unknown): void {
  const o = obj(raw) ?? fail('schema_error')
  if (typeof o.code !== 'number' || !Number.isInteger(o.code)) fail('schema_error')
  const code = o.code as number
  if (code !== 0) fail(BILI_AUTH.has(code) ? 'auth_failed' : BILI_THROTTLE.has(code) ? 'throttled' : 'upstream_error')
  const data = obj(o.data) ?? fail('schema_error')
  if (present(data.v_voucher)) fail('throttled')
  if (Array.isArray(data.result) && data.result.length > 0) return
  // No hits: Bilibili says numResults 0 and omits result or sends an empty one. Anything else is a changed API.
  if (!(data.numResults === 0 && (data.result === undefined || Array.isArray(data.result)))) fail('schema_error')
}
// Instagram topsearch: {users: [...], status: 'ok'}; a refusal is {status: 'fail', message, require_login?, spam?}. A
// refusal marker wins over a users list beside it; a result needs the explicit status 'ok'.
export function checkInstagram(raw: unknown): void {
  const o = obj(raw) ?? fail('schema_error')
  const msg = typeof o.message === 'string' ? o.message.toLowerCase() : ''
  const auth = o.require_login === true || msg === 'login_required' || msg === 'checkpoint_required' || msg === 'challenge_required'
  const throttled = o.spam === true || msg.includes('wait a few minutes') || msg === 'rate_limited'
  if (o.status === 'fail' || auth || throttled) fail(auth ? 'auth_failed' : throttled ? 'throttled' : 'upstream_error')
  if (o.status !== 'ok' || !Array.isArray(o.users)) fail('schema_error')
}
// LinkedIn voyager: {data: {elements, paging}, included} (normalized) or {elements, paging}. A refusal is {status: <http
// status>, serviceErrorCode?, message?}, sometimes beside an empty or message-only data block, so (#632):
//   - a status field must be an integer; a non-2xx one is that refusal whatever sits beside it; any other type is unreadable;
//   - a serviceErrorCode / exceptionClass is a refusal even with a 2xx status;
//   - a result needs content (a non-empty included or elements list), or an explicit zero-result answer (an empty elements
//     list with paging.total 0); an empty or message-only container is schema_error, never an empty search.
export function checkLinkedin(raw: unknown): void {
  const o = obj(raw) ?? fail('schema_error')
  if (Object.hasOwn(o, 'status')) {
    const s = o.status
    if (typeof s !== 'number' || !Number.isInteger(s)) fail('schema_error')
    if ((s as number) < 200 || (s as number) > 299) fail(httpKind(s))
  }
  if (present(o.serviceErrorCode) || present(o.exceptionClass)) fail('upstream_error')
  if (Object.hasOwn(o, 'data') && obj(o.data) === null) fail('schema_error')
  const data = obj(o.data)
  const lists = [o.elements, data?.elements, data?.['*elements']]
  if ((Array.isArray(o.included) && o.included.length > 0) || lists.some(l => Array.isArray(l) && l.length > 0)) return
  const total = (obj(o.paging) ?? obj(data?.paging))?.total
  if (!(lists.some(l => Array.isArray(l)) && (o.included === undefined || Array.isArray(o.included)) && total === 0)) fail('schema_error')
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
    // The listing carries the post's own username; a search result carries no headline, company or website (never invented).
    const an = typeof d.author === 'string' && d.author && d.author !== '[deleted]' && d.author !== '[removed]' ? d.author.slice(0, 200) : null
    if (it && an) it.author = { name: an, headline: null, company: null, url: null }
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
    const user = (o.tweet_results as { result?: { core?: { user_results?: { result?: { legacy?: { screen_name?: string; name?: string; description?: string; url?: string; entities?: { url?: { urls?: { expanded_url?: string }[] } } } } } } } })?.result?.core?.user_results?.result?.legacy
    if (legacy && typeof legacy.full_text === 'string' && typeof legacy.id_str === 'string' && !seen.has(legacy.id_str)) {
      seen.add(legacy.id_str)
      const screen = user?.screen_name ?? 'i'
      const d = typeof legacy.created_at === 'string' ? new Date(legacy.created_at) : null
      const it = item(`https://x.com/${screen}/status/${legacy.id_str}`, `${screen} on X`, legacy.full_text, d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null)
      // The tweet payload's own user object: display name, the bio verbatim (authority evidence, not a company),
      // and the profile website expanded (never the t.co wrapper). X carries no structured company field, so
      // company stays null - it is never parsed out of the bio (no inference).
      if (it && user) {
        const an = typeof user.name === 'string' && user.name.trim() ? user.name.slice(0, 200) : screen !== 'i' ? screen : null
        const bio = typeof user.description === 'string' && user.description.trim() ? user.description.slice(0, 300) : null
        const expanded = user.entities?.url?.urls?.[0]?.expanded_url
        const site = typeof expanded === 'string' && /^https?:\/\/.{4,480}$/.test(expanded) ? expanded.slice(0, 500) : null
        if (an || bio || site) it.author = { name: an, headline: bio, company: null, url: site }
      }
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
