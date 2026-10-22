import type { MetadataRoute } from 'next'
import { SITE_BASE } from '@/lib/site'

export default function robots(): MetadataRoute.Robots {
  const base = SITE_BASE
  return {
    rules: [{ userAgent: '*', allow: ['/', '/privacy', '/terms'], disallow: ['/app', '/api'] }],
    sitemap: `${base}/sitemap.xml`,
  }
}
