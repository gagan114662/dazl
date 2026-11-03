import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const web = new URL('../../', import.meta.url)
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@/lib/scan/service') return { url: new URL('./sequence-route-db.ts', import.meta.url).href, shortCircuit: true }
  if (specifier === '@/lib/scan/runner') return { url: new URL('./scan-route-stub-runner.ts', import.meta.url).href, shortCircuit: true }
  if (specifier === '@/lib/auth-db') return { url: new URL('./scan-route-auth-db.ts', import.meta.url).href, shortCircuit: true }
  if (specifier === 'next/server') return { url: new URL('./scan-route-next-server.mjs', import.meta.url).href, shortCircuit: true }
  if (specifier.startsWith('@/')) {
    for (const suffix of ['.ts', '.tsx', '/index.ts']) {
      const url = new URL(specifier.slice(2) + suffix, web)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
