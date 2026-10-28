// The tenant-route loader, plus next/server with connection() as a no-op: outside a Next request scope the real one
// throws, and it only opts the route out of prerendering.
import { resolve as tenantResolve } from './tenant-route-loader.mjs'
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/server' && !context.parentURL?.endsWith('/next-server-shim.mjs')) return { url: new URL('./next-server-shim.mjs', import.meta.url).href, shortCircuit: true }
  return tenantResolve(specifier, context, nextResolve)
}
