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
    <html lang="en" style={{backgroundColor:"#030712",color:"#f9fafb"}}>
      <body className={`${geist.className} antialiased`}>
        {children}
      </body>
    </html>
  )
}
