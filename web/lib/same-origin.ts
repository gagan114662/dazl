import type { NextRequest } from 'next/server'

// Defense in depth on cookie-authenticated writes: require JSON and, when the
// browser sends Origin, that it matches this host.
export function sameOriginJson(req: NextRequest): boolean {
  if (!(req.headers.get('content-type') || '').includes('application/json')) return false
  const origin = req.headers.get('origin')
  return !origin || new URL(origin).host === req.headers.get('host')
}
