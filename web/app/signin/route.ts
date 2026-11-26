import { permanentRedirect } from '../../lib/permanent-redirect.ts'

// #1699: /signin was a 404; the real page is /sign-in.
export function GET(req: Request) {
  return permanentRedirect(req, '/sign-in')
}
