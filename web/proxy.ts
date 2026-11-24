import { NextRequest, NextResponse } from 'next/server'
import { logRequest, newRequestId, requestLogLine, routeTemplate } from '@/lib/ops/request-log'
import { getDb } from '@/lib/db/client'
import { checkSessionWithin } from '@/lib/auth-gate'
import { warmStore } from '@/lib/store-warm'
import { isServerActionProbe } from '@/lib/ops/server-action-probe'
import { canonicalPageUrl } from '@/lib/canonical-host'

// Runs before /app pages and /api routes (Node runtime). Gives each request an id (lib/ops/request-log.ts), logs it
// as one JSON line, and keeps /app behind a signed-in session. The session is looked up here, before any HTML is sent:
// the layout's own check (app/app/layout.tsx) streams behind a Suspense boundary, so on its own a cookie that is no
// longer a session (expired, signed out elsewhere, malformed) got a 200 with the app shell and only a late in-page
// redirect. If the lookup itself fails or stalls past its deadline, the request is never let through as signed in (#1463): the
// answer is an immediate 503 with a Try again link, and the session cookie is left alone, so a brief store hiccup is not a sign-out.
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const t0 = performance.now()
  // #1463: open this bundle's store (and run its migrations) on the first request, normally the deploy's health probe,
  // so a user's first /app request after a deploy never pays the synchronous migration pass (lib/store-warm.ts).
  await warmStore(getDb).catch(() => {})
  const id = newRequestId() // never the caller's x-request-id
  // #1088: a Next-Action request is a probe here (lib/ops/server-action-probe.ts): a plain 400 and one ordinary request-log
  // line, on every path (the third matcher below), instead of Next's stack trace per request.
  if (isServerActionProbe(req.headers)) {
    logRequest(requestLogLine(id, req.method, pathname))
    return new NextResponse('Bad Request\n', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-request-id': id, 'cache-control': 'no-store' } })
  }
  // health probes run every few seconds: no log line for them, but they still get an id
  if (!pathname.startsWith('/api/health') && pathname !== '/api/ready') logRequest(requestLogLine(id, req.method, pathname))

  // #1686: a page asked for on www goes to the same path on the site's own hostname, so a browser has one place for its session
  const canonical = canonicalPageUrl(req.headers.get('host'), pathname + req.nextUrl.search, req.method, process.env.PUBLIC_BASE_URL)
  if (canonical) {
    const r = NextResponse.redirect(canonical, 308)
    r.headers.set('x-request-id', id)
    return r
  }

  if (pathname.startsWith('/app')) {
    const session = await signedIn(req.cookies.get('dazl_session')?.value)
    if (session === 'no') {
      const r = NextResponse.redirect(new URL('/sign-in', req.url))
      r.headers.set('x-request-id', id)
      return r
    }
    // #1463: the check could not answer. Not a pass and not a sign-out: an immediate 503 page (a plain document, so a client
    // navigation that gets it loads it as a page; it answers at once, so #1546's stall watch has no wait to recover from), with a
    // link to try the same page again. No refresh and no script: a person retries; nothing loops.
    if (session === 'unknown') {
      logLine({ level: 'error', type: 'app_request_unchecked', request_id: id, path: routeTemplate(pathname), proxy_ms: Math.round(performance.now() - t0) })
      const again = escapeHtml(pathname + req.nextUrl.search)
      return new NextResponse(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>dazl</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">We couldn't open your workspace just now</h1><p>You're still signed in. Please try again in a moment.</p><p><a href="${again}">Try again</a></p></body></html>`,
        { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '5', 'cache-control': 'no-store', 'x-request-id': id } })
    }
  }
  // #1463: each /app page request's time in this proxy (store warm + session check), logged on every request
  if (pathname.startsWith('/app')) logLine({ level: 'info', type: 'app_request', request_id: id, path: routeTemplate(pathname), proxy_ms: Math.round(performance.now() - t0) })
  const headers = new Headers(req.headers)
  headers.set('x-request-id', id)
  const res = NextResponse.next({ request: { headers } })
  res.headers.set('x-request-id', id)
  return res
}

async function signedIn(token: string | undefined): Promise<'yes' | 'no' | 'unknown'> {
  if (!token) return 'no'
  // Bounded like the layout (lib/auth-gate.ts, #1463). A failed or stalled lookup is 'unknown': never a pass (fail closed), never 'no'
  // (that would send a person with a good session to sign in over a store hiccup).
  try { return (await checkSessionWithin(token, { getDb, stage: 'proxy' })) ? 'yes' : 'no' } catch { return 'unknown' }
}
const escapeHtml = (v: string) => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

// The third entry is lib/ops/server-action-probe.ts SERVER_ACTION_PROBE_MATCHER, written out: Next reads this object statically.
const logLine = (l: Record<string, unknown>) => { try { console.log(JSON.stringify(l)) } catch { /* logging never breaks a request */ } }

// The fourth entry (#1686): every page asked for on a www host, so it can be sent to the site's own hostname (lib/canonical-host.ts).
export const config = { matcher: ['/app/:path*', '/api/:path*', { source: '/:path*', has: [{ type: 'header', key: 'next-action' }] }, { source: '/((?!api/|_next/).*)', has: [{ type: 'host', value: 'www\\..*' }] }] }
