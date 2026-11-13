// Whether Gmail reply reading is on for a workspace, on the Db layer (SQLite or Postgres): the current read consent,
// a connected account that granted read access, and that account still active. The same three checks as the
// conversion report route (app/api/outreach/conversion/route.ts) and the reply sync (lib/outreach/replies.ts).
// Server only (reads the store); callers that cannot read it fail closed through their own error path.
import type { Db } from '../db/client.ts'
import { READ_CONSENT_VERSION } from './read-consent.ts'
import { readGmailStatus } from '../gmail/oauth.ts'

export async function replyReadingOn(db: Db, tenantId: string): Promise<boolean> {
  const consent = await db.get<{ version: string }>('SELECT version FROM mail_read_consent WHERE tenant_id = ?', [tenantId])
  if (consent?.version !== READ_CONSENT_VERSION) return false
  const g = await readGmailStatus(db, tenantId)
  return !!g && g.read_granted && g.status === 'active'
}
