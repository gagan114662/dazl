import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { deleteSession } from '@/lib/auth-db'
import { SIGNED_OUT_PATH, signoutRedirects } from '@/lib/auth-signout'
import { sessionTokens } from '@/lib/session-cookie'

export async function POST(req?: Request) {
  const cookieStore = await cookies()
  // #1686: a browser can present two sessions (a parent-domain cookie from an older Google sign-in beside a host-only one). Signing
  // out ends every one of them, so the browser is not left signed in as the other account. The old cookie itself, now useless, is
  // removed on the next page load (proxy.ts) or replaced by the next sign-in.
  const tokens = new Set([cookieStore.get('dazl_session')?.value, ...sessionTokens(req?.headers.get('cookie'))].filter((t): t is string => !!t))
  for (const t of tokens) await deleteSession(t)
  cookieStore.delete('dazl_session')
  // #1643: the app's Sign out button is a form, so the browser shows this answer: send it to the home page (303: a GET follows)
  if (req && signoutRedirects(req.headers)) return NextResponse.redirect(new URL(SIGNED_OUT_PATH, process.env.PUBLIC_BASE_URL || req.url), 303)
  return NextResponse.json({ ok: true })
}
