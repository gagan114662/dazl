// #1876: one window focus on /app fired the same Home reads four times, because each Home panel attached its own `focus`
// and `visibilitychange` listener. One shared, debounced listener now fans out a single refresh per return to the tab,
// however many panels subscribe. Refetch-on-focus is kept; only the duplication and the event pair go.
// #1880: the fan-out hands each subscriber one epoch number and what woke it. The first subscriber's read starts, the
// rest join it, so a focus or a save is one read per endpoint, not one per panel; the kind says whether the site form
// (which a save just changed) has to be reseeded from the new read.

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

export type RefreshKind = 'focus' | 'saved'
const subscribers = new Set<(epoch: number, kind: RefreshKind) => void>()
let epoch = 0
let shared: { win: Target; doc: Target & { hidden: boolean }; clearTimeout: (h: unknown) => void; timer: unknown; onWake: () => void; onSaved: () => void; pending: RefreshKind | null } | null = null

export function subscribeFocusRefresh(fn: (epoch: number, kind: RefreshKind) => void, deps: FocusRefreshDeps = {}): () => void {
  subscribers.add(fn)
  if (!shared) {
    const win = deps.window ?? (window as unknown as Target)
    const doc = deps.document ?? (document as unknown as Target & { hidden: boolean })
    const setT = deps.setTimeout ?? ((f: () => void, ms: number) => setTimeout(f, ms))
    const clearT = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
    const delayMs = deps.delayMs ?? 250
    const s = { win, doc, clearTimeout: clearT, timer: null as unknown, onWake: () => {}, onSaved: () => {}, pending: null as RefreshKind | null }
    const fire = () => {
      s.timer = null
      const e = ++epoch
      const kind: RefreshKind = s.pending ?? 'focus'
      s.pending = null
      for (const f of [...subscribers]) f(e, kind)
    }
    const schedule = (kind: RefreshKind) => {
      // a save inside the debounce window is stronger than the focus that preceded it: the form must reseed
      if (kind === 'saved' || s.pending === null) s.pending = kind
      if (s.timer === null) s.timer = setT(fire, delayMs)
    }
    s.onWake = () => { if (!doc.hidden) schedule('focus') } // the focus and its visibilitychange are one return to the tab
    s.onSaved = () => schedule('saved') // a profile save is one event for every panel, so it is one read too (#1880)
    win.addEventListener('focus', s.onWake)
    doc.addEventListener('visibilitychange', s.onWake)
    win.addEventListener('profile-updated', s.onSaved)
    shared = s
  }
  return () => {
    subscribers.delete(fn)
    if (subscribers.size > 0 || !shared) return
    const s = shared
    s.win.removeEventListener('focus', s.onWake)
    s.doc.removeEventListener('visibilitychange', s.onWake)
    s.win.removeEventListener('profile-updated', s.onSaved)
    if (s.timer !== null) s.clearTimeout(s.timer)
    shared = null
  }
}
