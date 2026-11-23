// #1463: if the /app layout's streamed content never arrives (a response cut by a restart, a held proxy stream, an old
// tab against a new build), the Suspense fallback "Opening your workspace…" stayed up silently. This inline script
// ships INSIDE that fallback, so it runs as soon as the shell parses, with no React or chunk needed. If the fallback is
// still on the page after STALL_MS, it reloads the tab once; a second stall within RELOAD_WINDOW_MS in the same tab
// shows a visible notice with a Reload button instead, so it can never loop. A reload is a GET of the current page.
// Self-contained (serialized with toString()): no imports, no outer references.
export const STALL_MS = 12000
export const RELOAD_WINDOW_MS = 120000
export const OPENING_ID = 'workspace-opening'
type El = { type?: string; textContent: string | null; setAttribute(k: string, v: string): void; addEventListener(n: string, f: () => void): void; appendChild(c: unknown): unknown }
export type StallWindow = {
  setTimeout(f: () => void, ms: number): unknown
  clearTimeout?(t: unknown): void
  performance?: { now(): number }
  requestAnimationFrame?: ((cb: (now: number) => void) => number) & { dazlHidden?: boolean }
  cancelAnimationFrame?(id: number): void
  sessionStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void }
  location: { reload(): void }
  document: { visibilityState?: string; getElementById(id: string): El | null; createElement(tag: string): El }
}
export function installStallWatch(w: StallWindow, id: string, stallMs: number, windowMs: number): void {
  const key = 'dazl-stall-reload'
  // the client watch (app/app/stall-watch.tsx) leaves a server-parsed fallback to this script
  try { w.document.getElementById(id)?.setAttribute('data-watched', '1') } catch { /* never throws */ }
  // A tab that is not visible (a background tab, a minimized or covered window, a tab driven without being shown) is given no
  // animation frames. React's streamed-page script reveals the first Suspense boundary in requestAnimationFrame and retries its
  // hydration the same way, so there the page that has fully arrived stayed behind this fallback: nothing hydrated, no data request
  // was made, and the timer below reloaded and then blamed a healthy server - again after every reload, until the tab was looked at.
  // This script runs before the page streams in. While the tab is hidden, a frame callback runs from a timer instead; in a visible
  // tab frames are the browser's own, untouched. Ids handed out here are negative, so cancelling one never reaches the browser's.
  try {
    const raf = w.requestAnimationFrame, caf = w.cancelAnimationFrame
    if (typeof raf === 'function' && !raf.dazlHidden) {
      const held: Record<number, unknown> = {}
      let n = 0
      const frames = (cb: (now: number) => void): number => {
        if (w.document.visibilityState !== 'hidden') return raf.call(w, cb)
        const fid = -(++n)
        held[fid] = w.setTimeout(() => { delete held[fid]; cb(w.performance ? w.performance.now() : Date.now()) }, 0)
        return fid
      }
      frames.dazlHidden = true
      w.requestAnimationFrame = frames
      w.cancelAnimationFrame = (fid: number) => {
        if (fid in held) { if (w.clearTimeout) w.clearTimeout(held[fid]); delete held[fid] } else if (typeof caf === 'function') caf.call(w, fid)
      }
    }
  } catch { /* never throws */ }
  w.setTimeout(() => {
    const d = w.document
    const el = d.getElementById(id)
    if (!el) return
    let ok = true, recent = false
    try { const raw = w.sessionStorage.getItem(key); recent = raw !== null && Date.now() - Number(raw) < windowMs } catch { ok = false }
    if (ok && !recent) {
      // storage that drops writes must not allow a reload loop
      try { w.sessionStorage.setItem(key, String(Date.now())); ok = w.sessionStorage.getItem(key) !== null } catch { ok = false }
      if (ok) { w.location.reload(); return }
    }
    const p = d.createElement('p'); p.textContent = 'This is taking too long. '
    const b = d.createElement('button'); b.type = 'button'; b.textContent = 'Reload'
    b.setAttribute('class', 'btn-primary text-xs px-3 py-1.5')
    b.addEventListener('click', () => w.location.reload())
    p.appendChild(b); el.appendChild(p)
    el.setAttribute('data-stalled', '1')
  }, stallMs)
}
export const stallWatchScript = () => `(${installStallWatch.toString()})(window, ${JSON.stringify(OPENING_ID)}, ${STALL_MS}, ${RELOAD_WINDOW_MS});`
