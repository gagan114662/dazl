import Link from 'next/link'

const NAV = [
  { href: '/app', label: 'Home' },
  { href: '/app/leads', label: 'Leads' },
  { href: '/app/outreach', label: 'Outreach' },
  { href: '/app/follow-ups', label: 'Follow-ups' },
  { href: '/app/marketing', label: 'Marketing' },
  { href: '/app/settings', label: 'Settings' },
]

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-gray-950">
      <aside className="w-56 border-r border-white/10 flex flex-col py-6 px-4 gap-1">
        <Link href="/app" className="text-lg font-bold tracking-tight mb-6 px-2">dazl<span className="text-indigo-400">.</span></Link>
        {NAV.map(n => (
          <Link key={n.href} href={n.href}
            className="text-sm px-3 py-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition">
            {n.label}
          </Link>
        ))}
        <div className="flex-1" />
        <Link href="/app/settings" className="text-xs text-gray-600 hover:text-gray-400 px-3 py-2 transition">Settings</Link>
      </aside>
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  )
}
