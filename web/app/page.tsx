import type { Metadata } from 'next'
import Link from 'next/link'
import Banner from './banner'
import LandingDemo from './landing-demo'

import { SITE_BASE } from '@/lib/site'

// Self-referencing canonical (Indexing audit finding: the homepage had none, so the
// apex and www duplicates competed). Kept on the page, not the root layout, so child
// routes don't inherit a canonical pointing at the homepage.
export const metadata: Metadata = {
  alternates: { canonical: SITE_BASE },
}

const STEPS = [
  { n: '1', title: 'Paste your website', desc: 'That is the only thing you type. dazl reads your site and works out who buys from you and which signals to watch for. You can edit it.' },
  { n: '2', title: 'Get new leads every week', desc: 'Your Play runs again each week, searching hiring, funding and expansion news. Each lead comes with the line that shows the signal, linked to its source.' },
  { n: '3', title: 'Approve and send', desc: 'dazl drafts the message from the evidence. Nothing sends until you approve it, and it goes from your own Gmail.' },
]
const PROOF = [
  ['Quoted and linked', 'Every lead shows the exact line from its source page, with the link.'],
  ['Company and date checked', 'dazl confirms the page names the company and that the date is recent. Leads that fail a check are held for your review, out of the ready-to-contact list.'],
  ['Nothing sends until you approve it', 'Email goes from your own Gmail. Autopilot is off unless you turn it on; it has a sending limit you set and starts only after you have approved your first sends.'],
]

export default function Home() {
  return (
    <main className="app-ui lp min-h-screen flex flex-col">
      <Banner />
      <nav className="flex items-center justify-between gap-4 px-4 sm:px-6 md:px-10 py-5 max-w-6xl mx-auto w-full">
        <span className="text-[22px] font-semibold tracking-tight">dazl</span>
        <div className="hidden md:flex gap-8 text-sm font-medium">
          <a href="#how" className="hover:opacity-70">How it works</a>
          <a href="#pricing" className="hover:opacity-70">Pricing</a>
        </div>
        <div className="flex gap-2">
          <Link href="/sign-in" className="btn-ghost">Sign in</Link>
          <a href="/api/auth/google" className="btn-primary">Start free</a>
        </div>
      </nav>

      <section className="px-4 sm:px-6 pt-12 md:pt-20 pb-10 max-w-4xl mx-auto w-full text-center">
        <h1 className="lp-h1">Your website in.<br />Verified leads out.</h1>
        <p className="text-lg md:text-xl text-[var(--ink-2)] mt-6 max-w-2xl mx-auto leading-relaxed">dazl reads your site and finds companies with a buying signal right now. Every lead comes with the quoted line, a working source link and a date, and dazl checks the company and date match before a lead is marked ready.</p>
        <p className="text-sm font-semibold mt-4" data-testid="hero-contrast">Evidence for every lead, not a list of guesses.</p>
        <p className="text-sm text-[var(--ink-2)] mt-1" data-testid="hero-any">For any business, in any country: paste your website and dazl works out who buys from you.</p>
        <div className="flex flex-wrap gap-3 mt-8 justify-center">
          <a href="/api/auth/google" className="btn-primary btn-lg" data-testid="hero-cta">Start free</a>
          <a href="#how" className="btn-ghost btn-lg">See how it works</a>
        </div>
      </section>

      <section className="px-4 sm:px-6 pb-20 max-w-3xl mx-auto w-full">
        <LandingDemo />
      </section>

      <section id="how" className="px-4 sm:px-6 py-16 max-w-6xl mx-auto w-full">
        <h2 className="lp-h2 text-center mb-10">How it works</h2>
        <div className="grid md:grid-cols-3 gap-4">
          {STEPS.map(s => (
            <div key={s.n} className="lp-card p-6" data-testid="step">
              <div className="w-8 h-8 rounded-full bg-[var(--soft)] text-sm font-semibold flex items-center justify-center mb-4">{s.n}</div>
              <h3 className="font-semibold text-lg mb-2">{s.title}</h3>
              <p className="text-[var(--ink-2)] text-sm leading-relaxed">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="px-4 sm:px-6 pb-16 max-w-6xl mx-auto w-full" data-testid="proof">
        <div className="lp-card p-6 md:p-8 grid md:grid-cols-3 gap-6">
          {PROOF.map(([t, d]) => (
            <div key={t}>
              <span className="pill pill-mint mb-3">✓ {t}</span>
              <p className="text-sm text-[var(--ink-2)] leading-relaxed">{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="pricing" className="px-4 sm:px-6 py-16 max-w-6xl mx-auto w-full">
        <h2 className="lp-h2 text-center mb-10">Simple pricing</h2>
        <div className="grid sm:grid-cols-2 gap-4 max-w-2xl mx-auto">
          <div className="lp-card p-7">
            <div className="text-sm font-medium text-[var(--ink-2)] mb-1">Free</div>
            <div className="text-4xl font-semibold mb-2">$0</div>
            <p className="text-[var(--ink-2)] text-sm mb-6">Start free.</p>
            <a href="/api/auth/google" className="btn-ghost w-full text-center block">Start free</a>
          </div>
          <div className="lp-card p-7">
            <div className="text-sm font-medium mb-1">Pro</div>
            <div className="text-4xl font-semibold mb-2">$49<span className="text-base font-medium text-[var(--ink-2)]">/mo</span></div>
            <p className="text-[var(--ink-2)] text-sm mb-6">One flat price. Runs on your own AI key: your provider bills that usage separately. Fair-use limits apply.</p>
            <a href="/api/auth/google" className="btn-primary w-full text-center block">Start free, upgrade any time</a>
          </div>
        </div>
      </section>

      <footer className="mt-auto border-t border-[var(--line)]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--ink-2)]">
          <span className="font-semibold text-[var(--ink)]">dazl</span>
          <span>© 2026 dazl · <a href="/terms" className="hover:text-[var(--ink)]">Terms</a> · <a href="/privacy" className="hover:text-[var(--ink)]">Privacy</a> · <Link href="/sign-in" className="hover:text-[var(--ink)]">Sign in</Link></span>
        </div>
      </footer>
    </main>
  )
}
