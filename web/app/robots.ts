import type { MetadataRoute } from 'next'
import { SITE_BASE } from '@/lib/site'
import { isStaging } from '@/lib/staging'

export default function robots(): MetadataRoute.Robots {
  const base = SITE_BASE
  if (isStaging()) return { rules: [{ userAgent: '*', disallow: ['/'] }] }
  return {
    rules: [{ userAgent: '*', allow: ['/', '/privacy', '/terms'], disallow: ['/app', '/api'] }],
    sitemap: `${base}/sitemap.xml`,
  }
}
