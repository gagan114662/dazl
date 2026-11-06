import type { Metadata } from 'next'
import { SITE_BASE, publicMeta } from '@/lib/site'

// Self-referencing canonical: these pages are client components (they cannot export
// metadata), so the tag lives on this wrapping layout. The page is public and in the
// sitemap, so it gets one like the other indexable public pages.
export const metadata: Metadata = {
  ...publicMeta('/sign-up', 'Create your account - dazl'),
  alternates: { canonical: `${SITE_BASE}/sign-up` },
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
