import type { Metadata } from 'next'
import { SITE_BASE, publicMeta } from '@/lib/site'

// Self-referencing canonical: these pages are client components (they cannot export
// metadata), so the tag lives on this wrapping layout. The page is public and in the
// sitemap, so it gets one like the other indexable public pages.
export const metadata: Metadata = {
  ...publicMeta('/sign-in', 'Sign in - dazl'),
  alternates: { canonical: `${SITE_BASE}/sign-in` },
}

// #1782: the page's <main> carries a 100vh floor and 40px top/bottom padding, so the card did not fit the screen
// (932px of content at 1440x900). The wrapper owns the visible height - dvh, because a phone's 100vh is taller than
// what shows - and passes it to that <main>, which keeps centring the card. No padding or margin of its own.
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] flex flex-col [&>main]:flex-1 [&>main]:min-h-0 [&>main]:py-0">
      {children}
    </div>
  )
}
