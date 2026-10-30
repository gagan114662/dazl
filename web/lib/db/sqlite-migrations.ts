// Every sqlite migrate*() the app runs, in one place: the schema extractor (scripts/pg-migrate/extract-schema.ts) and the
// two-engine test harness (test/helpers/engines.ts) both use it, so the PG schema and the test schema cannot drift.
import type Database from 'better-sqlite3'
import { migrateInsertionOrder } from './insertion-order.ts'
import { migrateAuth } from '../auth-db.ts'
import { migratePlatform } from './platform-tables.ts'
import { migrateScan } from '../scan/store.ts'
import { migrateSourceRuns } from '../scan/source-runs.ts'
import { migrateCsv } from '../scan/csv-import.ts'
import { migrateCommenterImport } from '../scan/commenter-import.ts'
import { migrateTrial } from '../scan/trial.ts'
import { migrateOutreach } from '../outreach/store.ts'
import { migrateSequences } from '../outreach/sequences.ts'
import { migrateReplies } from '../outreach/replies.ts'
import { migrateLedger } from '../outreach/ledger.ts'
import { migrateReopen } from '../outreach/reopen.ts'
import { migrateAutopilot } from '../outreach/autopilot.ts'
import { migrateCalcom } from '../calcom/index.ts'
import { migrateIndexing } from '../seo/indexing.ts'
import { migrateBriefs } from '../seo/brief.ts'
import { migrateSeo } from '../seo/audit.ts'
import { migrateNewsjacks } from '../seo/newsjack.ts'
import { migrateMonitors } from '../monitors.ts'
import { migratePlans } from '../plans.ts'
import { migrateMemory } from '../memory.ts'
import { migrateKeys } from '../llm/key-store.ts'
import { migrateWatch } from '../watch.ts'
import { migrateWarm } from '../warm/connections.ts'
import { migrateConnectors } from '../connectors/store.ts'
import { migrateBilling } from '../billing/stripe.ts'
import { migrateOauth } from '../auth-google.ts'
import { migrateTinyfish } from '../search/tinyfish.ts'
import { migrateThreadReplies } from '../replies/threads.ts'
import { migrateEvents } from '../events/store.ts'
import { migrateAdvanced } from '../advanced/index.ts'
import { migrateCompetitors } from '../signals/competitor-reddit.ts'
import { migrateQualify } from '../scan/qualify-run.ts'
import { migrateModelUsage } from '../scan/model-usage.ts'
import { migrateSourceStats } from '../search/trace.ts'
import { migrateSourceReview } from '../scan/source-review.ts'
import { migrateHiringFeed } from '../scan/job-feed.ts'
import { migrateEmailGuess } from '../people/email-pattern.ts'
import { SqliteQueue } from '../queue/sqlite.ts'
import { migrateTrialBudget } from '../billing/trial-budget.ts'
import { migrateAcquisitionLifecycle } from '../outreach/lifecycle.ts'
import { migrateLifecycle } from '../growth/lifecycle.ts'

export function migrateAllSqlite(db: Database.Database): void {
  migrateAuth(db)
  migratePlatform(db)
  const migrates = [
    migrateScan, migrateSourceRuns, migrateCsv, migrateCommenterImport, migrateTrial,
    migrateOutreach, migrateSequences, migrateReplies, migrateLedger, migrateReopen,
    migrateAutopilot, migrateCalcom, migrateIndexing, migrateBriefs, migrateSeo,
    migrateNewsjacks, migrateMonitors, migratePlans, migrateMemory, migrateKeys,
    migrateWatch, migrateWarm, migrateConnectors, migrateBilling, migrateOauth,
    migrateTinyfish, migrateThreadReplies, migrateEvents, migrateAdvanced, migrateCompetitors,
    migrateQualify, migrateModelUsage, migrateSourceStats, migrateSourceReview, migrateHiringFeed, migrateEmailGuess,
    migrateTrialBudget, migrateAcquisitionLifecycle, migrateLifecycle,
  ]
  for (const m of migrates) m(db)
  // The queue adapter owns its tables and creates them in its constructor.
  new SqliteQueue(db)
  // Last: it adds a column to tables the migrations above create.
  migrateInsertionOrder(db)
}
