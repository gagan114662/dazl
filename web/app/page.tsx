import type { Metadata } from 'next'
import Link from 'next/link'
import Banner from './banner'
import LandingDemo from './landing-demo'

import { SITE_BASE, SITE_TITLE, publicMeta } from '@/lib/site'
import FreeBetaCard from './free-beta-card'
import Wordmark from './wordmark'

// Self-referencing canonical (Indexing audit finding: the homepage had none, so the
// apex and www duplicates competed). Kept on the page, not the root layout, so child
// routes don't inherit a canonical pointing at the homepage.
export const metadata: Metadata = {
  ...publicMeta('/', SITE_TITLE),
  alternates: { canonical: SITE_BASE },
}

const STEPS = [
  { n: '1', title: 'Paste your website', desc: 'That is the only thing you type. dazl reads your site and works out who buys from you and which signals to watch for. You can edit it.' },
  { n: '2', title: 'Get new leads every day', desc: 'Your first search runs again every day, looking for hiring, funding and expansion news. Each ready lead comes with the line that shows the signal, linked to its source.' },
  { n: '3', title: 'Approve and send', desc: 'dazl drafts the message from the evidence. You approve each email before it sends, unless you turn on Autopilot. Email goes from your own Gmail.' },
]
const PROOF = [
  ['Quoted and linked', 'Each ready lead shows the exact line from its source page, with the link.'],
  ['Company and date checked', 'dazl confirms the page names the company and that the date is recent. A lead that fails a check is kept out of your ready list, with the reason.'],
  ['You approve each send, unless you turn on Autopilot', 'Email goes from your own Gmail. Autopilot is off unless you turn it on. Once on, and after you have approved your first sends, later emails can send without your individual review, within the sending limit you set.'],
]

export default function Home() {
  return (
    <main id="main" className="app-ui lp min-h-screen flex flex-col">
      <Banner />
      <nav className="flex items-center justify-between gap-4 px-4 sm:px-6 md:px-10 py-5 max-w-6xl mx-auto w-full">
        <Wordmark />
        <div className="hidden md:flex gap-8 text-sm font-medium">
          <a href="#how" className="lp-navlink hover:opacity-70">How it works</a>
          <a href="#pricing" className="lp-navlink hover:opacity-70">Pricing</a>
        </div>
        <div className="flex gap-2">
          <Link href="/sign-in" className="btn-ghost">Sign in</Link>
          <a href="/sign-up" className="btn-primary">Start free</a>
        </div>
      </nav>

      <section className="px-4 sm:px-6 pt-12 md:pt-20 pb-10 max-w-4xl mx-auto w-full text-center">
        <h1 className="lp-h1">Your website in.<br />Verified leads out.</h1>
        <p className="text-lg md:text-xl text-[var(--ink-2)] mt-6 max-w-2xl mx-auto leading-relaxed" data-testid="hero-sub">Paste your website. dazl finds businesses that need what you sell right now, shows you the proof, and drafts the email from your Gmail.</p>
        <p className="text-sm font-semibold mt-4" data-testid="hero-contrast">Proof behind every lead, not a database dump.</p>
        <div className="flex flex-wrap gap-3 mt-8 justify-center">
          <a href="/sign-up" className="btn-primary btn-lg" data-testid="hero-cta">Start free</a>
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
        <h2 className="lp-h2 text-center mb-10">Free while in beta</h2>
        <FreeBetaCard />
      </section>

      <footer className="mt-auto border-t border-[var(--line)]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--ink-2)]">
          <span className="font-semibold text-[var(--ink)]">dazl</span>
          <span>© 2026 dazl · <a href="/about" className="hover:text-[var(--ink)]">About</a> · <a href="/contact" className="hover:text-[var(--ink)]">Contact</a> · <a href="/terms" className="hover:text-[var(--ink)]">Terms</a> · <a href="/privacy" className="hover:text-[var(--ink)]">Privacy</a> · <a href="mailto:support@dazl.ai" className="hover:text-[var(--ink)]">support@dazl.ai</a> · <Link href="/sign-in" className="hover:text-[var(--ink)]">Sign in</Link></span>
        </div>
      </footer>
    </main>
  )
}
