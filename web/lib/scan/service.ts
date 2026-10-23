import { migrateSourceReview } from './source-review.ts'
import { migrateSequences } from '../outreach/sequences.ts'
import { cookies } from 'next/headers'
import { getAuthDb, getSessionUser } from '../auth-db'
import { migrateScan } from './store.ts'
import { migrateWatch } from '../watch.ts'
import { migrateKeys } from '../llm/key-store.ts'
import { migrateAdvanced } from '../advanced/index.ts'
import { migrateConnectors } from '../connectors/store.ts'
import { migratePlans } from '../plans.ts'
import { migrateBilling } from '../billing/stripe.ts'
import { migrateOutreach } from '../outreach/store.ts'
import { migrateAutopilot } from '../outreach/autopilot.ts'
import { migrateLedger } from '../outreach/ledger.ts'
import { migrateMonitors } from '../monitors.ts'
import { migrateCsv } from './csv-import.ts'
import { migrateCommenterImport } from './commenter-import.ts'
import { migrateMemory } from '../memory.ts'
import { migrateReopen } from '../outreach/reopen.ts'
import { migrateReplies } from '../outreach/replies.ts'
import { migrateThreadReplies } from '../replies/threads.ts'
import { migrateTrial } from './trial.ts'
import { migrateCompetitors } from '../signals/competitor-reddit.ts'
import { migrateEvents } from '../events/store.ts'
import { migrateSeo } from '../seo/audit.ts'
import { migrateWarm } from '../warm/connections.ts'

let ready = false
export function getScanDb() {
  const db = getAuthDb()
  if (!ready) {
    migrateScan(db)
    migrateSourceReview(db)
    migrateWatch(db)
    migrateKeys(db)
    migratePlans(db)
    migrateConnectors(db)
    migrateAdvanced(db)
    migrateBilling(db)
    migrateOutreach(db)
    migrateAutopilot(db)
    migrateLedger(db)
    migrateReplies(db)
    migrateThreadReplies(db)
    migrateSequences(db)
    migrateTrial(db)
    migrateCompetitors(db)
    migrateEvents(db)
    migrateWarm(db)
    migrateSeo(db)
    migrateMonitors(db)
    migrateCsv(db)
    migrateCommenterImport(db)
    migrateMemory(db)
    migrateReopen(db)
    ready = true
  }
  return db
}

export async function requireUser() {
  return getSessionUser((await cookies()).get('dazl_session')?.value)
}