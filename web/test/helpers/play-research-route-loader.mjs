import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const web = new URL('../../', import.meta.url)
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@/lib/scan/service') return { url: new URL('./play-research-route-db.ts', import.meta.url).href, shortCircuit: true }
  if (specifier === './fetch-page.ts' && context.parentURL?.endsWith('/lib/scan/play-research.ts')) return {url:new URL('./play-research-fetch.ts',import.meta.url).href,shortCircuit:true}
  if (specifier === 'next/server') return { url: new URL('node_modules/next/server.js', web).href, shortCircuit: true }
  if (specifier.startsWith('@/')) {
    for (const suffix of ['.ts', '.tsx', '/index.ts']) {
      const url = new URL(specifier.slice(2) + suffix, web)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
