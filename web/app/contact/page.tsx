import type { Metadata } from 'next'
import { SITE_BASE, publicMeta } from '@/lib/site'
import PublicShell from '../public-shell'

export const metadata: Metadata = { ...publicMeta('/contact', 'Contact - dazl', 'How to reach the dazl team.'), alternates: { canonical: `${SITE_BASE}/contact` } }

// #1428: /contact answers with the support and privacy addresses.
export default function Contact() {
  return (
    <PublicShell>
      <h1 className="lp-h2 mb-6">Contact</h1>
      <p className="text-[var(--ink-2)] mb-3">Questions, help with your account or anything else: <a className="underline" href="mailto:support@dazl.ai">support@dazl.ai</a>.</p>
      <p className="text-[var(--ink-2)]">Privacy questions and data requests: <a className="underline" href="mailto:privacy@dazl.ai">privacy@dazl.ai</a>.</p>
    </PublicShell>
  )
}
