import type { MetadataRoute } from 'next'

export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.PUBLIC_BASE_URL || 'https://dazl.ai'
  return ['', '/sign-up', '/sign-in', '/privacy', '/terms'].map(p => ({ url: `${base}${p}` }))
}
