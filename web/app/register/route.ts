import { permanentRedirect } from '../../lib/permanent-redirect.ts'

// #1699: /register was a 404; the real page is /sign-up.
export function GET(req: Request) {
  return permanentRedirect(req, '/sign-up')
}
