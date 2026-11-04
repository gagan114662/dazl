import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const web = new URL('../../', import.meta.url)
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@/lib/scan/service') return { url: new URL('./tenant-route-db.ts', import.meta.url).href, shortCircuit: true }
  // real request/response classes; after() is captured (never run unless a test flushes it), as outside Next's request scope
  // the real after() throws, and the tick route always queues a scan kick (#355)
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
