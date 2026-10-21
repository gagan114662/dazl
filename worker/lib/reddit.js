// Reddit search with the tenant's own session cookie. Reddit's terms limit automated
// access: keep request rates low (the app caps calls per tenant per hour), use a
// descriptive User-Agent, and never hammer failures.
const UA = 'dazl-worker/0.1 (lead research; per-user opt-in, low volume)'

export async function fetchReddit({ query, session }) {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&limit=25&type=link&raw_json=1`
  const res = await fetch(url, {
    headers: { cookie: session, 'user-agent': UA, accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`reddit ${res.status}`)
  const data = await res.json()
  return parseRedditListing(data)
}

export function parseRedditListing(data) {
  const children = data?.data?.children
  if (!Array.isArray(children)) return []
  const out = []
  for (const c of children) {
    const d = c?.data
    if (!d?.permalink || !d?.title) continue
    const text = typeof d.selftext === 'string' && d.selftext.trim().length >= 20 ? d.selftext.trim() : d.title
    if (text.length < 20) continue // app contract: quote must be >= 20 chars
    out.push({
      url: `https://www.reddit.com${d.permalink}`,
      title: String(d.title).slice(0, 200),
      quote: text.slice(0, 300),
      date: d.created_utc ? new Date(d.created_utc * 1000).toISOString().slice(0, 10) : null,
      login_walled: false,
    })
  }
  return out
}
