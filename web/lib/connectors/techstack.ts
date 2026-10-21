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

// Detect from one HTML page. `where` records what gave it away, so the claim stays auditable.
export function detectTech(html: string): TechHit[] {
  const out: TechHit[] = []
  for (const s of SIGS) {
    const m = s.test.exec(html)
    if (m) out.push({ name: s.name, where: m[0].slice(0, 80) })
  }
  return out
}
