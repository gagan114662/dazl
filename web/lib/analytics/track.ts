// Product analytics for the signup-to-send funnel (#1616): one event per step, posted to PostHog's capture API
// (POST {host}/i/v0/e/ with api_key, event, distinct_id, properties, timestamp; PostHog docs, "Capture API") with plain
// fetch. No SDK, no browser script: the browser reaches PostHog only through this server (app/api/track), so the page's
// connect-src 'self' policy stays as it is.
//
// What may leave is an ALLOWLIST (PROPS below): counts, booleans, a sign-in method, a plan name and internal ids. Never
// a lead's name, email or company, never search text, never the user's own email. A property outside the list, or a
// value of the wrong shape, means the whole event is not sent. distinct_id is the account's internal id, and the event
// is sent without a person profile and without GeoIP lookup (the request comes from this server, not the user).
//
// Off unless NEXT_PUBLIC_POSTHOG_KEY is set. track() never throws, never waits and never slows its caller: the request
// is started and left, bounded by TIMEOUT_MS, and every failure is dropped.
export const FUNNEL_EVENTS = ['signup', 'google_linked', 'gmail_linked', 'first_search_started', 'first_search_finished', 'leads_shown', 'approve_clicked', 'email_sent'] as const
export type FunnelEvent = (typeof FUNNEL_EVENTS)[number]
// The steps only the browser knows; the only events app/api/track accepts.
export const CLIENT_EVENTS = ['leads_shown'] as const satisfies readonly FunnelEvent[]
export type ClientEvent = (typeof CLIENT_EVENTS)[number]

const ID = /^[A-Za-z0-9_-]{8,64}$/
const count = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000
const flag = (v: unknown) => typeof v === 'boolean'
const id = (v: unknown) => typeof v === 'string' && ID.test(v)
const oneOf = (...xs: string[]) => (v: unknown) => typeof v === 'string' && xs.includes(v)
// Every property an event may carry, with the only shape its value may have.
export const PROPS = {
  count,                                // how many leads a page showed / a search kept
  needs_review: count,                  // how many a search set aside for review
  method: oneOf('password', 'google'),  // how the account signed up
  plan: oneOf('free', 'pro'),
  trial: flag,                          // the search ran on the free trial
  job_id: id,                           // internal scan id
  message_id: id,                       // internal outreach message id
} satisfies Record<string, (v: unknown) => boolean>
export type FunnelProps = { count?: number; needs_review?: number; method?: 'password' | 'google'; plan?: 'free' | 'pro'; trial?: boolean; job_id?: string; message_id?: string }

export const POSTHOG_KEY_ENV = 'NEXT_PUBLIC_POSTHOG_KEY'
export const DEFAULT_HOST = 'https://us.i.posthog.com'
export const TIMEOUT_MS = 2000

// The properties exactly as they would be sent, or a TypeError naming the first one that is not allowed.
export function funnelProps(props: unknown): FunnelProps {
  if (props === undefined || props === null) return {}
  if (typeof props !== 'object' || Array.isArray(props)) throw new TypeError('analytics properties must be an object')
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue
    if (!Object.hasOwn(PROPS, k)) throw new TypeError(`analytics property not allowed: ${k}`)
    if (!PROPS[k as keyof typeof PROPS](v)) throw new TypeError(`analytics property has a value that is not allowed: ${k}`)
    out[k] = v
  }
  return out as FunnelProps
}

function captureUrl(host: string | undefined): string {
  try {
    const u = new URL(host || DEFAULT_HOST)
    if (u.protocol === 'https:') return `${u.origin}/i/v0/e/`
  } catch { /* fall through to the default */ }
  return `${DEFAULT_HOST}/i/v0/e/`
}

export interface TrackDeps { env?: Record<string, string | undefined>; fetch?: typeof fetch; now?: () => Date }

// Records one funnel step for one account. Returns at once; true only says a request was started.
export function track(event: FunnelEvent, distinctId: string, props: FunnelProps = {}, d: TrackDeps = {}): boolean {
  try {
    // Read through a variable, at run time: a key set on the server after the build still switches this on.
    const env = d.env ?? process.env
    const key = env[POSTHOG_KEY_ENV]
    if (!key) return false
    if (!FUNNEL_EVENTS.includes(event) || !id(distinctId)) return false
    const body = JSON.stringify({
      api_key: key, event, distinct_id: distinctId,
      properties: { ...funnelProps(props), $process_person_profile: false, $geoip_disable: true },
      timestamp: (d.now?.() ?? new Date()).toISOString(),
    })
    void (d.fetch ?? fetch)(captureUrl(env.NEXT_PUBLIC_POSTHOG_HOST), { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(TIMEOUT_MS) })
      .then(r => { void r.body?.cancel().catch(() => {}) }, () => {})
    return true
  } catch { return false }
}
