import Link from 'next/link'
import { Suspense } from 'react'
import Nav from './nav'
import { Icon } from './ui/icons'

// The /app sign-in gate is proxy.ts: a request without a live session gets a 307 to /sign-in before any HTML is sent.
// The layout itself reads nothing per request, so every /app page is prerendered once at build and served as static
// HTML. The shell carries no tenant data: everything a page shows comes from /api routes that check the session
// themselves. (A per-request session read here made Next render each /app request's dynamic part again, which under
// concurrency took seconds: load/README.md, "app-load".)
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-ui flex flex-col md:flex-row h-screen">
      {/* CSS-only collapsing nav: a checkbox toggles the menu below md; a slim sidebar from md up */}
      <input id="navtoggle" type="checkbox" className="peer sr-only" aria-label="Menu" />
      <header className="md:hidden flex items-center justify-between border-b border-[var(--line)] bg-[var(--canvas)] px-4 py-3 shrink-0">
        <Link href="/app" className="text-lg font-bold tracking-tight">dazl<span className="text-[var(--pink)]">.</span></Link>
        <label htmlFor="navtoggle" className="cursor-pointer text-sm font-semibold border border-[var(--line-2)] rounded-full px-4 py-1.5">Menu</label>
      </header>
      <aside className="hidden peer-checked:flex md:flex md:w-60 shrink-0 border-b md:border-b-0 md:border-r border-[var(--line)] bg-[var(--canvas)] flex-col py-4 md:py-6 px-3 md:overflow-auto">
        <Link href="/app" className="hidden md:block text-xl font-bold tracking-tight mb-6 px-3">dazl<span className="text-[var(--pink)]">.</span></Link>
        <Suspense fallback={null}><Nav /></Suspense>
        <div className="hidden md:block flex-1" />
        <form action="/api/auth/signout" method="POST" className="mt-4"><button className="flex items-center gap-2.5 text-sm text-[var(--ink-3)] hover:text-[var(--ink)] px-3 py-2 transition"><Icon name="signout" className="w-[18px] h-[18px]" />Sign out</button></form>
      </aside>
      <main className="flex-1 min-w-0 overflow-auto">
        <Suspense fallback={null}>{children}</Suspense>
      </main>
    </div>
  )
}
