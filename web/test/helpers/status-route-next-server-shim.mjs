// Test-only next/server shim: real NextRequest/NextResponse, but after() is
// captured so the test can flush post-response work deterministically.
export * from '../../node_modules/next/server.js'
const pending = []
export function after(cb) { pending.push(cb) }
export async function flushAfter() { const cbs = pending.splice(0); for (const cb of cbs) await cb() }
