// Browser errors (lib/client-error-report.ts posts them to app/api/client-errors). The body is untrusted: anyone can
// post one. It becomes an ordinary error record (lib/ops/errors.ts) only through the same guards as server errors:
//   kind     - a fixed set, else the report is refused
//   name     - errorName (class-shaped or '[unrecognized-name]')
//   message  - scrubbed and bounded by toRecord
//   stack    - at most 8 frames, Chrome ("at f (url:1:2)") or Firefox/Safari ("f@url:1:2") lines only, scrubbed
//   path     - the page's path, recorded only as its route template ('/app/campaigns/[id]'), never the concrete URL
// The tenant comes from the session cookie (the route looks it up), never from the body. Nothing else is read.
import { captureError, type ErrorRecord } from './errors.ts'
import { routeTemplate } from './request-log.ts'

export const CLIENT_ERROR_KINDS = ['boundary', 'error', 'unhandledrejection'] as const
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number]
export const MAX_CLIENT_ERROR_BYTES = 8 * 1024

class ClientReport extends Error {}
// public pages outside /app and /api are not in the route list (lib/ops/routes.ts); these are matched exactly
const PUBLIC_PAGES = new Set(['/', '/sign-in', '/sign-up', '/privacy', '/terms'])
const pageTemplate = (p: string) => { const bare = p.split(/[?#]/)[0]; return PUBLIC_PAGES.has(bare) ? bare : routeTemplate(bare) }

function frames(stack: unknown): string[] {
  if (typeof stack !== 'string') return []
  const out: string[] = []
  for (const raw of stack.slice(0, 4000).split('\n')) {
    const l = raw.trim()
    if (l.startsWith('at ')) out.push(l)
    else { const m = /^([^@\s]{0,100})@(\S+:\d+:\d+)$/.exec(l); if (m) out.push(`at ${m[1] || '<anonymous>'} (${m[2]})`) }
    if (out.length === 8) break
  }
  return out
}

// 'invalid' when the body is not a client error report; otherwise the record (null if capture itself failed)
export function recordClientError(body: unknown, ctx: { tenantId?: string | null; requestId?: string | null }): ErrorRecord | null | 'invalid' {
  if (!body || typeof body !== 'object') return 'invalid'
  const b = body as Record<string, unknown>
  if (!CLIENT_ERROR_KINDS.includes(b.kind as ClientErrorKind) || typeof b.path !== 'string' || !b.path.startsWith('/')) return 'invalid'
  const e = new ClientReport(typeof b.message === 'string' ? b.message.slice(0, 2000) : '')
  e.name = typeof b.name === 'string' ? b.name : 'Error'
  e.stack = [`${e.name}: ${e.message}`, ...frames(b.stack)].join('\n')
  // where: the page's route template, prefixed so client and server records of one page stay apart
  return captureError(e, { source: 'client', where: `${b.kind}:${pageTemplate(b.path)}`, tenantId: ctx.tenantId, requestId: ctx.requestId })
}
