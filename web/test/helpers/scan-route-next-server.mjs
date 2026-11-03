// next/server for route-runtime tests: real NextRequest/NextResponse, no-op after() (no request scope in tests).
export { NextRequest, NextResponse } from '../../node_modules/next/server.js'
export const after = (fn) => { try { if (typeof fn === 'function') void fn() } catch { /* test scope */ } }
export const connection = async () => {}
