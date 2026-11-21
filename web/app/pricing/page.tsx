import type { Metadata } from 'next'
import { SITE_BASE, publicMeta } from '@/lib/site'
import PublicShell from '../public-shell'
import FreeBetaCard from '../free-beta-card'

export const metadata: Metadata = { ...publicMeta('/pricing', 'Pricing - dazl', 'dazl is free while in beta.'), alternates: { canonical: `${SITE_BASE}/pricing` } }

// #1428: the same free-beta card as the homepage's pricing section (app/free-beta-card.tsx), as its own page.
export default function Pricing() {
  return (
    <PublicShell>
      <h1 className="lp-h2 text-center mb-10">Free while in beta</h1>
      <FreeBetaCard />
    </PublicShell>
  )
}
