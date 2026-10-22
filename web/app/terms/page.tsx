import type { Metadata } from 'next'
import { SITE_BASE } from '@/lib/site'
export const metadata: Metadata = { title: 'Terms of Service - dazl', alternates: { canonical: `${SITE_BASE}/terms` } }

export default function Terms() {
  return (
    <main className="max-w-2xl mx-auto px-6 py-16 text-[#555] text-sm leading-relaxed">
      <p className="mb-6 rounded-lg border border-black/40 bg-[#f4f4f4] p-3 text-[#111]">
        DRAFT - placeholder text for review by the site owner and a lawyer before launch. Not legal advice.
      </p>
      <h1 className="text-2xl font-semibold text-[#111] mb-4">Terms of Service</h1>
      <p className="mb-4">Last updated: [DATE]. By using dazl.ai you agree to these terms with [COMPANY LEGAL NAME].</p>
      <h2 className="text-lg font-semibold text-[#111] mt-6 mb-2">The service</h2>
      <p>dazl finds prospects from public sources and drafts outreach. You are responsible for the messages you approve and send.</p>
      <h2 className="text-lg font-semibold text-[#111] mt-6 mb-2">Acceptable use</h2>
      <p>No spam, no purchased lists, no messages to people who asked to stop, no illegal or deceptive content. You must comply with anti-spam laws that apply to you and your recipients.</p>
      <h2 className="text-lg font-semibold text-[#111] mt-6 mb-2">Billing</h2>
      <p>[PLANS AND PRICING WHEN PAID PLANS LAUNCH]</p>
      <h2 className="text-lg font-semibold text-[#111] mt-6 mb-2">Liability and termination</h2>
      <p>[LIABILITY, WARRANTY, TERMINATION, GOVERNING LAW - TO BE WRITTEN BY COUNSEL]</p>
    </main>
  )
}
