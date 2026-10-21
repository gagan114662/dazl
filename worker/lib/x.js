// X (Twitter) search with the tenant's own session cookie, through the same GraphQL
// endpoint the web app uses. X disallows automated access outright; this exists for
// tenants who accepted that risk with a throwaway account. It is BRITTLE: X rotates
// the query id and the required feature flags. Both are env-overridable so the
// operator can refresh them without a redeploy (see README.md).
const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
const DEFAULT_QUERY_ID = 'BYppgupFFS2yqVmmRNjlsw' // SearchTimeline, web app live bundle, Oct 21 2026 (operator-verified)
const DEFAULT_FEATURES = JSON.stringify({
  rweb_tipjar_consumption_enabled: true, responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false, creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true, responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true, c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true, responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true, view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true, responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false, creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true, standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true, rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true, longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
})

function cookieValue(session, name) {
  const m = session.split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null
}

function xHeaders(session, ct0) {
  return {
    authorization: `Bearer ${decodeURIComponent(BEARER)}`,
    'x-csrf-token': ct0,
    cookie: session,
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    accept: 'application/json',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
  }
}

// SearchTimeline first (richest data, but the query id/features/variables rotate: X 404s
// the endpoint wholesale when any of the three drift, and returns empty result sets for
// stale feature sets). On ANY error or a 0-item reply,
// fall back to the legacy adaptive.json search, which has survived every GraphQL
// rotation so far. Statuses are logged server-side (never the cookie).
export async function fetchX({ query, session }) {
  const ct0 = cookieValue(session, 'ct0')
  if (!ct0 || !cookieValue(session, 'auth_token')) throw new Error('x session needs auth_token and ct0 cookies')
  const headers = xHeaders(session, ct0)
  const queryId = process.env.X_QUERY_ID || DEFAULT_QUERY_ID
  const variables = JSON.stringify({ rawQuery: query, count: 20, querySource: 'typed_query', product: 'Latest', fieldToggles: [], withGrokTranslatedBio: false })
  const url = `https://x.com/i/api/graphql/${queryId}/SearchTimeline?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(process.env.X_FEATURES || DEFAULT_FEATURES)}`
  try {
    const res = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) })
    if (res.ok) {
      const items = parseXTweets(await res.json())
      if (items.length) return items
      console.error('x: SearchTimeline 200 with 0 items; falling back to adaptive.json')
    } else {
      console.error(`x: SearchTimeline HTTP ${res.status}; falling back to adaptive.json`)
    }
  } catch (e) {
    console.error(`x: SearchTimeline failed (${e instanceof Error ? e.message : 'error'}); falling back to adaptive.json`)
  }
  const adaptiveUrl = `https://x.com/i/api/1.1/search/adaptive.json?q=${encodeURIComponent(query)}&count=20&tweet_mode=extended&query_source=typed_query`
  const res = await fetch(adaptiveUrl, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`x ${res.status}`)
  return parseAdaptiveTweets(await res.json())
}

// Walks the response for tweet result objects, robust to query-id/feature drift.
export function parseXTweets(data) {
  const tweets = []
  const seen = new Set()
  const stack = [data]
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue
    const legacy = node?.result?.legacy || node?.legacy
    const core = node?.result?.core || node?.core
    if (legacy?.full_text && legacy?.id_str) {
      const id = legacy.id_str
      if (!seen.has(id)) {
        seen.add(id)
        const user = core?.user_results?.result?.core?.screen_name
          || core?.user_results?.result?.legacy?.screen_name
        const date = legacy.created_at ? new Date(legacy.created_at) : null
        if (user && legacy.full_text.length >= 20) {
          tweets.push({
            url: `https://x.com/${user}/status/${id}`,
            title: legacy.full_text.slice(0, 120),
            quote: legacy.full_text.slice(0, 300),
            date: date && !isNaN(date) ? date.toISOString().slice(0, 10) : null,
            login_walled: false,
          })
        }
      }
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') stack.push(v)
    }
  }
  return tweets
}

// adaptive.json shape: { globalObjects: { tweets: {id: {id_str, full_text, created_at,
// user_id_str}}, users: {id: {screen_name}} } }. Same output contract as parseXTweets.
export function parseAdaptiveTweets(data) {
  const tweets = data?.globalObjects?.tweets
  const users = data?.globalObjects?.users
  if (!tweets || typeof tweets !== 'object') return []
  const out = []
  for (const t of Object.values(tweets)) {
    if (!t || typeof t.full_text !== 'string' || t.full_text.length < 20 || !t.id_str) continue
    const user = users?.[t.user_id_str]?.screen_name
    if (!user) continue
    const date = t.created_at ? new Date(t.created_at) : null
    out.push({
      url: `https://x.com/${user}/status/${t.id_str}`,
      title: t.full_text.slice(0, 120),
      quote: t.full_text.slice(0, 300),
      date: date && !isNaN(date) ? date.toISOString().slice(0, 10) : null,
      login_walled: false,
    })
  }
  return out
}
