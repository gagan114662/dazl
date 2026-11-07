import { existsSync, writeFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { POST } from '../../app/api/scan/route.ts'

// Child process for the #913 two-process admission race: its OWN connection to the shared database FILE, the real POST /api/scan handler,
// network fenced, after() captured and never flushed. Not a test file: scan-admission-two-process.test.ts spawns two of these.
globalThis.fetch = (async (u: unknown) => { throw new Error(`network fenced: ${String(u)}`) }) as typeof fetch
const { DB_FILE, READY_FILE, GO_FILE, TENANT } = process.env as Record<string, string>
const db = new Database(DB_FILE); db.pragma('busy_timeout = 20000')   // an explicit, bounded wait for the write lock
setScanDb(db); setUser({ id: TENANT, business_name: 'Acme' })
const body = JSON.stringify({ query: 'Independent dental practices hiring a receptionist in New York in the past 90 days' })
const request = new NextRequest('http://localhost/api/scan', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', 'x-forwarded-for': `10.9.0.${process.pid % 250}` }, body })
writeFileSync(READY_FILE, String(process.pid))
while (!existsSync(GO_FILE)) await new Promise(r => setTimeout(r, 5))   // both children are released together by the parent
const t0 = Date.now()
const res = await POST(request)
const j = await res.json() as Record<string, unknown>
console.log('RESULT ' + JSON.stringify({ pid: process.pid, status: res.status, error: j.error ?? null, job_id: j.job_id ?? null, ms: Date.now() - t0 }))
db.close(); process.exit(0)
