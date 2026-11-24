import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { deleteSession } from '@/lib/auth-db'
import { SIGNED_OUT_PATH, signoutRedirects } from '@/lib/auth-signout'

export async function POST(req?: Request) {
  const cookieStore = await cookies()
  await deleteSession(cookieStore.get('dazl_session')?.value)
  cookieStore.delete('dazl_session')
  // #1643: the app's Sign out button is a form, so the browser shows this answer: send it to the home page (303: a GET follows)
  if (req && signoutRedirects(req.headers)) return NextResponse.redirect(new URL(SIGNED_OUT_PATH, process.env.PUBLIC_BASE_URL || req.url), 303)
  return NextResponse.json({ ok: true })
}
