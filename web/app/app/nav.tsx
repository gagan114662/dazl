'use client'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Icon, type IconName } from './ui/icons'

// The app's sidebar: Home, then Find (Plays, Leads) and Engage (Campaigns, Outreach, Inbox), with the less-used pages
// under More and Settings at the bottom. Outreach stays in Engage: it is where drafts are approved and sent.
type Item = { href: string; label: string; icon: IconName; match: (p: string, q: URLSearchParams) => boolean }
const HOME: Item = { href: '/app', label: 'Home', icon: 'home', match: p => p === '/app' }
const GROUPS: { title: string; items: Item[] }[] = [
  { title: 'Find', items: [
    // Plays = saved, repeating searches and their schedules; Leads = searching and every run's results.
    { href: '/app/plays', label: 'Plays', icon: 'plays', match: p => p.startsWith('/app/plays') },
    { href: '/app/leads?latest=1', label: 'Leads', icon: 'leads', match: p => p === '/app/leads' },
  ] },
  { title: 'Engage', items: [
    { href: '/app/outcomes', label: 'Outcomes', icon: 'check', match: p => p.startsWith('/app/outcomes') },
    { href: '/app/campaigns', label: 'Campaigns', icon: 'campaigns', match: p => p.startsWith('/app/campaigns') },
    { href: '/app/outreach', label: 'Outreach', icon: 'outreach', match: p => p.startsWith('/app/outreach') },
    { href: '/app/inbox', label: 'Inbox', icon: 'inbox', match: p => p.startsWith('/app/inbox') },
  ] },
]
const MORE: Item[] = [
  { href: '/app/follow-ups', label: 'Follow-ups', icon: 'followups', match: p => p.startsWith('/app/follow-ups') },
  { href: '/app/social', label: 'Social opportunities', icon: 'social', match: p => p.startsWith('/app/social') },
  { href: '/app/seo', label: 'SEO', icon: 'seo', match: p => p.startsWith('/app/seo') },
]
const SETTINGS: Item = { href: '/app/settings', label: 'Settings', icon: 'settings', match: p => p.startsWith('/app/settings') }

function NavLink({ item, p, q }: { item: Item; p: string; q: URLSearchParams }) {
  const on = item.match(p, q)
  return (
    <Link href={item.href} aria-current={on ? 'page' : undefined}
      className={`flex items-center gap-2.5 text-sm px-3 py-2 rounded-xl transition ${on ? 'bg-[var(--soft)] text-[var(--ink)] font-semibold' : 'text-[var(--ink-2)] hover:text-[var(--ink)] hover:bg-black/5'}`}>
      <Icon name={item.icon} className="w-[18px] h-[18px] shrink-0" />{item.label}
    </Link>
  )
}

export default function Nav() {
  const p = usePathname() ?? ''
  const q = useSearchParams() ?? new URLSearchParams()
  const moreOn = MORE.some(i => i.match(p, q))
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      <NavLink item={HOME} p={p} q={q} />
      {GROUPS.map(g => (
        <div key={g.title} className="mt-4">
          <p className="px-3 mb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--ink-3)]">{g.title}</p>
          {g.items.map(i => <NavLink key={i.href} item={i} p={p} q={q} />)}
        </div>
      ))}
      <details className="mt-4 group" open={moreOn}>
        <summary className="list-none cursor-pointer flex items-center gap-2.5 text-sm px-3 py-2 rounded-xl text-[var(--ink-2)] hover:bg-black/5 [&::-webkit-details-marker]:hidden">
          <Icon name="more" className="w-[18px] h-[18px]" />More
        </summary>
        <div className="flex flex-col gap-0.5 mt-0.5">{MORE.map(i => <NavLink key={i.href} item={i} p={p} q={q} />)}</div>
      </details>
      <div className="mt-4"><NavLink item={SETTINGS} p={p} q={q} /></div>
    </nav>
  )
}
