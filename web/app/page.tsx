import type { Metadata } from 'next'
import Link from 'next/link'
import Banner from './banner'
import LandingDemo from './landing-demo'

import { SITE_BASE, SITE_TITLE, SUPPORT_EMAIL, publicMeta } from '@/lib/site'
import { FREE_BETA_TERMS, OWNER_PLACEHOLDERS } from '@/lib/legal/policy'

// Self-referencing canonical (Indexing audit finding: the homepage had none, so the
// apex and www duplicates competed). Kept on the page, not the root layout, so child
// routes don't inherit a canonical pointing at the homepage.
export const metadata: Metadata = {
  ...publicMeta('/', SITE_TITLE),
  alternates: { canonical: SITE_BASE },
}

const STEPS = [
  { n: '1', title: 'Paste your website', desc: 'That is the only thing you type. dazl reads your site and works out who buys from you and which signals to watch for. You can edit it.' },
  { n: '2', title: 'Get new leads every day', desc: 'dazl saves your first search as a Play: a search it keeps running for you. Your first Play runs again every day, searching hiring, funding and expansion news. Each ready lead comes with the line that shows the signal, linked to its source.' },
  { n: '3', title: 'Approve and send', desc: 'dazl drafts the message from the evidence. You approve every email before it sends. Email goes from your own Gmail.' },
]
// The one plan shown at launch (#1428): what the free beta gives, in plain words. No paid plan and no price is shown.
const FREE_BETA = [
  'Searches that find businesses that need what you sell right now.',
  'Proof for each lead: the page it came from, the line that shows the need, and its date when the page gives one.',
  'The person to contact, when dazl finds one: their name, title and own LinkedIn profile, plus their own work email when it is published. When no personal email is published, their LinkedIn profile is the way to reach them, and you send that message yourself. Shared inboxes such as info@ or sales@ never count.',
  'A draft email for each lead. You approve every one, and it goes from your own Gmail.',
  'Optional: the dazl Connect Chrome extension, which reads LinkedIn in your own browser with your own account.',
]
const PROOF = [
  ['Quoted and linked', 'Each ready lead shows the exact line from its source page, with the link.'],
  ['Company and date checked', 'dazl checks that the proof page names the company and reads its date. Anything missing, such as a date or a person, is said on the lead. A lead whose proof could not be confirmed is set aside for you to check, with the reason.'],
  ['You approve every email', 'Every message is reviewed and sent by you, from your own Gmail. Autopilot is not available during the beta.'],
]

export default function Home() {
  return (
    <main id="main" className="app-ui lp min-h-screen flex flex-col">
      <Banner />
      <nav className="flex items-center justify-between gap-4 px-4 sm:px-6 md:px-10 py-5 max-w-6xl mx-auto w-full">
        <span className="text-[22px] font-semibold tracking-tight">dazl</span>
        <div className="hidden md:flex gap-8 text-sm font-medium">
          <a href="#how" className="lp-navlink hover:opacity-70">How it works</a>
          <a href="#pricing" className="lp-navlink hover:opacity-70">Pricing</a>
        </div>
        <div className="flex gap-2">
          <Link href="/sign-in" className="btn-ghost">Sign in</Link>
          <a href="/api/auth/google" className="btn-primary">Start free</a>
        </div>
      </nav>

      <section className="px-4 sm:px-6 pt-12 md:pt-20 pb-10 max-w-4xl mx-auto w-full text-center">
        <h1 className="lp-h1">Your website in.<br />Verified leads out.</h1>
        <p className="text-lg md:text-xl text-[var(--ink-2)] mt-6 max-w-2xl mx-auto leading-relaxed">Paste your website. dazl finds businesses that need what you sell right now, shows you the proof, and drafts the email from your Gmail.</p>
        <p className="text-sm font-semibold mt-4" data-testid="hero-contrast">Proof behind every lead, not a database dump: each lead links to the page that shows why they need you now.</p>
        <p className="text-sm text-[var(--ink-2)] mt-1" data-testid="hero-any">Made for any business, anywhere: paste your website and dazl drafts who buys from you. What it finds depends on the public evidence available for your market.</p>
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
            <div key={t} className="min-w-0" data-testid="proof-item">
              {/* Headings wrap, so a long one stays inside the card at 390px. */}
              {/* .pill is unlayered CSS with white-space: nowrap, which beats Tailwind utilities: wrap it inline. */}
              <span className="pill pill-mint mb-3 max-w-full leading-snug" style={{ whiteSpace: 'normal' }}>✓ {t}</span>
              <p className="text-sm text-[var(--ink-2)] leading-relaxed break-words">{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="pricing" className="px-4 sm:px-6 py-16 max-w-6xl mx-auto w-full">
        <h2 className="lp-h2 text-center mb-10">Free during the beta</h2>
        <div className="max-w-md mx-auto">
          <div className="lp-card p-7" data-testid="free-beta-card">
            <div className="text-sm font-medium text-[var(--ink-2)] mb-1">Beta</div>
            <div className="text-4xl font-semibold mb-2">Free</div>
            <p className="text-[var(--ink-2)] text-sm mb-4">{FREE_BETA_TERMS}</p>
            <ul className="text-sm text-[var(--ink-2)] leading-relaxed mb-6 grid gap-2 list-disc pl-5">
              {FREE_BETA.map(x => <li key={x}>{x}</li>)}
            </ul>
            <a href="/api/auth/google" className="btn-primary w-full text-center block">Start free</a>
          </div>
        </div>
      </section>

      <footer className="mt-auto border-t border-[var(--line)]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--ink-2)]">
          <span className="font-semibold text-[var(--ink)]">dazl</span>
          {/* #1644: each item stays whole and the row wraps between items, so no link is left alone mid-sentence. #1650: support address. */}
          <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="whitespace-nowrap">© 2026 dazl</span>
            <a href="/terms" className="hover:text-[var(--ink)]">Terms</a>
            <a href="/privacy" className="hover:text-[var(--ink)]">Privacy</a>
            <a href="/contact" className="hover:text-[var(--ink)]">Contact</a>
            <a href={`mailto:${SUPPORT_EMAIL}`} className="hover:text-[var(--ink)]">{SUPPORT_EMAIL}</a>
            <Link href="/sign-in" className="whitespace-nowrap hover:text-[var(--ink)]">Sign in</Link>
          </nav>
        </div>
      </footer>
    </main>
  )
}
