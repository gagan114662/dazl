import { NextRequest, NextResponse } from 'next/server'
import { logRequest, newRequestId, requestLogLine } from '@/lib/ops/request-log'

// Runs before /app pages and /api routes (Node runtime). Gives each request an id (lib/ops/request-log.ts), logs it
// as one JSON line, and keeps /app behind a session cookie (the pages check the session itself; this only redirects
// signed-out visitors early).
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const id = newRequestId() // never the caller's x-request-id
  // health probes run every few seconds: no log line for them, but they still get an id
  if (!pathname.startsWith('/api/health') && pathname !== '/api/ready') logRequest(requestLogLine(id, req.method, pathname))

  if (pathname.startsWith('/app') && !req.cookies.get('dazl_session')?.value) {
    const r = NextResponse.redirect(new URL('/sign-in', req.url))
    r.headers.set('x-request-id', id)
    return r
  }
  const headers = new Headers(req.headers)
  headers.set('x-request-id', id)
  const res = NextResponse.next({ request: { headers } })
  res.headers.set('x-request-id', id)
  return res
}

export const config = { matcher: ['/app/:path*', '/api/:path*'] }
