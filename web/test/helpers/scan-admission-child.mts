import { existsSync, writeFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { atFence } from './admission-fence.ts'
import { POST } from '../../app/api/scan/route.ts'

// Child process for the #913 two-process admission race: its OWN connection to the shared database FILE, the real POST /api/scan handler,
// network fenced, after() captured and never flushed. Not a test file: scan-admission-two-process.test.ts spawns two of these.
globalThis.fetch = (async (u: unknown) => { throw new Error(`network fenced: ${String(u)}`) }) as typeof fetch
const { DB_FILE, READY_FILE, GO_FILE, TENANT } = process.env as Record<string, string>   // READY_FILE is written at the admission fence (see below)
const db = new Database(DB_FILE); db.pragma('busy_timeout = 20000')   // an explicit, bounded wait for the write lock
// The barrier sits AT THE FENCE, not before the POST: the route's early checks have already run and passed (nothing was active yet), and the
// handler is about to open the admission transaction. Both processes stop here, the parent sees both, then releases both together, so the
// outcome depends on the fence itself and on nothing earlier. Without the fence's own recheck both would be admitted.
atFence(db, () => {
  writeFileSync(READY_FILE, String(process.pid))
  while (!existsSync(GO_FILE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
})
setScanDb(db); setUser({ id: TENANT, business_name: 'Acme' })
const body = JSON.stringify({ query: 'Independent dental practices hiring a receptionist in New York in the past 90 days' })
const request = new NextRequest('http://localhost/api/scan', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', 'x-forwarded-for': `10.9.0.${process.pid % 250}` }, body })
const t0 = Date.now()
const res = await POST(request)
const j = await res.json() as Record<string, unknown>
console.log('RESULT ' + JSON.stringify({ pid: process.pid, status: res.status, error: j.error ?? null, job_id: j.job_id ?? null, ms: Date.now() - t0 }))
db.close(); process.exit(0)
