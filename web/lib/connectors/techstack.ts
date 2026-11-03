// Tech-stack detection over the HTML sitecrawl already downloads - no extra fetches.
// High-precision signatures only: each one names a product the page itself loads or declares.
// A weak signal (a bare class name, a common word) is worse than a miss, so this list stays short.
export interface TechHit { name: string; where: string }

const SIGS: { name: string; test: RegExp }[] = [
  { name: 'Shopify', test: /cdn\.shopify\.com|myshopify\.com|Shopify\.theme/i },
  { name: 'WordPress', test: /wp-content\/|wp-includes\/|content=["']WordPress/i },
  { name: 'Webflow', test: /webflow\.js|data-wf-|\.webflow\.io/i },
  { name: 'Wix', test: /static\.wixstatic\.com|X-Wix-Published-Version|content=["']Wix\.com/i },
  { name: 'Squarespace', test: /static1\.squarespace\.com|content=["']Squarespace/i },
  { name: 'Framer', test: /framerusercontent\.com|framer\.com\/sites/i },
  { name: 'Next.js', test: /__NEXT_DATA__|\/_next\/static\//i },
  { name: 'Ghost', test: /content=["']Ghost/i },
  { name: 'Drupal', test: /content=["']Drupal|\/sites\/default\/files\//i },
  { name: 'HubSpot', test: /js\.hs-scripts\.net|js\.hsforms\.net|hs-analytics\.net/i },
  { name: 'Intercom', test: /widget\.intercom\.io|intercomcdn\.com/i },
  { name: 'Stripe', test: /js\.stripe\.com/i },
  { name: 'Google Analytics', test: /googletagmanager\.com\/gtag|google-analytics\.com\/(analytics|ga)\.js/i },
  { name: 'Segment', test: /cdn\.segment\.com\/analytics\.js|cdn\.segment\.io/i },
  { name: 'Mailchimp', test: /list-manage\.com|chimpstatic\.com/i },
  { name: 'Calendly', test: /assets\.calendly\.com/i },
  { name: 'Zendesk', test: /static\.zdassets\.com|zendesk\.com\/embeddable/i },
  { name: 'jQuery', test: /code\.jquery\.com|jquery[.-]\d+\.\d+\.\d+(\.min)?\.js/i },
  { name: 'Bootstrap', test: /bootstrap(\.min)?\.(css|js)|stackpath\.bootstrapcdn\.com|cdn\.jsdelivr\.net\/npm\/bootstrap/i },
  { name: 'Cloudflare Turnstile', test: /challenges\.cloudflare\.com\/turnstile/i },
]

// #389: technographics as a dated, scoped observation (lib/signals/tech-observations.ts). Bump the version whenever a signature changes,
// so observations made with different signature sets are never compared (a new signature is not an adoption).
export const TECH_DETECTOR_VERSION = 1
export const TECH_NAMES: readonly string[] = SIGS.map(s => s.name)
// Short stable keys for the compact per-crawl observation row (label <= 200 chars must hold every name at once).
const KEY: Record<string, string> = { 'Shopify': 'shopify', 'WordPress': 'wordpress', 'Webflow': 'webflow', 'Wix': 'wix', 'Squarespace': 'squarespace', 'Framer': 'framer', 'Next.js': 'nextjs', 'Ghost': 'ghost', 'Drupal': 'drupal', 'HubSpot': 'hubspot', 'Intercom': 'intercom', 'Stripe': 'stripe', 'Google Analytics': 'ga', 'Segment': 'segment', 'Mailchimp': 'mailchimp', 'Calendly': 'calendly', 'Zendesk': 'zendesk', 'jQuery': 'jquery', 'Bootstrap': 'bootstrap', 'Cloudflare Turnstile': 'turnstile' }
export const techKey = (name: string): string | null => KEY[name] ?? null
export const techFromKey = (key: string): string | null => Object.keys(KEY).find(n => KEY[n] === key) ?? null
// Words a request may use for a detectable technology -> its canonical name. Only names this detector can see: a technology it cannot detect
// never becomes a filter (it could only ever be 'unknown'). Ambiguous English words (Ghost, Segment, Bootstrap, Stripe, Framer) are matched
// only after a technology cue by the targeting compiler, never as bare words.
export const TECH_WORDS: { re: string; name: string }[] = [
  { re: 'shopify', name: 'Shopify' }, { re: 'word\\s?press', name: 'WordPress' }, { re: 'webflow', name: 'Webflow' }, { re: 'wix', name: 'Wix' },
  { re: 'squarespace', name: 'Squarespace' }, { re: 'framer', name: 'Framer' }, { re: 'next\\.?js|next\\s+js', name: 'Next.js' }, { re: 'ghost', name: 'Ghost' },
  { re: 'drupal', name: 'Drupal' }, { re: 'hub\\s?spot', name: 'HubSpot' }, { re: 'intercom', name: 'Intercom' }, { re: 'stripe', name: 'Stripe' },
  { re: 'google\\s+analytics|ga4', name: 'Google Analytics' }, { re: 'segment', name: 'Segment' }, { re: 'mail\\s?chimp', name: 'Mailchimp' },
  { re: 'calendly', name: 'Calendly' }, { re: 'zendesk', name: 'Zendesk' }, { re: 'jquery', name: 'jQuery' }, { re: 'bootstrap', name: 'Bootstrap' },
  { re: '(?:cloudflare\\s+)?turnstile', name: 'Cloudflare Turnstile' },
]
export function techNameOf(word: string): string | null {
  for (const w of TECH_WORDS) if (new RegExp(`^(?:${w.re})$`, 'i').test(word.trim())) return w.name
  return null
}

// Can a fetched page say anything about ABSENCE? A signature found is evidence of presence on any page that loaded. A signature NOT found
// means nothing unless the page is a full, readable page: a block / challenge page, a JavaScript shell, a consent wall or a near-empty
// maintenance page carries none of the site's scripts, so reading it as "removed" would turn an outage into a migration.
export type Observability = 'ok' | 'http_error' | 'not_html' | 'blocked' | 'thin_page'
export function observability(status: number, html: string): Observability {
  if (!(status >= 200 && status < 300)) return 'http_error'
  if (!/<html|<body|<head/i.test(html)) return 'not_html'
  if (/cf-chl-|challenge-platform|<title>\s*(?:just a moment|attention required|access denied)|captcha-delivery|px-captcha/i.test(html)) return 'blocked'
  const text = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  if (text.length < 200) return 'thin_page'
  return 'ok'
}

// Detect from one HTML page. `where` records what gave it away, so the claim stays auditable.
export function detectTech(html: string): TechHit[] {
  const out: TechHit[] = []
  for (const s of SIGS) {
    const m = s.test.exec(html)
    if (m) out.push({ name: s.name, where: m[0].slice(0, 80) })
  }
  return out
}
