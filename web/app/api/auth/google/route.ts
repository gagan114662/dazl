import { connection, NextRequest } from 'next/server'
import { signInConfig, startAuth } from '@/lib/auth-google'
import { clearLinkNextCookie, redirectNoStore, setLinkNextCookie, setOauthCookie, setReturnCookie, PREVIEW_CLAIM_COOKIE } from '@/lib/auth-google-response'
import { isClaimToken } from '@/lib/scan/preview-claim'
import { safeNext } from '@/lib/google-link'
import { clientIp, rateLimit } from '@/lib/rate-limit'

export async function GET(req: NextRequest) {
  // request time only: never prerendered with the build's configuration (lib/auth-google.ts signInConfig)
  await connection()
  const cfg = signInConfig()
  if (!cfg) return redirectNoStore(new URL('/sign-in?error=google_unavailable', process.env.PUBLIC_BASE_URL || req.url))
  const rl = (await rateLimit(`google:${clientIp(req)}`, 20, 10 * 60 * 1000))
  if (!rl.ok) return redirectNoStore(new URL(`/sign-in?error=${rl.unavailable ? 'unavailable' : 'too_many'}`, cfg.base))
  // #1095: a Google LINK starts only from a dazl page. A cross-site navigation here (Sec-Fetch-Site: cross-site /
  // same-site) could otherwise drive a browser signed in to someone else's account into linking its own Google
  // identity to that account. Browsers that send no Sec-Fetch-Site are allowed (the callback still needs the session).
  const site = req.headers.get('sec-fetch-site')
  if (req.nextUrl.searchParams.get('link') === '1' && site && site !== 'same-origin' && site !== 'none') {
    return redirectNoStore(new URL('/app/settings?google=failed#account', cfg.base))
  }
  const { url, cookie } = startAuth(cfg.clientId, cfg.redirectUri)
  const res = redirectNoStore(url)
  setOauthCookie(res, cfg.base, cookie)
  // ?reauth=1: re-authenticating from Settings (fresh sign-in for secrets, billing, members); come back there
  if (req.nextUrl.searchParams.get('reauth') === '1') setReturnCookie(res, cfg.base)
  // ?link=1: add Google sign-in to the signed-in account (Settings > Account); the callback decides, never this route
  if (req.nextUrl.searchParams.get('link') === '1') {
    setReturnCookie(res, cfg.base, 'link')
    // #1095: come back to the app page that asked (a refused free scan), not Settings; only a dazl app page is kept
    const next = safeNext(req.nextUrl.searchParams.get('next'))
    if (next) setLinkNextCookie(res, cfg.base, next)
    else clearLinkNextCookie(res, cfg.base) // an abandoned earlier link must not redirect this one
  }
  // #416: a plain "Continue with Google" from a browser carrying a preview claim intent (e.g. the sign-in page opened
  // from an email confirmation link in a new tab, where the tab-only copy is gone) returns to the claim, not /app.
  // Only a well-formed token counts; the callback and the claim route re-verify it before any use.
  const plain = req.nextUrl.searchParams.get('reauth') !== '1' && req.nextUrl.searchParams.get('link') !== '1'
  if (plain && isClaimToken(req.cookies.get(PREVIEW_CLAIM_COOKIE)?.value)) setReturnCookie(res, cfg.base, 'preview')
  return res
}
