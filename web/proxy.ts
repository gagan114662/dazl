import { NextRequest, NextResponse } from 'next/server'
import { logRequest, newRequestId, requestLogLine } from '@/lib/ops/request-log'
import { getSessionUser } from '@/lib/auth-db'

// Runs before /app pages and /api routes (Node runtime). Gives each request an id (lib/ops/request-log.ts), logs it
// as one JSON line, and keeps /app behind a signed-in session. The session is looked up here, before any HTML is sent:
// the layout's own check (app/app/layout.tsx) streams behind a Suspense boundary, so on its own a cookie that is no
// longer a session (expired, signed out elsewhere, malformed) got a 200 with the app shell and only a late in-page
// redirect. If the lookup itself fails, the request goes on and the layout's check still decides.
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const id = newRequestId() // never the caller's x-request-id
  // health probes run every few seconds: no log line for them, but they still get an id
  if (!pathname.startsWith('/api/health') && pathname !== '/api/ready') logRequest(requestLogLine(id, req.method, pathname))

  if (pathname.startsWith('/app') && !(await signedIn(req.cookies.get('dazl_session')?.value))) {
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

async function signedIn(token: string | undefined): Promise<boolean> {
  if (!token) return false
  try { return (await getSessionUser(token)) !== null } catch { return true }
}

export const config = { matcher: ['/app/:path*', '/api/:path*'] }
