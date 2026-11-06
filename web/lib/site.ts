import type { Metadata } from 'next'

// The public origin of the site. One source of truth for sitemap, robots,
// canonical tags and anywhere else a public absolute URL is built.
// Canonical host is the apex (https://dazl.ai), per docs/DEPLOY.md.
export const SITE_BASE = process.env.PUBLIC_BASE_URL || 'https://dazl.ai'

export const SITE_TITLE = 'dazl - find leads with proof'
export const SITE_DESCRIPTION = 'Say who you are looking for. dazl finds buyers showing intent and verifies each lead against its source.'

// #534: a public page's title plus its own social preview. Next merges metadata shallowly, so a page that sets
// openGraph/twitter replaces the root's whole object: without this, every page's og:url and og:title were the
// homepage's. Replacing openGraph also drops the inherited image, so the card from app/opengraph-image.tsx is named
// here. The canonical stays on each page (canonical.test.ts).
const OG_IMAGE = { url: '/opengraph-image', width: 1200, height: 630, alt: SITE_TITLE, type: 'image/png' }
export function publicMeta(path: string, title: string, description = SITE_DESCRIPTION): Metadata {
  const url = `${SITE_BASE}${path === '/' ? '' : path}`
  return {
    title, description,
    openGraph: { type: 'website', siteName: 'dazl', url, title, description, images: [OG_IMAGE] },
    twitter: { card: 'summary_large_image', title, description, images: [OG_IMAGE.url] },
  }
}
