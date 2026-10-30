// @/lib/scan/service for test/helpers/pg-session-loader.mjs: requireUser exactly as the app's (lib/scan/service.ts), the
// session cookie looked up in the sessions table through getDb(). The raw SQLite handle is a trap: a route that reaches
// for it fails the run instead of quietly writing to a SQLite file beside Postgres.
import { cookies } from './pg-session-headers.ts'
import { getSessionUser } from '../../lib/auth-db.ts'

export async function requireUser() {
  return await getSessionUser((await cookies()).get('dazl_session')?.value)
}
export function getScanDb(): never { throw new Error('raw SQLite handle used on Postgres') }
