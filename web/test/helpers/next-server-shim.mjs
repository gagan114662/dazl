import server from '../../node_modules/next/server.js'
export const NextResponse = server.NextResponse
export const NextRequest = server.NextRequest
export async function connection() {}
// after() outside a request scope throws in the real module; tests record the callbacks and never run them, so a route
// that kicks the scan runner after responding starts no scan.
export const afterCalls = []
export function after(cb) { afterCalls.push(cb) }
