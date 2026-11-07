// Production service/auth/route/runner/read-service are NOT replaced. Only physical opener, cookies and after scope.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const web = new URL('../../', import.meta.url)
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/headers') return { url: new URL('./pg-session-headers.ts', import.meta.url).href, shortCircuit: true }
  if (specifier === 'next/server') return { url: new URL('./status-route-next-server-shim.mjs', import.meta.url).href, shortCircuit: true }
  if (specifier.endsWith('/sqlite-store.ts') && !context.parentURL?.endsWith('/status-boundary-sqlite.ts')) return { url: new URL('./status-boundary-sqlite.ts', import.meta.url).href, shortCircuit: true }
  if (specifier.startsWith('@/')) {
    for (const suffix of ['.ts', '.tsx', '/index.ts']) {
      const url = new URL(specifier.slice(2) + suffix, web)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
  }
  if (specifier.startsWith('.') && context.parentURL) {
    const url = new URL(specifier + '.ts', context.parentURL)
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
