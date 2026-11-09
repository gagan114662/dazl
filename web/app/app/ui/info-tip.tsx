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
  // screen edge (a phone) it would run off the viewport; shift it back inside whenever it opens. The bound that
  // actually clips is NOT the viewport: every clipping ancestor clips (each /app page's <main> is overflow-auto,
  // and nested containers clip too), so the bound is the INTERSECTION of the viewport and all clipping ancestors
  // (#1010). When the text cannot fit the bound at any placement, the box is capped to the bound and scrolls
  // INSIDE the tooltip - capped-and-reachable, never cut off. Placement re-runs on open, on resize, and on any
  // ancestor scroll while open (scroll does not bubble: capture listener).
  useEffect(() => {
    if (!open || !tip.current) return
    const el = tip.current
    const place = () => {
      // The bound comes from the ANCESTORS first, before any tooltip style changes: this runs from a
      // capture-phase scroll listener, so it also fires on the tooltip's OWN scrolls - resetting
      // maxHeight/overflowY here (then forcing layout via rect reads) clamps the reader's scrollTop to 0,
      // and End/wheel would scroll and snap straight back (#1011). The cap is only ever SET, never reset.
      let l = 0, t = 0, r = window.innerWidth, bo = window.innerHeight
      for (let a = el.parentElement; a; a = a.parentElement) {
        const o = getComputedStyle(a)
        if (!/(auto|scroll|hidden|clip)/.test(`${o.overflow} ${o.overflowX} ${o.overflowY}`)) continue
        const ab = a.getBoundingClientRect()
        l = Math.max(l, ab.left); t = Math.max(t, ab.top); r = Math.min(r, ab.right); bo = Math.min(bo, ab.bottom)
      }
      const margin = 8
      l += margin; t += margin; r -= margin; bo -= margin
      // Clear only scroll-neutral styles (position/transform) to measure the natural below position; the cap
      // stays on through the measurement, exactly as the reader sees it.
      el.style.transform = ''
      el.style.top = ''
      el.style.bottom = ''
      // Oversized against the bound: cap the box to the bound and let the text scroll inside the tooltip.
      const mw = `${Math.max(1, r - l)}px`
      const mh = `${Math.max(1, bo - t)}px`
      if (el.style.maxWidth !== mw) el.style.maxWidth = mw
      if (el.style.maxHeight !== mh) el.style.maxHeight = mh
      if (el.style.overflowY !== 'auto') el.style.overflowY = 'auto'
      let b = el.getBoundingClientRect()
      const over = b.right - r
      const under = l - b.left
      const dx = over > 0 ? -over : under > 0 ? under : 0
      // Vertical: below by default. When below overflows the bound, flip above the BUTTON's live box, not the
      // wrapper's - the wrapper box matches only the button's VISIBLE circle (the 44px hit area has its vertical
      // margins pulled in .825rem at >=1024px, #672), so a wrapper-anchored flip overlaps the hit box (#1011).
      // Keep the flip only when the WHOLE flipped box lands inside the bound on both axes: the anchor itself can
      // sit outside the bound (scrolled off), and a flip that follows it off-screen is no placement (CI: flipped
      // bottom 861 on a 400px viewport with the anchor at y~868). Whatever is chosen, a bounded clamp shifts the
      // FINAL box back inside the bound - never clipped, never off-screen, anchored or not (#1010).
      let dy = 0
      if (b.bottom > bo) {
        const wrap = el.parentElement?.getBoundingClientRect()
        const btn = el.parentElement?.querySelector('button')?.getBoundingClientRect()
        if (wrap && btn) {
          const gap = 0.45 * parseFloat(getComputedStyle(document.documentElement).fontSize)
          el.style.top = 'auto'
          el.style.bottom = `${wrap.bottom - btn.top + gap}px`
          b = el.getBoundingClientRect()
          if (b.top < t || b.bottom > bo) { el.style.top = ''; el.style.bottom = ''; b = el.getBoundingClientRect() }
        }
        if (b.bottom > bo) dy = -(b.bottom - bo) // no fitting placement: nudge up exactly into the bound
      }
      if (b.top + dy < t) dy = t - b.top // the anchor can also sit above the bound: never place above it
      el.style.transform = `translateX(calc(-50% + ${dx}px))${dy ? ` translateY(${dy}px)` : ''}`
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])
  // Focus is a WRAPPER concern, not a button concern: a capped tooltip is itself scrollable and Chromium tabs into
  // it - a button-level onBlur would set open=false while :focus-within still shows the text, leaving state,
  // placement listeners and the visible tip inconsistent, and no Escape from inside (#1010). The tip is open
  // (state, effect and listeners) while focus is anywhere inside; it closes when focus leaves the whole infotip.
  // Escape closes from EITHER element and blurs out of the wrapper, so state, aria-expanded and the visible box
  // agree (a pointer still hovering keeps its own :hover display - pointer intent wins, as before).
  return (
    <span className="infotip ml-1" data-open={open ? 'true' : 'false'} data-testid="infotip"
      onMouseEnter={() => setOpen(true)}
      // Pointer leave must not close state while FOCUS is inside: CSS :focus-within would keep showing the text
      // while aria-expanded/data-open say closed - the same state/display lie through the pointer path (#1010).
      onMouseLeave={e => { const a = document.activeElement; if (!(a instanceof Node) || !e.currentTarget.contains(a)) setOpen(false) }}
      onFocus={() => setOpen(true)}
      onBlur={e => { const to = e.relatedTarget; if (!(to instanceof Node) || !e.currentTarget.contains(to)) setOpen(false) }}
      onKeyDown={e => { if (e.key === 'Escape') { setOpen(false); if (e.target instanceof HTMLElement) e.target.blur() } }}>
      <button type="button" aria-label={label} aria-describedby={id} aria-expanded={open} onClick={() => setOpen(o => !o)}>i</button>
      <span role="tooltip" id={id} data-testid="infotip-text" ref={tip}>{children}</span>
    </span>
  )
}
