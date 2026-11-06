// Test-only preload for the session worker (#436): when PLATFORM_STUB_BODY is set, every platform request the worker
// makes answers with that body and PLATFORM_STUB_STATUS (default 200) instead of going to the network. Lets a booted
// worker be driven end to end with synthetic platform answers - no live platform request is ever made.
//   node --experimental-strip-types --import ./test/platform-stub.ts src/server.ts
const body = process.env.PLATFORM_STUB_BODY
if (body !== undefined) {
  const status = Number(process.env.PLATFORM_STUB_STATUS ?? '200')
  globalThis.fetch = (async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })) as typeof fetch
}
