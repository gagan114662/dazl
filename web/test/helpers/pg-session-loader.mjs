// Loader for test/helpers/pg-tenant-instance.mts: the real route handlers with the real session lookup. next/headers
// becomes a per-request cookie jar (pg-session-headers.ts) and @/lib/scan/service's requireUser reads the session from
// it (pg-session-service.ts), so sign-up, sign-in, sign-out and every signed-in route go through the sessions table on
// Postgres, as in the app. Everything else resolves as the app's @/ paths.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const web = new URL('../../', import.meta.url)
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@/lib/scan/service') return { url: new URL('./pg-session-service.ts', import.meta.url).href, shortCircuit: true }
  if (specifier === 'next/headers') return { url: new URL('./pg-session-headers.ts', import.meta.url).href, shortCircuit: true }
  if (specifier === 'next/server') return { url: new URL('node_modules/next/server.js', web).href, shortCircuit: true }
  if (specifier.startsWith('@/')) {
    for (const suffix of ['.ts', '.tsx', '/index.ts']) {
      const url = new URL(specifier.slice(2) + suffix, web)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
