// LinkedIn public-post search with a session cookie (li_at + JSESSIONID), through the
// same voyager endpoint the web app uses. LinkedIn disallows automated access; this
// exists for the operator's confirmed-disposable throwaway account only, at a hard
// 3 calls/hour/tenant cap (enforced app-side). BRITTLE: LinkedIn changes response
// shapes without notice; the parser walks for commentary text rather than trusting
// fixed paths. Statuses are logged server-side; the cookie is never logged.
const LI_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function cookieValue(session, name) {
  const m = session.split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null
}

export async function fetchLinkedIn({ query, session }) {
  const liAt = cookieValue(session, 'li_at')
  const jsession = cookieValue(session, 'JSESSIONID')
  if (!liAt || !jsession) throw new Error('linkedin session needs li_at and JSESSIONID cookies')
  const csrf = jsession.replace(/^"|"$/g, '')
  const url = `https://www.linkedin.com/voyager/api/search/blended?count=10&q=all&keywords=${encodeURIComponent(query)}&filters=List(resultType-%3ECONTENT)&origin=GLOBAL_SEARCH_HEADER`
  const res = await fetch(url, {
    headers: {
      'csrf-token': csrf,
      cookie: session,
      'user-agent': LI_UA,
      accept: 'application/vnd.linkedin.normalized+json+2.1',
      'x-li-lang': 'en_US',
      'x-restli-protocol-version': '2.0.0',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    console.error(`linkedin: voyager search HTTP ${res.status}`)
    throw new Error(`linkedin ${res.status}`)
  }
  return parseLinkedInPosts(await res.json())
}

// Normalized JSON 2.1: entities live in `included` with $type discriminators. Posts
// (UpdateV2) carry commentary.text.text and a socialDetail urn. We walk defensively:
// any object with a text payload >= 20 chars and an activity/ugcPost urn becomes an
// item; anything else is ignored. Unknown shapes yield [] rather than a crash.
export function parseLinkedInPosts(data) {
  const out = []
  const seen = new Set()
  const stack = [data]
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue
    const text = node?.commentary?.text?.text || node?.commentary?.text || node?.summary?.text
    const urn = node?.socialDetail?.urn || node?.urn || node?.entityUrn || ''
    const id = typeof urn === 'string' ? (urn.match(/(?:activity|ugcPost):(\d+)/)?.[1]) : null
    if (typeof text === 'string' && text.length >= 20 && id && !seen.has(id)) {
      seen.add(id)
      const postUrl = urn.includes('ugcPost')
        ? `https://www.linkedin.com/feed/update/urn:li:ugcPost:${id}`
        : `https://www.linkedin.com/feed/update/urn:li:activity:${id}`
      out.push({ url: postUrl, title: text.slice(0, 120), quote: text.slice(0, 300), date: null, login_walled: true })
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') stack.push(v)
    }
  }
  return out.slice(0, 20)
}
