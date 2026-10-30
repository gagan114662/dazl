// Text TinyFish ALREADY returned for a cited page, kept for one scan attempt so the verifier can use it when dazl's own fetch of
// that exact page is blocked (design: docs/design/blocked-source-verification.md). It never fetches anything, never substitutes a
// search snippet, model summary or cache from another attempt, and never touches login-walled hosts.
import { createHash } from 'node:crypto'
import { isLoginWalled } from '../search/tinyfish.ts'

import { COPY_ORIGIN, canonicalUrl } from './evidence-origin.ts'
export { COPY_ORIGIN }
// A copy shorter than this is an error page, a stub or a consent notice, not an article.
export const MIN_COPY_CHARS = 400
// A used copy is stored whole (scan/evidence-copies.ts); anything larger is not used rather than stored cut.
export const MAX_COPY_BYTES = 256 * 1024
// Own-fetch failures a copy may answer. login_required is deliberately absent: those pages are walled, not merely blocked.
export const COPY_FAILURES = ['blocked_by_site', 'needs_javascript'] as const

export interface HeldPage { url: string; title: string; text: string; sha256: string; heldAt: number }

export { canonicalUrl }

// Login, consent, bot-check and JavaScript-required notices. A real article that merely mentions "sign in" is long and is
// still held to the verbatim-quote rule; this refuses the pages whose BODY is the notice.
const WALL = /\b(log ?in to (?:continue|view|see)|sign ?in to (?:continue|view|see)|you must (?:log|sign) ?in|create an account to (?:continue|view|see)|enable javascript|javascript is (?:disabled|required)|verify (?:that )?you are (?:a )?human|are you a robot|captcha|access denied|403 forbidden|please accept (?:all )?cookies|we use cookies|cookie (?:consent|settings)|attention required|just a moment)\b/i
export function looksLikeWall(text: string): boolean {
  const head = text.slice(0, 1500)
  if (!WALL.test(head)) return false
  // A wall notice dominates a short page; on a long page a cookie banner at the top is common and is not the content.
  return text.length < 2500 || /\b(log ?in|sign ?in)\b[^.]{0,40}\b(continue|view|see)\b/i.test(head.slice(0, 400))
}

// A copy that ends on a truncation marker (or mid-word after a long body) may have lost the end of the page; a quote found
// in it is real, but absence checks (closed posting, rival named) cannot be run on text that may be cut, so it is not used.
export function looksTruncated(text: string): boolean {
  const tail = text.trimEnd().slice(-60)
  return /(…|\.\.\.|\[(?:truncated|\.\.\.)\]|\(truncated\)|read more|see more|continue reading|show more)\s*$/i.test(tail)
}

export type CopyRefusal = 'walled_host' | 'no_copy' | 'wrong_attempt' | 'too_short' | 'wall_text' | 'truncated' | 'too_large' | 'failure_not_eligible'

// Sealed once per scan attempt. The map is built here and frozen; callers get copies of the entries, never the map.
export class HeldText {
  readonly attempt: string
  private readonly pages: ReadonlyMap<string, HeldPage>
  private constructor(attempt: string, pages: Map<string, HeldPage>) { this.attempt = attempt; this.pages = pages; Object.freeze(this) }

  // `requested` are the exact URLs dazl asked TinyFish to fetch in this attempt; a returned page is held only when its URL
  // is, canonically, one of them. A page TinyFish reports under a different URL (a redirect target) is not held.
  static seal(attempt: string, requested: string[], returned: { url: string; title: string; text: string }[], heldAt = Math.floor(Date.now() / 1000)): HeldText {
    const want = new Set(requested.map(canonicalUrl).filter((x): x is string => !!x))
    const m = new Map<string, HeldPage>()
    for (const p of returned) {
      const k = canonicalUrl(p.url)
      if (!k || !want.has(k) || m.has(k) || typeof p.text !== 'string') continue
      m.set(k, Object.freeze({ url: p.url, title: typeof p.title === 'string' ? p.title : '', text: p.text, sha256: createHash('sha256').update(p.text).digest('hex'), heldAt }))
    }
    return new HeldText(attempt, m)
  }
  get size(): number { return this.pages.size }

  // The copy for exactly this cited URL, for this attempt, or the reason there is none.
  copyFor(attempt: string, citedUrl: string, ownFailure: string): { ok: true; page: HeldPage } | { ok: false; refusal: CopyRefusal } {
    if (!(COPY_FAILURES as readonly string[]).includes(ownFailure)) return { ok: false, refusal: 'failure_not_eligible' }
    if (attempt !== this.attempt) return { ok: false, refusal: 'wrong_attempt' }
    if (isLoginWalled(citedUrl)) return { ok: false, refusal: 'walled_host' }
    const k = canonicalUrl(citedUrl)
    const p = k ? this.pages.get(k) : undefined
    if (!p) return { ok: false, refusal: 'no_copy' }
    if (isLoginWalled(p.url)) return { ok: false, refusal: 'walled_host' }
    if (Buffer.byteLength(p.text) > MAX_COPY_BYTES) return { ok: false, refusal: 'too_large' }
    if (p.text.replace(/\s+/g, ' ').trim().length < MIN_COPY_CHARS) return { ok: false, refusal: 'too_short' }
    if (looksLikeWall(p.text)) return { ok: false, refusal: 'wall_text' }
    if (looksTruncated(p.text)) return { ok: false, refusal: 'truncated' }
    return { ok: true, page: p }
  }
}
