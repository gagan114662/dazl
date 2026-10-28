// Next.js onRequestError hook (instrumentation.ts): every error a route handler, page or server action throws
// uncaught lands here once. Records it through captureError with the route template (never the concrete URL) and the
// signed-in tenant id when the session cookie resolves to one. Nothing else from the request is read.
import { captureError, type ErrorRecord } from './errors.ts'

export interface RequestInfo { path: string; method: string; headers: Record<string, string | string[] | undefined> }
export interface RequestErrorContext { routerKind?: string; routePath?: string; routeType?: string }

const SESSION_COOKIE = 'dazl_session'

export function sessionToken(headers: RequestInfo['headers']): string | undefined {
  const raw = headers.cookie
  const cookie = Array.isArray(raw) ? raw.join('; ') : raw
  if (!cookie) return undefined
  for (const part of cookie.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim()
  }
  return undefined
}

export interface RequestErrorDeps {
  // tenant id for a session token, or null; the lookup is bounded so a down store cannot hang error capture
  tenantFor: (token: string) => Promise<string | null>
  timeoutMs?: number
}

export async function handleRequestError(err: unknown, request: RequestInfo, context: RequestErrorContext, deps: RequestErrorDeps): Promise<ErrorRecord | null> {
  let tenantId: string | null = null
  const token = sessionToken(request.headers)
  if (token) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      tenantId = await Promise.race([deps.tenantFor(token), new Promise<null>(res => { timer = setTimeout(() => res(null), deps.timeoutMs ?? 500) })])
    } catch { tenantId = null } finally { clearTimeout(timer) }
  }
  // the route template Next gives ('/api/leads/[lead]/confirm'); never the concrete path, whose segments are caller data
  const where = context.routePath || '[unknown-route]'
  const rid = request.headers['x-request-id']
  return captureError(err, { source: context.routeType === 'route' ? 'route' : 'render', where, method: request.method, tenantId, requestId: Array.isArray(rid) ? rid[0] : rid })
}
