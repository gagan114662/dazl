import type { Metadata } from 'next'
import { SITE_BASE, publicMeta } from '@/lib/site'
import { DRAFT_NOTICE, PRIVACY } from '@/lib/legal/policy'
export const metadata: Metadata = { ...publicMeta('/privacy', 'Privacy Policy - dazl', 'What data dazl collects, how it is used and shared, and your rights.'), alternates: { canonical: `${SITE_BASE}/privacy` } }

// Text and facts live in lib/legal/policy.ts, held to the code by test/legal-policy.test.ts (#535).
export default function Privacy() {
  return (
    <main id="main" tabIndex={-1} className="outline-none max-w-2xl mx-auto px-6 py-16 text-[#555] text-sm leading-relaxed">
      <p className="mb-6 rounded-lg border border-black/40 bg-[#f4f4f4] p-3 text-[#111]">{DRAFT_NOTICE}</p>
      <h1 className="text-2xl font-semibold text-[#111] mb-4">Privacy Policy</h1>
      {PRIVACY.map(s => (
        <section key={s.heading}>
          <h2 className="text-lg font-semibold text-[#111] mt-6 mb-2">{s.heading}</h2>
          {s.paragraphs.map((p, i) => <p key={i} className="mb-2">{p}</p>)}
        </section>
      ))}
    </main>
  )
}
