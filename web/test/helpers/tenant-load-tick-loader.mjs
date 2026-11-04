import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// Loader for the tenant-load tick harness (test/tenant-load-tick.test.ts): the REAL tick route and the REAL scan runner
// on the fixture store (tenant-route-db.ts). after() is captured (status-route-next-server-shim.mjs) so the test runs
// the route's post-response scan kick itself, and the route's kickRunner gets the test's stubbed providers and page
// fetcher (tenant-load-runner-shim.ts). Nothing else is replaced.
const web = new URL('../../', import.meta.url)
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@/lib/scan/service') return { url: new URL('./tenant-route-db.ts', import.meta.url).href, shortCircuit: true }
  if (specifier === '@/lib/scan/runner') return { url: new URL('./tenant-load-runner-shim.ts', import.meta.url).href, shortCircuit: true }
  if (specifier === 'next/server') return { url: new URL('./status-route-next-server-shim.mjs', import.meta.url).href, shortCircuit: true }
  if (specifier === 'next/headers') return { url: new URL('node_modules/next/headers.js', web).href, shortCircuit: true }
  if (specifier.startsWith('@/')) {
    for (const suffix of ['.ts', '.tsx', '/index.ts']) {
      const url = new URL(specifier.slice(2) + suffix, web)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
