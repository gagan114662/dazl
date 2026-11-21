import { NextRequest, NextResponse } from 'next/server'
import { logRequest, newRequestId, requestLogLine } from '@/lib/ops/request-log'
import { hasLiveSession } from '@/lib/auth-db'
import { issueShellTimingReceipt, logShellAuth, shellRoute, SHELL_TIMING_ROUTE_HEADER, shellTimingEnabled, type ShellRoute } from '@/lib/ops/signed-shell-timing'
import { isServerActionProbe } from '@/lib/ops/server-action-probe'

// Runs before /app pages and /api routes (Node runtime). Gives each request an id (lib/ops/request-log.ts), logs it
// as one JSON line, and keeps /app behind a signed-in session. The session is looked up here, before any HTML is sent:
// the layout's own check (app/app/layout.tsx) streams behind a Suspense boundary, so on its own a cookie that is no
// longer a session (expired, signed out elsewhere, malformed) got a 200 with the app shell and only a late in-page
// redirect. If the lookup itself fails, the request goes on and the layout's check still decides.
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const id = newRequestId() // never the caller's x-request-id
  // #1088: a Next-Action request is a probe here (lib/ops/server-action-probe.ts): a plain 400 and one ordinary request-log
  // line, on every path (the third matcher below), instead of Next's stack trace per request.
  if (isServerActionProbe(req.headers)) {
    logRequest(requestLogLine(id, req.method, pathname))
    return new NextResponse('Bad Request\n', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-request-id': id, 'cache-control': 'no-store' } })
  }
  // health probes run every few seconds: no log line for them, but they still get an id
  if (!pathname.startsWith('/api/health') && pathname !== '/api/ready') logRequest(requestLogLine(id, req.method, pathname))

  const timing = shellTimingEnabled() && req.method === 'GET' && req.headers.get('sec-fetch-dest') === 'document'
    ? shellRoute(pathname) : null
  const session = pathname.startsWith('/app') ? req.cookies.get('dazl_session')?.value : undefined
  if (pathname.startsWith('/app') && !(await signedIn(session, timing, id))) {
    const r = NextResponse.redirect(new URL('/sign-in', req.url))
    r.headers.set('x-request-id', id)
    return r
  }
  const headers = new Headers(req.headers)
  headers.set('x-request-id', id)
  headers.delete(SHELL_TIMING_ROUTE_HEADER)
  if (timing) headers.set(SHELL_TIMING_ROUTE_HEADER, timing)
  const res = NextResponse.next({ request: { headers } })
  res.headers.set('x-request-id', id)
  const receipt = timing && session ? issueShellTimingReceipt(timing, id, session) : null
  if (receipt) res.headers.append('Server-Timing', `dazl_request;desc="${receipt}"`)
  return res
}

async function signedIn(token: string | undefined, route:ShellRoute|null, id:string): Promise<boolean> {
  if (!token) return false
  const start = route ? performance.now() : 0
  try {
    const signed = await hasLiveSession(token)
    if (route) logShellAuth(route, id, 'proxy_auth', start, signed ? 'allowed' : 'denied')
    return signed
  } catch (error) {
    if (route) logShellAuth(route, id, 'proxy_auth', start, 'error', error)
    return true
  }
}

// The third entry is lib/ops/server-action-probe.ts SERVER_ACTION_PROBE_MATCHER, written out: Next reads this object statically.
export const config = { matcher: ['/app/:path*', '/api/:path*', { source: '/:path*', has: [{ type: 'header', key: 'next-action' }] }] }
