import type { Db } from '../../lib/db/client.ts'

// #357: only an account whose owner confirmed its email has a working session (lib/auth-db.ts getSessionUser,
// hasLiveSession). Fixtures that sign accounts in confirm them first, as opening the verification link does.
export async function confirmEmail(db: Db, ...ids: string[]): Promise<void> {
  for (const id of ids) await db.run('UPDATE users SET email_verified_at = coalesce(email_verified_at, 1) WHERE id = ?', [id])
}
