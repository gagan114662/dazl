import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  if (!pathname.startsWith('/app')) return NextResponse.next()

  const cookieStore = await cookies()
  const session = cookieStore.get('dazl_session')
  if (!session?.value) {
    return NextResponse.redirect(new URL('/sign-in', req.url))
  }
  return NextResponse.next()
}

export const config = { matcher: ['/app/:path*'] }
