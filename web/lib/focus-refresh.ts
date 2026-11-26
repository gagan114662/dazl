// #1876: one window focus on /app fired the same Home reads four times, because each Home panel attached its own `focus`
// and `visibilitychange` listener. One shared, debounced listener now fans out a single refresh per return to the tab,
// however many panels subscribe. Refetch-on-focus is kept; only the duplication and the event pair go.

type Target = {
  addEventListener: (type: string, fn: () => void) => void
  removeEventListener: (type: string, fn: () => void) => void
}

export interface FocusRefreshDeps {
  window?: Target
  document?: Target & { hidden: boolean }
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (h: unknown) => void
  delayMs?: number
}

const subscribers = new Set<() => void>()
let shared: { win: Target; doc: Target & { hidden: boolean }; clearTimeout: (h: unknown) => void; timer: unknown; onWake: () => void } | null = null

export function subscribeFocusRefresh(fn: () => void, deps: FocusRefreshDeps = {}): () => void {
  subscribers.add(fn)
  if (!shared) {
    const win = deps.window ?? (window as unknown as Target)
    const doc = deps.document ?? (document as unknown as Target & { hidden: boolean })
    const setT = deps.setTimeout ?? ((f: () => void, ms: number) => setTimeout(f, ms))
    const clearT = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
    const delayMs = deps.delayMs ?? 250
    const s = { win, doc, clearTimeout: clearT, timer: null as unknown, onWake: () => {} }
    s.onWake = () => {
      if (doc.hidden) return
      if (s.timer !== null) return // the focus and its visibilitychange are one return to the tab
      s.timer = setT(() => { s.timer = null; for (const f of [...subscribers]) f() }, delayMs)
    }
    win.addEventListener('focus', s.onWake)
    doc.addEventListener('visibilitychange', s.onWake)
    shared = s
  }
  return () => {
    subscribers.delete(fn)
    if (subscribers.size > 0 || !shared) return
    const s = shared
    s.win.removeEventListener('focus', s.onWake)
    s.doc.removeEventListener('visibilitychange', s.onWake)
    if (s.timer !== null) s.clearTimeout(s.timer)
    shared = null
  }
}
