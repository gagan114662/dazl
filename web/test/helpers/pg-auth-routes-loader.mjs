// Loader for test/helpers/pg-port-auth-routes-runtime.mts: the session loader (workspace-session-loader.mjs: real
// session lookup, per-request cookie jar), plus next/server with connection() as a no-op (next-server-shim.mjs), so the
// Google routes run outside a Next request scope as in google-auth-route-runtime.mts.
import { resolve as sessionResolve } from './workspace-session-loader.mjs'
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/server' && !context.parentURL?.endsWith('/next-server-shim.mjs')) return { url: new URL('./next-server-shim.mjs', import.meta.url).href, shortCircuit: true }
  return sessionResolve(specifier, context, nextResolve)
}
