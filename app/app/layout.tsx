import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import './globals.css'

const geist = Geist({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'dazl — your GTM AI coworker',
  description: 'Finds buyers, reaches them, books meetings, takes payment. All without you.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${geist.className} bg-gray-950 text-white antialiased`}>
        {children}
      </body>
    </html>
  )
}
