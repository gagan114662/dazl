import { NextResponse, connection } from 'next/server'

// Liveness probe: the process answers. Touches no database, so a slow store never gets a healthy process restarted.
export async function GET() {
  await connection()
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}
