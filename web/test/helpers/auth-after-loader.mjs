// Loader for the auth route runtimes (email-routes, auth-lifecycle-routes, pg-port-auth-routes, auth-enumeration-841):
// the session loader (workspace-session-loader.mjs: real session lookup, per-request cookie jar), with next/server's
// after() running its callback after the response (next-server-after-shim.mjs) as a Next server does.
import { resolve as sessionResolve } from './workspace-session-loader.mjs'
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/server' && !context.parentURL?.endsWith('/next-server-after-shim.mjs')) return { url: new URL('./next-server-after-shim.mjs', import.meta.url).href, shortCircuit: true }
  return sessionResolve(specifier, context, nextResolve)
}
