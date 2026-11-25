'use client'
// #1705 follow-up (Quest review on PR #1751, 2026-11-25): the mobile menu as a small client component so
// the panel closes after a link tap on every render. A page-level inline script never executes when the
// landing page is reached through a client-side transition (reproduced rendered); this component hydrates
// on those visits too. Closes on the tap itself (the menu links are hash links, which do not change the
// pathname) and on any real route change while the panel is open (usePathname effect, per Quest).
import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'

export default function LandingMenu() {
  const ref = useRef<HTMLDetailsElement>(null)
  const pathname = usePathname()
  useEffect(() => { if (ref.current) ref.current.open = false }, [pathname])
  const close = () => { if (ref.current) ref.current.open = false }
  return (
    <details ref={ref} className="md:hidden static" data-testid="mobile-nav">
      <summary className="btn-ghost btn-sm list-none [&::-webkit-details-marker]:hidden cursor-pointer select-none">Menu</summary>
      <div className="absolute left-4 right-4 top-full mt-1 lp-card p-4 flex flex-col gap-3 text-sm font-medium z-20 shadow-lg">
        <a href="#how" onClick={close} className="lp-navlink hover:opacity-70">How it works</a>
        <a href="#pricing" onClick={close} className="lp-navlink hover:opacity-70">Pricing</a>
      </div>
    </details>
  )
}
