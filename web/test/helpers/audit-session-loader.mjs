// Loader for test/helpers/audit-routes-runtime.mts: the real route handlers with the real session lookup over one
// SQLite fixture store. next/headers becomes a per-request cookie jar (pg-session-headers.ts) and @/lib/scan/service's
// requireUser reads the session from it (audit-session-service.ts). Everything else resolves as the app's @/ paths.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const web = new URL('../../', import.meta.url)
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@/lib/scan/service') return { url: new URL('./audit-session-service.ts', import.meta.url).href, shortCircuit: true }
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
