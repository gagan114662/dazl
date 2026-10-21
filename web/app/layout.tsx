import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import './globals.css'

const geist = Geist({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'dazl - find leads with proof',
  description: 'Say who you are looking for. dazl finds buyers showing intent and verifies each lead against its source.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" style={{backgroundColor:"#fff",color:"#111"}}>
      <body className={`${geist.className} antialiased`}>
        {children}
        <footer style={{padding:'12px 24px',fontSize:'11px',color:'#999',textAlign:'center',borderTop:'1px solid #f0f0f0'}}>
          Contact crawl powered by{' '}
          <a href="https://crawlee.dev" target="_blank" rel="noopener noreferrer" style={{color:'#999'}}>Crawlee</a>
          {' '}— software developed by Apify.
        </footer>
      </body>
    </html>
  )
}
