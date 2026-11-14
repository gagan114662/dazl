import type { NextRequest } from 'next/server'

// Defense in depth on cookie-authenticated writes: require JSON and, when the
// browser sends Origin, that it matches this host.
export function sameOriginJson(req: NextRequest): boolean {
  if (!(req.headers.get('content-type') || '').includes('application/json')) return false
  const origin = req.headers.get('origin')
  if (!origin) return true
  // an unparseable Origin (e.g. 'null' from a sandboxed frame or a cross-origin redirect) is not this host
  try { return new URL(origin).host === req.headers.get('host') } catch { return false }
}

// A native HTML form post (application/x-www-form-urlencoded) to a route that also takes JSON: the page's own form before
// or without hydration (#1116). Browsers always send Origin on a form POST, so here it is REQUIRED and must be this host:
// a cross-site form (login CSRF, #1095) or a request with no Origin is refused.
export function sameOriginForm(req: NextRequest): boolean {
  if (!(req.headers.get('content-type') || '').includes('application/x-www-form-urlencoded')) return false
  const origin = req.headers.get('origin')
  if (!origin) return false
  try { return new URL(origin).host === req.headers.get('host') } catch { return false }
}
