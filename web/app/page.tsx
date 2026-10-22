import type { Metadata } from 'next'
import Link from 'next/link'
import Banner from './banner'

import { SITE_BASE } from '@/lib/site'

// Self-referencing canonical (Indexing audit finding: the homepage had none, so the
// apex and www duplicates competed). Kept on the page, not the root layout, so child
// routes don't inherit a canonical pointing at the homepage.
export const metadata: Metadata = {
  alternates: { canonical: SITE_BASE },
}

const STEPS = [
  { n: '1', title: 'Say what you want', desc: 'One sentence in plain words, any industry, any country. No forms about your company.' },
  { n: '2', title: 'dazl builds the profile', desc: 'It works out who the ideal buyer is and what buying signals to look for. You can edit it before anything runs.' },
  { n: '3', title: 'Every lead is checked', desc: 'Each lead links to its source page and quotes the exact line. dazl confirms the company and date on the page, and drops what fails.' },
]
const FEATURES = [
  { title: 'Contacts with the source', desc: 'Named contacts, each with its source: company pages, or your own Apollo or PDL key.' },
  { title: 'One flat price', desc: 'One flat price. No credits, no overages, no per-lead fees.' },
  { title: 'No region locks', desc: 'Works from public sources worldwide.' },
  { title: 'Proof on every lead', desc: 'Source link, exact quote, event date and a confidence score. Leads that cannot be verified never reach your list, and you see how many were dropped and why.' },
  { title: 'Your key, your cost', desc: 'Bring your own Anthropic or OpenAI key. Usage is billed by the provider at cost, and your key is encrypted at rest.' },
  { title: 'You approve every send', desc: 'Email goes from your own Gmail, one message at a time, after you approve the exact text. Unsubscribe links are built in and honored right away.' },
]

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col bg-white text-[#111]">
      <Banner />
      <nav className="relative grid grid-cols-[1fr_auto] md:grid-cols-[1fr_auto_1fr] items-center px-6 md:px-10 py-4 max-w-6xl mx-auto w-full">
        <span className="text-[18px] font-medium tracking-tight">dazl</span>
        <div className="hidden md:flex gap-8 text-sm text-[#555]">
          <a href="#how" className="hover:text-[#111]">How it works</a>
          <a href="#pricing" className="hover:text-[#111]">Pricing</a>
          <a href="#faq" className="hover:text-[#111]">FAQ</a>
          <a href="#updates" className="hover:text-[#111]">Updates</a>
        </div>
        <div className="flex gap-2 justify-end">
          <Link href="/sign-in" className="btn-primary">Log in</Link>
          <Link href="/sign-up" className="btn-primary">Start free</Link>
        </div>
      </nav>

      <div className="rails relative max-w-6xl mx-auto w-full">
        <section className="px-6 md:px-12 pt-14 md:pt-20 pb-10">
          <h1 className="text-[40px] md:text-[52px] font-semibold leading-[1.08] tracking-[-0.02em] max-w-3xl">Where buyers get found, and proven.</h1>
          <p className="text-lg md:text-[20px] text-[#555] mt-5 max-w-[700px] leading-[1.45]">Find warm leads from live buying signals (hiring, funding, complaints, expansions), each with the proof quoted and linked.</p>
          <div className="flex flex-wrap gap-3 mt-8">
            <Link href="/sign-up" className="btn-primary">Start for free</Link>
            <a href="#how" className="btn-ghost">How it works</a>
          </div>
          <p className="text-sm text-[#666] mt-4">3 trial scans, then bring your own key (BYOK).</p>
        </section>

        <section className="px-4 md:px-8 pb-16">
          <div className="stage px-4 md:px-10 py-12 md:py-20 flex flex-col items-center gap-4">
            <div className="flex gap-1 rounded-md bg-white border border-black/15 p-1 mono">
              {['Find', 'Verify', 'Review', 'Send'].map((t, i) => <span key={t} className="tab" data-on={i === 0}>{t}</span>)}
            </div>
            <div className="w-full max-w-2xl rounded-lg bg-white border border-black/15 p-5 text-left text-[#111]">
              <div className="text-xs text-[#666] mb-2">What are you looking for?</div>
              <div className="text-base md:text-lg">Seed-stage fintech founders in Europe who just hired their first sales rep</div>
              <div className="mt-5 grid gap-2 text-sm border-t border-black/10 pt-4">
                <div className="flex gap-2 items-start"><span className="badge mono shrink-0">verified</span><span>Head of Sales role posted after a seed round <span className="text-[#666]">(quote on page, dated this month)</span></span></div>
                <div className="flex gap-2 items-start"><span className="badge mono shrink-0">verified</span><span>New Berlin office with two sales roles <span className="text-[#666]">(source linked)</span></span></div>
                <div className="flex gap-2 items-start"><span className="badge mono shrink-0 badge-review">review</span><span>Site blocked our check, open the source yourself</span></div>
              </div>
            </div>
            <div className="text-xs text-[#555]">Illustration only. Real results depend on your request and the live web.</div>
          </div>
        </section>
      </div>

      <section id="how" className="relative px-6 py-20 max-w-6xl mx-auto w-full">
        <h2 className="text-3xl font-medium tracking-tight mb-10">How it works</h2>
        <div className="grid md:grid-cols-3 gap-5">
          {STEPS.map(s => (
            <div key={s.n} className="card card-hover p-6">
              <div className="w-8 h-8 rounded-full bg-black/5 text-[#111] text-sm font-semibold flex items-center justify-center mb-4">{s.n}</div>
              <h3 className="font-semibold text-lg mb-2">{s.title}</h3>
              <p className="text-[#555] text-sm leading-relaxed">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="relative px-6 pb-20 max-w-5xl mx-auto w-full">
        <div className="grid md:grid-cols-3 gap-5">
          {FEATURES.map(f => (
            <div key={f.title} className="card card-hover p-6">
              <h3 className="font-semibold text-lg mb-2">{f.title}</h3>
              <p className="text-[#555] text-sm leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="pricing" className="relative text-center px-6 py-20 border-t border-black/10">
        <h2 className="text-3xl font-medium tracking-tight mb-2">Simple pricing</h2>
        <p className="text-[#555] mb-10">You pay your AI provider directly for the usage on your own key.</p>
        <div className="flex flex-wrap gap-5 justify-center">
          <div className="card p-8 max-w-xs w-full text-left">
            <div className="text-sm text-[#555] mb-1">Free</div>
            <div className="text-4xl font-medium mb-1">$0</div>
            <p className="text-[#555] text-sm mb-6">3 trial scans, then your own AI key</p>
            <Link href="/sign-up" className="btn-ghost w-full">Start free</Link>
          </div>
          <div className="card p-8 max-w-xs w-full text-left !border-black/50 ">
            <div className="text-sm text-[#111] mb-1">Pro</div>
            <div className="text-4xl font-medium mb-1">$49/mo</div>
            <p className="text-[#555] text-sm mb-6">Unlimited scans. One flat price. No credits, no overages, no per-lead fees.</p>
            <Link href="/sign-up" className="btn-primary w-full">Start free, upgrade any time</Link>
          </div>
        </div>
      </section>

      <section id="faq" className="relative px-6 py-20 max-w-3xl mx-auto w-full border-t border-black/10">
        <h2 className="text-3xl font-medium tracking-tight mb-8">Questions</h2>
        {[
          ['Which AI key do I need?', 'An Anthropic or OpenAI API key. Add it in Settings. Scans run on your key and the provider bills you directly.'],
          ['How are leads checked?', 'dazl opens the cited page, confirms the quote is on it, that it names the company, and that the date is recent. Leads that fail are dropped, and you see the counts and reasons.'],
          ['Does dazl send email for me?', 'Not by itself. Sending is off in this release. When it is available, each email goes from your own Gmail after you approve the exact text.'],
        ].map(([q, a]) => (
          <details key={q} className="border-b border-black/10 py-4 group">
            <summary className="cursor-pointer text-[#222] list-none flex justify-between">{q}<span className="text-[#666] group-open:rotate-45 transition">+</span></summary>
            <p className="text-[#555] text-sm mt-3 leading-relaxed">{a}</p>
          </details>
        ))}
      </section>

      <section id="updates" className="relative px-6 py-14 max-w-3xl mx-auto w-full border-t border-black/10">
        <h2 className="text-xl font-medium tracking-tight mb-2">Updates</h2>
        <p className="text-[#666] text-sm">Nothing posted yet.</p>
      </section>

      <footer className="relative text-center py-8 text-[#6b6b6b] text-sm border-t border-black/10">
        © 2026 dazl · <a href="/terms" className="hover:text-[#111]">Terms</a> · <a href="/privacy" className="hover:text-[#111]">Privacy</a>
      </footer>
    </main>
  )
}
