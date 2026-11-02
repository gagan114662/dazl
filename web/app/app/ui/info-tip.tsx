'use client'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

// The (i) next to a short line: every caveat and factual limit lives here, word for word. It opens on hover, keyboard
// focus or click (touch), and the text stays in the page for screen readers (aria-describedby). The id is React's
// useId (tree-position based): identical on the server and the client, so hydration never mismatches. A module-level
// counter is NOT safe here - the server shares it across requests, so server markup carries inflated ids and every
// authed page with a tooltip fails hydration (React #418) and re-renders client-side.
export default function InfoTip({ children, label = 'More information' }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const tip = useRef<HTMLSpanElement>(null)
  // The full text is often a disclosure: it must never be clipped. The tooltip is centered under the (i), so near a
  // screen edge (a phone) it would run off the viewport; shift it back inside whenever it opens.
  useEffect(() => {
    if (!open || !tip.current) return
    const el = tip.current
    el.style.transform = ''
    const r = el.getBoundingClientRect()
    const margin = 8
    const over = r.right - (window.innerWidth - margin)
    const under = margin - r.left
    const dx = over > 0 ? -over : under > 0 ? under : 0
    if (dx) el.style.transform = `translateX(calc(-50% + ${dx}px))`
  }, [open])
  return (
    <span className="infotip ml-1" data-open={open ? 'true' : 'false'} data-testid="infotip" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-label={label} aria-describedby={id} aria-expanded={open} onClick={() => setOpen(o => !o)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}>i</button>
      <span role="tooltip" id={id} data-testid="infotip-text" ref={tip}>{children}</span>
    </span>
  )
}
