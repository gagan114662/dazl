import { timingSafeEqual, createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { clientIp, rateLimit } from './rate-limit'

// Machine-to-machine auth for the scan worker. The secret lives only in the
// server's WORKER_SECRET env var and on the worker. If it is unset the
// worker API is disabled (503), so a fresh deploy exposes nothing.
export function checkWorker(req: NextRequest): NextResponse | null {
  const secret = process.env.WORKER_SECRET
  if (!secret || secret.length < 32) return NextResponse.json({ error: 'Worker API disabled' }, { status: 503 })
  const rl = rateLimit(`worker:${clientIp(req)}`, 120, 60 * 1000)
  if (!rl.ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  const given = (req.headers.get('authorization') || '').replace(/^Bearer /, '')
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(secret).digest()
  if (!timingSafeEqual(a, b)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return null
}
