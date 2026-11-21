import type { MetadataRoute } from 'next'
import { SITE_BASE } from '@/lib/site'

export default function sitemap(): MetadataRoute.Sitemap {
  const base = SITE_BASE
  return ['', '/sign-up', '/sign-in', '/pricing', '/about', '/contact', '/privacy', '/terms'].map(p => ({ url: `${base}${p}` }))
}
