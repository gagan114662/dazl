import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getAuthDb, getSessionUser } from '@/lib/auth-db'
import { getUsage, migrateUsage } from '@/lib/llm/usage'

export async function GET() {
  const user = getSessionUser((await cookies()).get('dazl_session')?.value)
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getAuthDb()
  migrateUsage(db)
  return NextResponse.json(getUsage(db, user.id))
}
