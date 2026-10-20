import { NextResponse, connection } from 'next/server'
import { getAuthDb } from '@/lib/auth-db'

export async function GET() {
  await connection() // opt out of prerendering so the DB check runs per request
  try {
    getAuthDb().prepare('SELECT 1').get()
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 })
  }
}
