import type { MetadataRoute } from 'next'
import { SITE_BASE } from '@/lib/site'

export default function sitemap(): MetadataRoute.Sitemap {
  const base = SITE_BASE
  return ['', '/sign-up', '/sign-in', '/privacy', '/terms'].map(p => ({ url: `${base}${p}` }))
}
