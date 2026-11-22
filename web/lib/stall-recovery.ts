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
  sessionStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void }
  location: { reload(): void }
  document: { getElementById(id: string): El | null; createElement(tag: string): El }
}
export function installStallWatch(w: StallWindow, id: string, stallMs: number, windowMs: number): void {
  const key = 'dazl-stall-reload'
  // the client watch (app/app/stall-watch.tsx) leaves a server-parsed fallback to this script
  try { w.document.getElementById(id)?.setAttribute('data-watched', '1') } catch { /* never throws */ }
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
