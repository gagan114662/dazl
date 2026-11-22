// Connects LinkedIn for a workspace the way Settings does: the notice accepted, the browser's time zone stored, a pairing code created
// and redeemed by the extension (lib/advanced/linkedin-connect.ts). Returns the device token the extension would hold.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { Db } from '../../lib/db/client.ts'
import { writeConsent } from '../../lib/advanced/index.ts'
import { createPairing, redeemPairing } from '../../lib/advanced/linkedin-connect.ts'
import { setTimezone } from '../../lib/linkedin-tasks/store.ts'

export async function pairLinkedIn(db: Db, tenantId: string, userId: string, tz: string, now: number): Promise<string> {
  process.env.DAZL_MASTER_KEY ??= randomBytes(32).toString('base64')
  await writeConsent(db, tenantId, 'linkedin')
  assert.equal(await setTimezone(db, tenantId, tz), true)
  const pairing = await createPairing(db, tenantId, userId, now)
  const device = await redeemPairing(db, pairing.code, now)
  assert.ok(device && device.tenantId === tenantId)
  return device.token
}
