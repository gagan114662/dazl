// The public origin of the site. One source of truth for sitemap, robots,
// canonical tags and anywhere else a public absolute URL is built.
// Canonical host is the apex (https://dazl.ai), per docs/DEPLOY.md.
export const SITE_BASE = process.env.PUBLIC_BASE_URL || 'https://dazl.ai'
