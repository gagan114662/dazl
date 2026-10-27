import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import './globals.css'
import { chunkRecoveryScript } from '@/lib/chunk-recovery'

const geist = Geist({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'dazl - find leads with proof',
  description: 'Say who you are looking for. dazl finds buyers showing intent and verifies each lead against its source.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" style={{backgroundColor:"#fff",color:"#111"}}>
      <head>
        {/* Runs before the page's chunks load; see lib/chunk-recovery.ts for the bounded reload policy. */}
        <script dangerouslySetInnerHTML={{ __html: chunkRecoveryScript(process.env.NEXT_PUBLIC_DAZL_BUILD || '') }} />
      </head>
      <body className={`${geist.className} antialiased`}>
        {children}
      </body>
    </html>
  )
}
