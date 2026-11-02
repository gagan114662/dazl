// The tenant route loader (session and store from tenant-route-db.ts), plus a stand-in for the page fetch and model call
// of the site read (icp-from-site-stub.ts), so POST /api/scan/icp-from-url runs with its real trial admission and no
// network.
import { resolve as tenantResolve } from './tenant-route-loader.mjs'
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@/lib/scan/icp-from-site') return { url: new URL('./icp-from-site-stub.ts', import.meta.url).href, shortCircuit: true }
  return tenantResolve(specifier, context, nextResolve)
}
