// Test-only next/server for the auth route runtimes: the real NextRequest/NextResponse, connection() as a no-op, and
// after() as in a Next server: the callback runs once the response is handed back, never before it. Outside a Next
// request scope the real after() throws, so routes that defer work (forgot password, #841) need this to run at all.
// settleAfter() waits for every callback scheduled so far, so a test can read what the deferred work wrote.
import server from '../../node_modules/next/server.js'
export const NextResponse = server.NextResponse
export const NextRequest = server.NextRequest
export async function connection() {}
const pending = new Set()
export function after(cb) {
  const p = new Promise(r => setImmediate(r)).then(() => typeof cb === 'function' ? cb() : cb)
  pending.add(p); p.finally(() => pending.delete(p)).catch(() => {})
}
export async function settleAfter() { while (pending.size) await Promise.all([...pending]) }
