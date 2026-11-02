// Loader for test/helpers/preview-claim-route-runtime.mts: workspace-session-loader's service and cookie-jar
// substitutions, plus next/server with connection() as a no-op (outside a Next request scope the real one throws;
// it only opts the route out of prerendering, which test/preview-claim-routes.test.ts checks separately by source).
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const web = new URL('../../', import.meta.url)
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/server' && !context.parentURL?.endsWith('/next-server-shim.mjs')) return { url: new URL('./next-server-shim.mjs', import.meta.url).href, shortCircuit: true }
  if (specifier === '@/lib/scan/service') return { url: new URL('./workspace-session-service.ts', import.meta.url).href, shortCircuit: true }
  if (specifier === 'next/headers') return { url: new URL('./pg-session-headers.ts', import.meta.url).href, shortCircuit: true }
  if (specifier.startsWith('@/')) {
    for (const suffix of ['.ts', '.tsx', '/index.ts']) {
      const url = new URL(specifier.slice(2) + suffix, web)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
