import type { Metadata } from 'next'
import Link from 'next/link'
import Banner from './banner'
import LandingDemo from './landing-demo'

import { SITE_BASE, SITE_TITLE, publicMeta } from '@/lib/site'
import { PLAN_PRICE_USD_MONTHLY, PRICE_DISCLOSURE } from '@/lib/plans'

// Self-referencing canonical (Indexing audit finding: the homepage had none, so the
// apex and www duplicates competed). Kept on the page, not the root layout, so child
// routes don't inherit a canonical pointing at the homepage.
export const metadata: Metadata = {
  ...publicMeta('/', SITE_TITLE),
  alternates: { canonical: SITE_BASE },
}

const STEPS = [
  { title: 'Paste your website', desc: 'That is the only thing you type. dazl reads your site and works out who buys from you and which signals to watch for. You can edit it.' },
  { title: 'Get new leads every day', desc: 'Your first Play runs again every day, searching hiring, funding and expansion news. Each ready lead comes with the line that shows the signal, linked to its source.' },
  { title: 'Approve and send', desc: 'dazl drafts the message from the evidence. You approve each email before it sends, unless you turn on Autopilot. Email goes from your own Gmail.' },
]
const PROOF = [
  ['Quoted and linked', 'Each ready lead shows the exact line from its source page, with the link.'],
  ['Company and date checked', 'dazl confirms the page names the company and that the date is recent. Leads that fail a check are held for your review, out of the ready-to-contact list.'],
  ['You approve each send, unless you turn on Autopilot', 'Email goes from your own Gmail. Autopilot is off unless you turn it on. Once on, and after you have approved your first sends, later emails can send without your individual review, within the sending limit you set.'],
]

export default function Home() {
  return (
    <main id="main" className="app-ui lp min-h-screen flex flex-col">
      <Banner />
      <nav aria-label="Main navigation" className="lp-navbar flex items-center justify-between gap-3 px-4 sm:px-6 md:px-10 py-4 max-w-6xl mx-auto w-full">
        <Link href="/" className="lp-wordmark" aria-label="dazl home"><span aria-hidden="true">✦</span>dazl</Link>
        <div className="hidden md:flex gap-8 text-sm font-medium">
          <a href="#how" className="lp-navlink hover:opacity-70">How it works</a>
          <a href="#pricing" className="lp-navlink hover:opacity-70">Pricing</a>
        </div>
        <div className="flex gap-2">
          <Link href="/sign-in" className="btn-ghost">Sign in</Link>
          <a href="/api/auth/google" className="btn-primary">Start free</a>
        </div>
      </nav>

      <section className="lp-hero px-4 sm:px-6 max-w-4xl mx-auto w-full text-center">
        <h1 className="lp-h1">Your website in.<br /><em>Verified leads out.</em></h1>
        <p className="lp-intro text-[var(--ink-2)] mt-6 mx-auto">dazl reads your site and finds companies with a buying signal right now. Leads marked ready come with the quoted line, the source link and the date, checked against the company. Leads dazl cannot confirm stay held for your review, with the reason.</p>
        <p className="text-sm font-semibold mt-4" data-testid="hero-contrast">Evidence for every ready lead, not a list of guesses.</p>
        <p className="text-sm text-[var(--ink-2)] mt-3 max-w-lg mx-auto" data-testid="hero-any">Made for any business, anywhere: paste your website and dazl drafts who buys from you. What it finds depends on the public evidence available for your market.</p>
        <div className="flex flex-wrap gap-3 mt-8 justify-center">
          <a href="/api/auth/google" className="btn-primary btn-lg" data-testid="hero-cta">Start free</a>
          <a href="#how" className="btn-ghost btn-lg">See how it works</a>
        </div>
      </section>

      <section className="lp-demo-section mx-auto w-full" aria-label="Product demo">
        <div className="lp-demo-frame"><LandingDemo /></div>
      </section>

      <section id="how" className="px-4 sm:px-6 py-16 max-w-6xl mx-auto w-full">
        <h2 className="lp-h2 text-center mb-10">How it works</h2>
        <div className="grid md:grid-cols-3 gap-4">
          {STEPS.map(s => (
            <div key={s.title} className="lp-step p-6" data-testid="step">
              <h3 className="font-semibold text-lg mb-2">{s.title}</h3>
              <p className="text-[var(--ink-2)] text-sm leading-relaxed">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="px-4 sm:px-6 pb-16 max-w-6xl mx-auto w-full" data-testid="proof">
        <div className="lp-card p-6 md:p-8 grid md:grid-cols-3 gap-6">
          {PROOF.map(([t, d]) => (
            <div key={t} className="min-w-0" data-testid="proof-item">
              {/* Headings wrap: the Autopilot one is long and must stay inside the card at 390px. */}
              {/* .pill is unlayered CSS with white-space: nowrap, which beats Tailwind utilities: wrap it inline. */}
              <span className="pill pill-mint mb-3 max-w-full leading-snug" style={{ whiteSpace: 'normal' }}>✓ {t}</span>
              <p className="text-sm text-[var(--ink-2)] leading-relaxed break-words">{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="pricing" className="px-4 sm:px-6 py-16 max-w-6xl mx-auto w-full">
        <h2 className="lp-h2 text-center mb-10">Simple pricing</h2>
        <div className="grid sm:grid-cols-2 gap-4 max-w-2xl mx-auto">
          <div className="lp-card p-7">
            <div className="text-sm font-medium text-[var(--ink-2)] mb-1">Free</div>
            <div className="text-4xl font-semibold mb-2">${PLAN_PRICE_USD_MONTHLY.free}</div>
            <p className="text-[var(--ink-2)] text-sm mb-6">Start free.</p>
            <a href="/api/auth/google" className="btn-ghost w-full text-center block">Start free</a>
          </div>
          <div className="lp-card lp-pro p-7">
            <div className="text-sm font-medium mb-1">Pro</div>
            <div className="text-4xl font-semibold mb-2">${PLAN_PRICE_USD_MONTHLY.pro}<span className="text-base font-medium text-[var(--ink-2)]">/mo</span></div>
            <p className="text-[var(--ink-2)] text-sm mb-6">One flat price. {PRICE_DISCLOSURE} Fair-use limits apply.</p>
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
