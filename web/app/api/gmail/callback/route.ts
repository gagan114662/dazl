import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { completeOAuth } from '@/lib/gmail/oauth'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'
import { audit } from '@/lib/audit-route'

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.redirect(new URL('/sign-in', process.env.PUBLIC_BASE_URL || req.url))
  const back = (r: string) => NextResponse.redirect(new URL(`/app/settings?gmail=${r}`, process.env.PUBLIC_BASE_URL || req.url))
  const code = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state')
  if (req.nextUrl.searchParams.get('error') || !code || !state) return back('denied')
  try {
    await completeOAuth(getScanDb(), user.id, code, state)
    await audit(user, req, { action: 'credential.saved', resource: 'gmail' })
    return back('connected')
  } catch (e) {
    captureError(e, { source: 'route', where: '/api/gmail/callback', method: 'GET', tenantId: user.id, requestId: requestIdOf(req) })
    return back('error')
  }
}
