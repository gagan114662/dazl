import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { emailStatus } from '@/lib/email-ownership'

// The signed-in account's email, whether it is verified, and whether it signs in with Google.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json(await emailStatus(await getDb(), user.actorId))
}
