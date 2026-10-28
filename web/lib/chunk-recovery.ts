// Bounded recovery from JavaScript/CSS chunks that cannot be loaded (for example a tab from an older deploy, or a page
// whose chunk is missing on the server). Installed as an inline <head> script by the root layout, so it is already
// listening while the page's own chunks load: a failed <script> fires a non-bubbling error that only a capture-phase
// listener sees, and if a page chunk is missing React may never hydrate, so a React effect would never run.
//
// Policy: at most ONE automatic reload per build in this browser tab. The guard key is the build ID, written to
// sessionStorage (and read back) before reloading; nothing clears it - no timer, no clean-load reset. After that one
// reload, or when the guard cannot be stored, or when the user has typed on the page, a plain "dazl was updated"
// notice with a Reload button is shown instead. A reload is a GET of the current page: it never resubmits a send, scan,
// draft or other write, which only happen on an explicit button press.
//
// The function must stay self-contained (no imports, no outer references): the layout serializes it with toString().
/* eslint-disable @typescript-eslint/no-explicit-any */
export function installChunkRecovery(w: any, buildId: string): void {
  const CHUNK = /ChunkLoadError|Loading chunk [^ ]+ failed|Failed to load chunk|Loading CSS chunk/i
  const key = 'dazl-chunk-reload:' + (buildId || 'unknown')
  let typed = false
  let done = false
  function notify() {
    if (done) return
    done = true
    const show = () => {
      const d = w.document
      const box = d.createElement('div')
      box.setAttribute('role', 'alert')
      box.setAttribute('style', 'position:fixed;left:16px;right:16px;bottom:16px;max-width:420px;margin-left:auto;z-index:2147483647;background:#fff;color:#111;border:1px solid #111;padding:16px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.15)')
      const title = d.createElement('p'); title.setAttribute('style', 'margin:0;font-weight:600'); title.textContent = 'dazl was updated'
      const body = d.createElement('p'); body.setAttribute('style', 'margin:4px 0 12px;color:#555'); body.textContent = 'Part of this page could not load. Copy anything you typed, then reload to get the current version.'
      const btn = d.createElement('button'); btn.type = 'button'; btn.textContent = 'Reload'
      btn.setAttribute('style', 'background:#111;color:#fff;border:0;padding:8px 14px;font:inherit;cursor:pointer')
      btn.addEventListener('click', () => w.location.reload())
      box.appendChild(title); box.appendChild(body); box.appendChild(btn); d.body.appendChild(box)
    }
    if (w.document.body) show(); else w.document.addEventListener('DOMContentLoaded', show)
  }
  function recover() {
    if (done) return
    if (typed) return notify()
    try {
      const s = w.sessionStorage
      if (!s || s.getItem(key)) return notify()
      s.setItem(key, JSON.stringify({ path: w.location.pathname, at: Date.now() }))
      if (!s.getItem(key)) return notify() // storage that drops writes must not allow a reload loop
    } catch {
      return notify()
    }
    done = true
    w.location.reload()
  }
  const isChunk = (r: any) => !!r && CHUNK.test(String(r.name || '') + ' ' + String(r.message || (typeof r === 'string' ? r : '')))
  w.document.addEventListener('input', () => { typed = true }, true)
  w.addEventListener('error', (e: any) => {
    const t = e.target
    if (t && t !== w && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) {
      const url = String(t.src || t.href || '')
      // Own build assets only; a failed prefetch of another page is not this page breaking.
      if (url.indexOf('/_next/static/') !== -1 && /\.(js|css)(\?|$)/.test(url) && t.rel !== 'prefetch') recover()
      return
    }
    if (isChunk(e.error) || isChunk(e.message)) recover()
  }, true)
  w.addEventListener('unhandledrejection', (e: any) => { if (isChunk(e.reason)) recover() })
}

// The same test as the inline script's, for React error boundaries (app/app/error.tsx). Kept separate because the
// installed function must stay self-contained.
export function isChunkLoadError(e: unknown): boolean {
  const r = e as { name?: unknown; message?: unknown } | null | undefined
  return !!r && /ChunkLoadError|Loading chunk [^ ]+ failed|Failed to load chunk|Loading CSS chunk/i.test(`${String(r.name ?? '')} ${String(r.message ?? (typeof e === 'string' ? e : ''))}`)
}

export const chunkRecoveryScript = (buildId: string) => `(${installChunkRecovery.toString()})(window, ${JSON.stringify(buildId)});`
