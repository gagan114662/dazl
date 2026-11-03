// @/lib/scan/service for test/helpers/audit-session-loader.mjs: requireUser exactly as the app's (lib/scan/service.ts),
// the session cookie of the request being handled (pg-session-headers.ts withJar) looked up in the sessions table, so
// the caller's workspace and role come from real memberships. getScanDb is the fixture store (tenant-route-db.ts).
import { cookies } from './pg-session-headers.ts'
import { getSessionUser } from '../../lib/auth-db.ts'
export { getScanDb } from './tenant-route-db.ts'

export async function requireUser() {
  return await getSessionUser((await cookies()).get('dazl_session')?.value)
}
