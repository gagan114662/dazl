// Pure strings (no Node imports): bundled into the leads page and used by the API and CSV.
export const COPY_ORIGIN = 'tinyfish_copy' as const

// What the user, the API and the CSV say about a lead verified from a copy. Never "read on the page by dazl".
export function evidenceOriginLabel(origin: string | null | undefined, ownFailure: string | null | undefined): string {
  if (origin !== COPY_ORIGIN) return ''
  return `Checked against a copy of the page fetched by TinyFish. dazl's own fetch of the page failed (${ownFailure || 'unknown'}), so dazl did not read the page directly.`
}

// URL identity for matching. Scheme and host are case-insensitive, default ports and the fragment do not name a different
// page, one trailing slash on a non-root path is the same page. EVERYTHING ELSE is significant, including the query string
// (an aggregator's id parameter picks the page) and www. versus bare host: no alias, no tracking-parameter stripping, no redirect
// following. Returns null for anything that is not a plain http(s) URL.
export function canonicalUrl(raw: string): string | null {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (u.username || u.password) return null
    u.hash = ''
    let path = u.pathname
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`
  } catch { return null }
}

const UNREAD = new Set(['blocked_by_site', 'needs_javascript', 'login_required'])
// The CSV "Evidence Origin" cell. It only ever states what is recorded: a verified copy, a candidate dazl could not read, or a
// lead YOU confirmed after dazl could not read it. A row with nothing recorded is blank, and blank claims nothing (it does not
// mean dazl read the page).
export function exportEvidenceOrigin(r: { evidence_origin?: string | null; own_fetch_failure?: string | null; review_reason?: string | null; human_confirmed_from?: string | null }): string {
  if (r.evidence_origin === COPY_ORIGIN) return evidenceOriginLabel(r.evidence_origin, r.own_fetch_failure)
  if (r.review_reason && UNREAD.has(r.review_reason)) return `Not verified: dazl could not read this page (${r.review_reason}); its quote was not checked against any page text.`
  if (r.human_confirmed_from && UNREAD.has(r.human_confirmed_from)) return `Confirmed by you, not verified by dazl: dazl could not read this page (${r.human_confirmed_from}); its quote was not checked against any page text.`
  return ''
}
