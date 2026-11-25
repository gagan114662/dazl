import type { Metadata } from 'next'
import { SITE_BASE, publicMeta } from '@/lib/site'
import SiteFooter from '../site-footer'

// Self-referencing canonical: these pages are client components (they cannot export
// metadata), so the tag lives on this wrapping layout. The page is public and in the
// sitemap, so it gets one like the other indexable public pages.
export const metadata: Metadata = {
  ...publicMeta('/sign-up', 'Create your account - dazl'),
  alternates: { canonical: `${SITE_BASE}/sign-up` },
}

// #1782: the page's <main> carries a 100vh floor and 40px top/bottom padding, so the card did not fit the screen
// (932px of content at 1440x900). The wrapper owns the visible height - dvh, because a phone's 100vh is taller than
// what shows - and passes it to that <main>, which keeps centring the card. No padding or margin of its own.
// #1781: the site footer sits below the card, inside that visible height. `basis-auto` makes <main> as tall as its
// card before it grows to fill the rest, so a tall card pushes the footer down instead of overlapping it.
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] flex flex-col [&>main]:flex-1 [&>main]:basis-auto [&>main]:min-h-0 [&>main]:py-0">
      {children}
      <SiteFooter compact />
    </div>
  )
}
