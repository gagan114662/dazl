import Link from 'next/link'
import { SUPPORT_EMAIL } from '@/lib/site'

// #1781: one site footer for the public pages, copied from the homepage's footer (app/page.tsx) so the links cannot
// drift. `compact` drops the homepage's 32px block padding: the sign-up card is 852px tall at 1440x900, so the auth
// pages need the footer to stay inside the visible height. The links keep a 44px hit area (#672) with negative
// horizontal margins, so the row looks the same as the homepage's.
const LINK = 'inline-flex items-center min-h-11 px-2 -mx-2 hover:text-[var(--ink)]'

export default function SiteFooter({ compact = false }: { compact?: boolean }) {
  return (
    <footer className="mt-auto border-t border-[var(--line)]">
      <div className={`max-w-6xl mx-auto px-4 sm:px-6 ${compact ? '' : 'py-8'} flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--ink-2)]`}>
        <span className="font-semibold text-[var(--ink)]">dazl</span>
        {/* #1644: each item stays whole and the row wraps between items, so no link is left alone mid-sentence. #1650: support address. */}
        <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="whitespace-nowrap">© 2026 dazl</span>
          <a href="/terms" className={LINK}>Terms</a>
          <a href="/privacy" className={LINK}>Privacy</a>
          <a href="/contact" className={LINK}>Contact</a>
          <a href={`mailto:${SUPPORT_EMAIL}`} className={LINK}>{SUPPORT_EMAIL}</a>
          <Link href="/sign-in" className={`${LINK} whitespace-nowrap`}>Sign in</Link>
        </nav>
      </div>
    </footer>
  )
}
