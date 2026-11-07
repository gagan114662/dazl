'use client'
import { useEffect } from 'react'
import { shouldRestoreMainFocus } from '@/lib/main-focus'

// #673: keeps keyboard focus on the /app layout's <main> (the skip link target) once the "Skip to content" link (or anything
// inside <main>) had it. Focus otherwise falls back to BODY when React swaps the focused node: a loading view
// replaced by the loaded page (Inbox), or a hydration pass that re-creates the subtree. A keyboard user would then
// restart from the top of the document. Only a REMOVED focused node counts: a deliberate blur, a click on empty
// space (pointer press) or Tab past the last control leave the node in place, and focus is not pulled back.

export default function MainFocus() {
  useEffect(() => {
    const main = () => document.getElementById('main')
    const inMain = (n: EventTarget | null): n is Element => n instanceof Element && !!n.closest('#main')
    let last: Element | null = inMain(document.activeElement) ? document.activeElement : null
    let pointerSince = false
    const restore = () => {
      if (!shouldRestoreMainFocus(document.activeElement, document.body, last, pointerSince)) return
      const m = main()
      if (m && document.activeElement !== m) { m.focus({ preventScroll: true }); last = m }
    }
    // The skip link was used before this effect ran (before hydration) and the hydrated <main> lost it.
    if (location.hash === '#main' && (document.activeElement === document.body || document.activeElement === null)) { const m = main(); if (m) m.focus({ preventScroll: true }); last = m }
    const onFocusIn = (e: FocusEvent) => { last = inMain(e.target) ? e.target : null; pointerSince = false }
    const onPointer = () => { pointerSince = true }
    // Enter on the skip link: fragment navigation focuses <main> natively (tabIndex -1); make sure it stuck.
    const onClick = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('a.skip-link')) return
      requestAnimationFrame(() => { const m = main(); if (m && document.activeElement !== m) m.focus(); last = m; pointerSince = false })
    }
    const mo = new MutationObserver(restore)
    mo.observe(document.body, { childList: true, subtree: true })
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('click', onClick)
    return () => {
      mo.disconnect()
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('click', onClick)
    }
  }, [])
  return null
}
