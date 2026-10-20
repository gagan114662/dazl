import { cookies } from 'next/headers'
import { getAuthDb, getSessionUser } from '../auth-db'
import { migrateScan } from './store.ts'
import { migrateKeys } from '../llm/key-store.ts'
import { migrateAdvanced } from '../advanced/index.ts'
import { migrateConnectors } from '../connectors/store.ts'
import { migratePlans } from '../plans.ts'
import { migrateBilling } from '../billing/stripe.ts'

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
    ready = true
  }
  return db
}

export async function requireUser() {
  return getSessionUser((await cookies()).get('dazl_session')?.value)
}
