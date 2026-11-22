'use client'
import { useEffect } from 'react'
import { OPENING_ID, STALL_MS, RELOAD_WINDOW_MS } from '@/lib/stall-recovery'

// #1463: the inline stall script only runs when the "Opening your workspace…" fallback arrives in server-parsed HTML. A client-side
// wait had no watch: the fallback rendered by React (its <script> is inert there), or a soft navigation whose RSC response never
// arrives (the old page stays, the click does nothing, the URL does not change). This watch is mounted once in the /app layout,
// outside the Suspense boundary, and follows the same rule as the inline script: one automatic recovery per tab per RELOAD_WINDOW_MS
// (shared sessionStorage key), then a visible Reload button, never a loop. Recovery is a plain GET of the page the user asked for.
const KEY = 'dazl-stall-reload'

function recover(target: string, into: HTMLElement | null) {
  let ok = true, recent = false
  try { const raw = sessionStorage.getItem(KEY); recent = raw !== null && Date.now() - Number(raw) < RELOAD_WINDOW_MS } catch { ok = false }
  if (ok && !recent) {
    try { sessionStorage.setItem(KEY, String(Date.now())); ok = sessionStorage.getItem(KEY) !== null } catch { ok = false }
    if (ok) { if (target === location.href) location.reload(); else location.assign(target); return }
  }
  if (document.querySelector('[data-stall-notice]')) return
  const box = document.createElement('div')
  box.setAttribute('role', 'alert'); box.setAttribute('data-stall-notice', '1')
  box.className = into ? 'mt-2 text-sm' : 'fixed bottom-4 right-4 z-50 rounded-lg border border-[var(--line)] bg-[var(--canvas)] p-3 text-sm shadow'
  box.append('This is taking too long. ')
  const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Reload'
  b.className = 'btn-primary text-xs px-3 py-1.5'
  b.addEventListener('click', () => { if (target === location.href) location.reload(); else location.assign(target) })
  box.appendChild(b)
  ;(into ?? document.body).appendChild(box)
}

export default function StallWatch() {
  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const later = (f: () => void) => { const t = setTimeout(() => { timers.delete(t); f() }, STALL_MS); timers.add(t) }
    // the fallback on screen after a client render
    // (one rendered by the server carries data-watched: the inline script already watches it)
    let openingTimer = false
    const opening = () => { openingTimer = false; const el = document.getElementById(OPENING_ID); if (el && !el.hasAttribute('data-stalled') && !el.hasAttribute('data-watched')) { el.setAttribute('data-stalled', '1'); recover(location.href, el) } }
    const check = () => { const el = document.getElementById(OPENING_ID); if (el && !openingTimer && !el.hasAttribute('data-watched')) { openingTimer = true; later(opening) } }
    check()
    const seen = new MutationObserver(check)
    seen.observe(document.body, { childList: true, subtree: true })
    // a same-origin link click whose navigation never commits: the URL is still the one the click started on
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = e.target instanceof Element ? e.target.closest('a[href]') as HTMLAnchorElement | null : null
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return
      let to: URL; try { to = new URL(a.href, location.href) } catch { return }
      if (to.origin !== location.origin) return
      const from = location.href
      if (to.href === from) return
      later(() => { if (location.href === from) recover(to.href, null) })
    }
    document.addEventListener('click', onClick)
    return () => { seen.disconnect(); document.removeEventListener('click', onClick); for (const t of timers) clearTimeout(t) }
  }, [])
  return null
}
