// Loader for test/helpers/icp-from-url-route-runtime.mts: the real POST /api/scan/icp-from-url handler over a
// SQLite fixture (tenant-route-db), next/server shim, and DNS stubbed so the SSRF guard is exercised without network.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const web = new URL('../../', import.meta.url)
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@/lib/scan/service') return { url: new URL('./tenant-route-db.ts', import.meta.url).href, shortCircuit: true }
  if (specifier === 'next/server') return { url: new URL('./status-route-next-server-shim.mjs', import.meta.url).href, shortCircuit: true }
  if ((specifier.endsWith('/net/public-fetch.ts') || specifier === '@/lib/net/public-fetch') && !String(context.parentURL).endsWith('icp-public-fetch-wrap.mts')) return { url: new URL('./icp-public-fetch-wrap.mts', import.meta.url).href, shortCircuit: true }
  if (specifier === 'node:dns/promises') return { url: new URL('./icp-dns-stub.mjs', import.meta.url).href, shortCircuit: true }
  if (specifier.startsWith('@/')) {
    for (const suffix of ['.ts', '.tsx', '/index.ts']) {
      const url = new URL(specifier.slice(2) + suffix, web)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
