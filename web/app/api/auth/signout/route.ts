import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { deleteSession } from '@/lib/auth-db'

export async function POST() {
  const cookieStore = await cookies()
  await deleteSession(cookieStore.get('dazl_session')?.value)
  cookieStore.delete('dazl_session')
  return NextResponse.json({ ok: true })
}
