import type { Metadata } from 'next'
import { SITE_BASE, publicMeta } from '@/lib/site'
import PublicShell from '../public-shell'

export const metadata: Metadata = { ...publicMeta('/about', 'About - dazl', 'What dazl does and who makes it.'), alternates: { canonical: `${SITE_BASE}/about` } }

// #1428: /about answers with what dazl does and the company behind it.
export default function About() {
  return (
    <PublicShell>
      <h1 className="lp-h2 mb-6">About dazl</h1>
      <p className="text-[var(--ink-2)] mb-3">Paste your website. dazl finds businesses that need what you sell right now, shows you the proof, and drafts the email from your Gmail.</p>
      <p className="text-[var(--ink-2)] mb-3">dazl is a product of Mathematricks - F.Z.E. (Ajman Free Zone, United Arab Emirates).</p>
      <p className="text-[var(--ink-2)]">Contact: <a className="underline" href="mailto:support@dazl.ai">support@dazl.ai</a>.</p>
    </PublicShell>
  )
}
