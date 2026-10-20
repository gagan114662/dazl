import type { MetadataRoute } from 'next'

export default function robots(): MetadataRoute.Robots {
  const base = process.env.PUBLIC_BASE_URL || 'https://dazl.ai'
  return {
    rules: [{ userAgent: '*', allow: ['/', '/privacy', '/terms'], disallow: ['/app', '/api'] }],
    sitemap: `${base}/sitemap.xml`,
  }
}
