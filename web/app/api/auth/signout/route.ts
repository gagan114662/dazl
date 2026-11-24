import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { deleteSession } from '@/lib/auth-db'
import { SIGNED_OUT_PATH, signoutRedirects } from '@/lib/auth-signout'
import { expireSessionCookies, sessionTokens } from '@/lib/session-cookie'

export async function POST(req?: Request) {
  const cookieStore = await cookies()
  // #1686: the browser can hold the cookie in two forms (host-only from a password sign-in, parent-domain from Google). Signing out
  // ends every session it presented and removes both forms, so nobody stays signed in as the other account.
  const tokens = new Set([cookieStore.get('dazl_session')?.value, ...sessionTokens(req?.headers.get('cookie'))].filter((t): t is string => !!t))
  for (const t of tokens) await deleteSession(t)
  cookieStore.delete('dazl_session')
  const base = process.env.PUBLIC_BASE_URL || req?.url || 'http://localhost'
  // #1643: the app's Sign out button is a form, so the browser shows this answer: send it to the home page (303: a GET follows)
  if (req && signoutRedirects(req.headers)) return expireSessionCookies(NextResponse.redirect(new URL(SIGNED_OUT_PATH, process.env.PUBLIC_BASE_URL || req.url), 303), base, 'domain')
  return expireSessionCookies(NextResponse.json({ ok: true }), base, 'domain')
}
