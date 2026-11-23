import type { Metadata } from 'next'
import Link from 'next/link'
import { SITE_BASE, SUPPORT_EMAIL, publicMeta } from '@/lib/site'
import { OWNER_PLACEHOLDERS } from '@/lib/legal/policy'
export const metadata: Metadata = { ...publicMeta('/contact', 'Contact - dazl', 'How to reach the people behind dazl.'), alternates: { canonical: `${SITE_BASE}/contact` } }

// #1650: support@ for product questions, the policy's address for data requests.
// #1428: /contact used to 404. The address and the company are the ones the privacy policy states (lib/legal/policy.ts).
export default function Contact() {
  const email = OWNER_PLACEHOLDERS.privacyContact
  return (
    <main id="main" className="max-w-2xl mx-auto px-6 py-16 text-[#555] text-sm leading-relaxed">
      <h1 className="text-2xl font-semibold text-[#111] mb-4">Contact</h1>
      <p className="mb-2">Questions about dazl, a problem to report, or help with your account: email <a className="text-[#111] underline underline-offset-2" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
      <p className="mb-2">Requests about your data or your privacy: email <a className="text-[#111] underline underline-offset-2" href={`mailto:${email}`}>{email}</a>.</p>
      <p className="mb-2">dazl is a product of {OWNER_PLACEHOLDERS.legalName}.</p>
      <p className="mt-6"><Link className="text-[#111] underline underline-offset-2" href="/">Back to dazl</Link> · <a className="text-[#111] underline underline-offset-2" href="/terms">Terms</a> · <a className="text-[#111] underline underline-offset-2" href="/privacy">Privacy</a></p>
    </main>
  )
}
