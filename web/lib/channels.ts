// The channel registry shown in Settings > Connectors. `status` says what really works today:
//  live     - the adapter runs in scans now
//  worker   - session is stored and gated, but fetching needs an operator-run worker that is not in this repo
//  soon     - nothing is built; the UI shows it but offers no connect flow
export type Tier = 0 | 1 | 2
export type ChannelStatus = 'live' | 'worker' | 'soon'
export interface Channel { id: string; name: string; tier: Tier; status: ChannelStatus; note: string; platform?: 'x' | 'reddit' | 'instagram' | 'facebook' | 'linkedin' | 'xiaohongshu' | 'bilibili' }

export const CHANNELS: Channel[] = [
  { id: 'web', name: 'Web pages', tier: 0, status: 'live', note: 'On. Add page URLs in a scan under Sources. Pages are read through a third-party reader service: the URLs are sent to it, and it rate limits requests without a key.' },
  { id: 'youtube', name: 'YouTube', tier: 0, status: 'live', note: 'On. Pick it in a scan under Sources. Uses the official YouTube Data API when dazl has its own key for it (free daily quota); otherwise public mirror sites run by outside services, which receive the search keywords.' },
  { id: 'github', name: 'GitHub', tier: 0, status: 'live', note: 'On. Public repos and issues. Pick it in a scan under Sources. No key.' },
  { id: 'rss', name: 'RSS', tier: 0, status: 'live', note: 'On. Add feed URLs in a scan under Sources. No key.' },
  { id: 'search', name: 'Web search', tier: 0, status: 'live', note: 'On. The dazl web search when dazl has its own key for it, otherwise your own model provider search. A paid search service is not used.' },
  { id: 'v2ex', name: 'V2EX', tier: 0, status: 'live', note: 'On. Pick it in a scan under Sources. Keyword search goes through sov2ex.com, a third-party service that receives the keywords. Most posts are Chinese; only topics with English text can be verified.' },
  { id: 'x', name: 'Twitter / X', tier: 1, status: 'worker', platform: 'x', note: 'Found through web search of the public index when dazl has its own key for it - no session needed and no account at risk; results go to review. Otherwise it needs a saved session from a spare account. X disallows automated access in robots.txt and its terms.' },
  { id: 'reddit', name: 'Reddit', tier: 1, status: 'worker', platform: 'reddit', note: 'Reddit limits automated access under its terms.' },
  { id: 'instagram', name: 'Instagram', tier: 1, status: 'worker', platform: 'instagram', note: 'Instagram disallows automated access in robots.txt and its terms.' },
  { id: 'facebook', name: 'Facebook', tier: 1, status: 'worker', platform: 'facebook', note: 'Not available yet. Facebook disallows automated access in robots.txt and its terms. dazl does not fetch Facebook yet.' },
  { id: 'linkedin', name: 'LinkedIn', tier: 2, status: 'worker', platform: 'linkedin', note: 'It carries the highest risk of getting the account banned.' },
]
