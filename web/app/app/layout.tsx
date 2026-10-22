import Link from 'next/link'
import { Suspense } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth-db'

const NAV = [
  { href: '/app', label: 'Home' },
  { href: '/app/leads', label: 'Leads' },
  { href: '/app/outreach', label: 'Outreach' },
  { href: '/app/follow-ups', label: 'Follow-ups' },
  { href: '/app/replies', label: 'Replies' },
  { href: '/app/inbox', label: 'Inbox' },
  { href: '/app/seo', label: 'SEO' },
  { href: '/app/settings', label: 'Settings' },
]

async function AuthGate({ children }: { children: React.ReactNode }) {
  const token = (await cookies()).get('dazl_session')?.value
  if (!getSessionUser(token)) redirect('/sign-in')
  return <>{children}</>
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col md:flex-row h-screen bg-white">
      {/* CSS-only collapsing nav: a checkbox toggles the menu below md, sidebar is fixed-width from md up */}
      <input id="navtoggle" type="checkbox" className="peer sr-only" aria-label="Menu" />
      <header className="md:hidden flex items-center justify-between border-b border-black/10 bg-[#fafafa] px-4 py-3 shrink-0">
        <Link href="/app" className="text-lg font-semibold tracking-tight">dazl.</Link>
        <label htmlFor="navtoggle" className="cursor-pointer font-mono text-xs uppercase tracking-wider border border-black px-3 py-2">Menu</label>
      </header>
      <aside className="hidden peer-checked:flex md:flex md:w-56 shrink-0 border-b md:border-b-0 md:border-r border-black/10 bg-[#fafafa] flex-col py-4 md:py-6 px-4 gap-1 md:overflow-auto">
        <Link href="/app" className="hidden md:block text-lg font-semibold tracking-tight mb-6 px-2">dazl<span className="text-[#111]">.</span></Link>
        {NAV.map(n => (
          <Link key={n.href} href={n.href}
            className="text-sm px-3 py-2 rounded-lg text-[#555] hover:text-[#111] hover:bg-black/5 transition">
            {n.label}
          </Link>
        ))}
        <div className="hidden md:block flex-1" />
        <form action="/api/auth/signout" method="POST"><button className="text-xs text-[#666] hover:text-[#111] px-3 py-2 transition">Sign out</button></form>
      </aside>
      <main className="flex-1 min-w-0 overflow-auto">
        <Suspense fallback={null}>
          <AuthGate>{children}</AuthGate>
        </Suspense>
      </main>
    </div>
  )
}
