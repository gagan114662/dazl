import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import './globals.css'
import { chunkRecoveryScript } from '@/lib/chunk-recovery'
import { isStaging, STAGING_BANNER } from '@/lib/staging'

const geist = Geist({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'dazl - find leads with proof',
  description: 'Say who you are looking for. dazl finds buyers showing intent and verifies each lead against its source.',
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
      <body className={`${geist.className} antialiased`}>
        {isStaging() && <div role="note" data-testid="staging-banner" className="bg-[#fde68a] text-[#111] text-center text-xs font-mono uppercase tracking-wider py-1">{STAGING_BANNER}</div>}
        {children}
      </body>
    </html>
  )
}
