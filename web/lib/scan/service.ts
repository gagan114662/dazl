import { cookies } from 'next/headers'
import { getAuthDb, getSessionUser } from '../auth-db'
import { migrateScan } from './store.ts'
import { migrateKeys } from '../llm/key-store.ts'
import { migrateAdvanced } from '../advanced/index.ts'
import { migrateConnectors } from '../connectors/store.ts'
import { migratePlans } from '../plans.ts'
import { migrateBilling } from '../billing/stripe.ts'
import { migrateOutreach } from '../outreach/store.ts'
import { migrateAutopilot } from '../outreach/autopilot.ts'
import { migrateLedger } from '../outreach/ledger.ts'
import { migrateReplies } from '../outreach/replies.ts'
import { migrateTrial } from './trial.ts'

let ready = false
export function getScanDb() {
  const db = getAuthDb()
  if (!ready) {
    migrateScan(db)
    migrateKeys(db)
    migratePlans(db)
    migrateConnectors(db)
    migrateAdvanced(db)
    migrateBilling(db)
    migrateOutreach(db)
    migrateAutopilot(db)
    migrateLedger(db)
    migrateReplies(db)
    migrateTrial(db)
    ready = true
  }
  return db
}

export async function requireUser() {
  return getSessionUser((await cookies()).get('dazl_session')?.value)
}
