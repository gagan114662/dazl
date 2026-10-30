import type { Metadata } from 'next'

// A page opened from an emailed one-time link: never indexed.
export const metadata: Metadata = { robots: { index: false, follow: false } }

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
