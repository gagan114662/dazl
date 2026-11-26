import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import './globals.css'
import { chunkRecoveryScript } from '@/lib/chunk-recovery'
import { isStaging, STAGING_BANNER } from '@/lib/staging'
import { stagingBannerOn } from '@/lib/staging-banner'
import { SITE_BASE, SITE_TITLE } from '@/lib/site'
import ClientErrorReporter from './client-error-reporter'

const geist = Geist({ subsets: ['latin'], variable: '--dazl-geist' })

// #1705: the fallback meta/OG description pitches the same single first step as the landing hero and the
// app's first screen, with honest proof wording (dazl does not open every source page, #1716). Local because
// the shared SITE_DESCRIPTION in lib/site.ts still carries the old overclaim and is outside this lane.
const LANDING_DESCRIPTION = 'Say who you want to reach. dazl finds buyers showing intent and shows the dated public proof for each lead.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_BASE),
  title: SITE_TITLE,
  description: LANDING_DESCRIPTION,
  // #534: the fallback social preview. Public pages set their own (lib/site.ts publicMeta) so og:url/og:title are theirs.
  openGraph: { type: 'website', siteName: 'dazl', title: SITE_TITLE, description: LANDING_DESCRIPTION },
  twitter: { card: 'summary_large_image', title: SITE_TITLE, description: LANDING_DESCRIPTION },
  // staging is never indexed (also app/robots.ts and the X-Robots-Tag header in next.config.ts)
  ...(isStaging() ? { robots: { index: false, follow: false } } : {}),
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" style={{backgroundColor:"#fff",color:"#111"}}>
      <head>
        {/* Runs before the page's chunks load; see lib/chunk-recovery.ts for the bounded reload policy. */}
        <script dangerouslySetInnerHTML={{ __html: chunkRecoveryScript(process.env.NEXT_PUBLIC_DAZL_BUILD || '') }} />
      </head>
      <body className={`${geist.className} ${geist.variable} antialiased`}>
        <a href="#main" className="skip-link">Skip to content</a>
        {stagingBannerOn() && <div role="note" data-testid="staging-banner" className="bg-[#fde68a] text-[#111] text-center text-xs font-mono uppercase tracking-wider py-1">{STAGING_BANNER}</div>}
        <ClientErrorReporter />
        {children}
      </body>
    </html>
  )
}
