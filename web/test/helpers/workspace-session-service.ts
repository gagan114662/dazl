// @/lib/scan/service for test/helpers/workspace-session-loader.mjs: the app's requireUser (the session cookie of the
// request being handled, looked up through getSessionUser, memberships included) over a SQLite fixture store.
import { cookies } from './pg-session-headers.ts'
import { getSessionUser } from '../../lib/auth-db.ts'
export { getScanDb } from './tenant-route-db.ts'

export async function requireUser() {
  return await getSessionUser((await cookies()).get('dazl_session')?.value)
}
