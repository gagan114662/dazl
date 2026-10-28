// Browser errors (lib/client-error-report.ts posts them to app/api/client-errors). The body is untrusted: anyone can
// post one. Only allowlisted fields are read, and each is checked against the shape it must have; any other field
// (message, stack text, tenant, ...) is ignored, never stored:
//   kind    - a fixed set, else the report is refused
//   type    - a built-in error class (CLIENT_ERROR_TYPES), else 'Error'
//   path    - the page's path, recorded only as its route template ('/app/campaigns/[id]'), never the concrete URL
//   frames  - at most 8 { file, line, col } with file a /_next/static/ bundle path; anything else is dropped
// The record carries no message text. The tenant comes from the session cookie (the route looks it up), never the body.
import { captureError, type ErrorRecord } from './errors.ts'
import { routeTemplate } from './request-log.ts'
import { CLIENT_ERROR_TYPES } from '../client-error-report.ts'

export const CLIENT_ERROR_KINDS = ['boundary', 'error', 'unhandledrejection'] as const
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number]
// A report is at most 2 KB (lib/client-error-report.ts MAX_BODY); the route refuses more than this before parsing.
export const MAX_CLIENT_ERROR_BYTES = 4 * 1024

class ClientReport extends Error {}
// public pages outside /app and /api are not in the route list (lib/ops/routes.ts); these are matched exactly
const PUBLIC_PAGES = new Set(['/', '/sign-in', '/sign-up', '/privacy', '/terms'])
const pageTemplate = (p: string) => { const bare = p.split(/[?#]/)[0]; return PUBLIC_PAGES.has(bare) ? bare : routeTemplate(bare) }

function frames(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const f of v.slice(0, 8)) {
    const x = f as { file?: unknown; line?: unknown; col?: unknown } | null
    if (!x || typeof x.file !== 'string' || !/^\/_next\/static\/[A-Za-z0-9_./~-]{1,200}$/.test(x.file)) continue
    if (!Number.isInteger(x.line) || !Number.isInteger(x.col) || (x.line as number) < 0 || (x.col as number) < 0 || (x.line as number) > 9_999_999 || (x.col as number) > 9_999_999) continue
    out.push(`at <client> (${x.file}:${x.line}:${x.col})`)
  }
  return out
}

// 'invalid' when the body is not a client error report; otherwise the record (null if capture itself failed)
export function recordClientError(body: unknown, ctx: { tenantId?: string | null; requestId?: string | null }): ErrorRecord | null | 'invalid' {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'invalid'
  const b = body as Record<string, unknown>
  if (!CLIENT_ERROR_KINDS.includes(b.kind as ClientErrorKind) || typeof b.path !== 'string' || !b.path.startsWith('/')) return 'invalid'
  const type = typeof b.type === 'string' && CLIENT_ERROR_TYPES.has(b.type) ? b.type : 'Error'
  const e = new ClientReport('browser error') // fixed: the browser's message is never sent
  e.name = type
  e.stack = [`${type}: browser error`, ...frames(b.frames)].join('\n')
  // where: the page's route template, prefixed so client and server records of one page stay apart
  return captureError(e, { source: 'client', where: `${b.kind}:${pageTemplate(b.path)}`, tenantId: ctx.tenantId, requestId: ctx.requestId })
}
