// Loader for test/helpers/pg-port-auth-routes-runtime.mts: the session loader (workspace-session-loader.mjs: real
// session lookup, per-request cookie jar), plus next/server with connection() as a no-op and after() running after the
// response (next-server-after-shim.mjs, via auth-after-loader.mjs), so the Google routes run outside a Next request
// scope as in google-auth-route-runtime.mts and the reset mail is sent after its answer (#841).
export { resolve } from './auth-after-loader.mjs'
