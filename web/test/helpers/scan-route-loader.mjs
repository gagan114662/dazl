import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// Loader for the POST /api/scan route harness: the scan db/user come from a test module, auth-db is a stub (no file is
// opened), and next/server keeps the real request/response classes but captures after().
const web = new URL('../../', import.meta.url)
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@/lib/scan/service') return { url: new URL('./tenant-route-db.ts', import.meta.url).href, shortCircuit: true }
  if (specifier === '@/lib/auth-db') return { url: new URL('./scan-route-auth-stub.ts', import.meta.url).href, shortCircuit: true }
  if (specifier === 'next/server') return { url: new URL('./status-route-next-server-shim.mjs', import.meta.url).href, shortCircuit: true }
  if (specifier.startsWith('@/')) {
    for (const suffix of ['.ts', '.tsx', '/index.ts']) {
      const url = new URL(specifier.slice(2) + suffix, web)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
