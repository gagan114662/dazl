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
  { href: '/app/settings', label: 'Settings' },
]

async function AuthGate({ children }: { children: React.ReactNode }) {
  const token = (await cookies()).get('dazl_session')?.value
  if (!getSessionUser(token)) redirect('/sign-in')
  return <>{children}</>
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen glow">
      <aside className="w-56 shrink-0 border-r border-white/10 bg-black/20 backdrop-blur flex flex-col py-6 px-4 gap-1">
        <Link href="/app" className="text-lg font-bold tracking-tight mb-6 px-2">dazl<span className="text-indigo-400">.</span></Link>
        {NAV.map(n => (
          <Link key={n.href} href={n.href}
            className="text-sm px-3 py-2 rounded-lg text-gray-400 hover:text-white hover:bg-indigo-500/10 transition">
            {n.label}
          </Link>
        ))}
        <div className="flex-1" />
        <form action="/api/auth/signout" method="POST"><button className="text-xs text-gray-500 hover:text-gray-300 px-3 py-2 transition">Sign out</button></form>
      </aside>
      <main className="flex-1 overflow-auto">
        <Suspense fallback={null}>
          <AuthGate>{children}</AuthGate>
        </Suspense>
      </main>
    </div>
  )
}
