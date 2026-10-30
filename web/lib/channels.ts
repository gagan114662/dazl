// The channel registry shown in Settings > Connectors. `status` says what really works today:
//  live     - the adapter runs in scans now
//  worker   - session is stored and gated, but fetching needs an operator-run worker that is not in this repo
//  soon     - nothing is built; the UI shows it but offers no connect flow
export type Tier = 0 | 1 | 2
export type ChannelStatus = 'live' | 'worker' | 'soon' | 'unsupported'
export interface Channel { id: string; name: string; tier: Tier; status: ChannelStatus; note: string; platform?: 'x' | 'reddit' | 'instagram' | 'facebook' | 'linkedin' | 'xiaohongshu' | 'bilibili' }

export const CHANNELS: Channel[] = [
  { id: 'web', name: 'Web pages (Jina Reader)', tier: 0, status: 'live', note: 'On. Add page URLs in a scan under Sources. Pages are read through Jina Reader, a third-party service: the URLs are sent to it, and it rate limits requests without a key.' },
  { id: 'youtube', name: 'YouTube', tier: 0, status: 'live', note: 'On. Pick it in a scan under Sources. Uses the official YouTube Data API when the operator has set a key (free daily quota), otherwise public Piped instances, which are third-party services that receive the search keywords.' },
  { id: 'github', name: 'GitHub', tier: 0, status: 'live', note: 'On. Public repos and issues. Pick it in a scan under Sources. No key.' },
  { id: 'rss', name: 'RSS', tier: 0, status: 'live', note: 'On. Add feed URLs in a scan under Sources. No key.' },
  { id: 'search', name: 'Web search', tier: 0, status: 'live', note: 'On. TinyFish search when the operator has set a key, otherwise your own model provider search. Exa is not used because it needs a paid key.' },
  { id: 'v2ex', name: 'V2EX', tier: 0, status: 'live', note: 'On. Pick it in a scan under Sources. Keyword search goes through sov2ex.com, a third-party service that receives the keywords. Most posts are Chinese; only topics with English text can be verified.' },
  { id: 'x', name: 'Twitter / X', tier: 1, status: 'worker', platform: 'x', note: 'Found through web search of the public index when the operator sets a TinyFish key - no session needed and no account at risk; results go to needs review. Otherwise needs a worker session. X disallows automated access in robots.txt and its terms.' },
  { id: 'reddit', name: 'Reddit', tier: 1, status: 'worker', platform: 'reddit', note: 'Needs a worker. Reddit limits automated access under its terms.' },
  { id: 'instagram', name: 'Instagram', tier: 1, status: 'worker', platform: 'instagram', note: 'Needs a worker. Instagram disallows automated access in robots.txt and its terms.' },
  { id: 'facebook', name: 'Facebook', tier: 1, status: 'unsupported', platform: 'facebook', note: 'Not available: the session worker cannot read Facebook (it has no cookie-only search and needs a browser worker). No session is collected and scans never search it.' },
  { id: 'bilibili', name: 'Bilibili', tier: 1, status: 'worker', platform: 'bilibili', note: 'Needs a worker.' },
  { id: 'xiaohongshu', name: 'XiaoHongShu', tier: 1, status: 'unsupported', platform: 'xiaohongshu', note: 'Not available: XiaoHongShu signs every request and the session worker does not implement that. No session is collected and scans never search it.' },
  { id: 'linkedin', name: 'LinkedIn', tier: 2, status: 'worker', platform: 'linkedin', note: 'Needs a worker and a separate operator switch. Highest ban risk. Public pages through Jina Reader are not built yet.' },
]
export const TIER_LABEL: Record<Tier, string> = { 0: 'Tier 0 · no setup', 1: 'Tier 1 · your session', 2: 'Tier 2 · login required' }
