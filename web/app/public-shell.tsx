import Wordmark from './wordmark'

// #1428: the plain public pages (pricing, plans, about, contact) share the homepage's nav wordmark and footer links.
export default function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="app-ui lp min-h-screen flex flex-col">
      <nav className="flex items-center justify-between gap-4 px-4 sm:px-6 md:px-10 py-5 max-w-6xl mx-auto w-full">
        <Wordmark />
        <div className="flex gap-2">
          <a href="/sign-in" className="btn-ghost">Sign in</a>
          <a href="/sign-up" className="btn-primary">Start free</a>
        </div>
      </nav>
      <div className="px-4 sm:px-6 py-12 max-w-3xl mx-auto w-full">{children}</div>
      <footer className="mt-auto border-t border-[var(--line)]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--ink-2)]">
          <span className="font-semibold text-[var(--ink)]">dazl</span>
          <span>© 2026 dazl · <a href="/about" className="hover:text-[var(--ink)]">About</a> · <a href="/contact" className="hover:text-[var(--ink)]">Contact</a> · <a href="/terms" className="hover:text-[var(--ink)]">Terms</a> · <a href="/privacy" className="hover:text-[var(--ink)]">Privacy</a> · <a href="mailto:support@dazl.ai" className="hover:text-[var(--ink)]">support@dazl.ai</a></span>
        </div>
      </footer>
    </main>
  )
}
