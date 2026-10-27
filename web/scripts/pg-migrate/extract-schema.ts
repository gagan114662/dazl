// Extracts the authoritative full SQLite schema by running every module's own
// migrate function against a throwaway DB, then dumping sqlite_master. This is
// the schema the production DB actually converges to (CREATE + ALTER migrations),
// not a hand-maintained copy.
import Database from 'better-sqlite3'
import { writeFileSync, rmSync } from 'node:fs'
import { migrateScan } from '../../lib/scan/store.ts'
import { migrateSourceRuns } from '../../lib/scan/source-runs.ts'
import { migrateCsv } from '../../lib/scan/csv-import.ts'
import { migrateCommenterImport } from '../../lib/scan/commenter-import.ts'
import { migrateTrial } from '../../lib/scan/trial.ts'
import { migrateOutreach } from '../../lib/outreach/store.ts'
import { migrateSequences } from '../../lib/outreach/sequences.ts'
import { migrateReplies } from '../../lib/outreach/replies.ts'
import { migrateLedger } from '../../lib/outreach/ledger.ts'
import { migrateReopen } from '../../lib/outreach/reopen.ts'
import { migrateAutopilot } from '../../lib/outreach/autopilot.ts'
import { migrateCalcom } from '../../lib/calcom/index.ts'
import { migrateIndexing } from '../../lib/seo/indexing.ts'
import { migrateBriefs } from '../../lib/seo/brief.ts'
import { migrateSeo } from '../../lib/seo/audit.ts'
import { migrateNewsjacks } from '../../lib/seo/newsjack.ts'
import { migrateMonitors } from '../../lib/monitors.ts'
import { migratePlans } from '../../lib/plans.ts'
import { migrateMemory } from '../../lib/memory.ts'
import { migrateKeys } from '../../lib/llm/key-store.ts'
import { migrateWatch } from '../../lib/watch.ts'
import { migrateWarm } from '../../lib/warm/connections.ts'
import { migrateConnectors } from '../../lib/connectors/store.ts'
import { migrateBilling } from '../../lib/billing/stripe.ts'
import { migrateOauth } from '../../lib/auth-google.ts'
import { migrateTinyfish } from '../../lib/search/tinyfish.ts'
import { migrateThreadReplies } from '../../lib/replies/threads.ts'
import { migrateEvents } from '../../lib/events/store.ts'
import { migrateAdvanced } from '../../lib/advanced/index.ts'
import { migrateCompetitors } from '../../lib/signals/competitor-reddit.ts'
import { migrateQualify } from '../../lib/scan/qualify-run.ts'
import { migrateModelUsage } from '../../lib/scan/model-usage.ts'
import { migrateSourceStats } from '../../lib/search/trace.ts'
import { migrateSourceReview } from '../../lib/scan/source-review.ts'
import { migrateHiringFeed } from '../../lib/scan/job-feed.ts'
import { migrateEmailGuess } from '../../lib/people/email-pattern.ts'
import { SqliteQueue } from '../../lib/queue/sqlite.ts'

const out = process.env.EXTRACT_OUT || '/tmp/full-schema'
const dbPath = `${out}.db`
rmSync(dbPath, { force: true })
rmSync(`${dbPath}-wal`, { force: true })
rmSync(`${dbPath}-shm`, { force: true })

// users/sessions live behind getAuthDb's own handle; point it at the same file.
process.env.DB_PATH = dbPath
const { getAuthDb } = await import('../../lib/auth-db.ts')
const authDb = getAuthDb()
authDb.close()

const db = new Database(dbPath)
const migrates = [
  migrateScan, migrateSourceRuns, migrateCsv, migrateCommenterImport, migrateTrial,
  migrateOutreach, migrateSequences, migrateReplies, migrateLedger, migrateReopen,
  migrateAutopilot, migrateCalcom, migrateIndexing, migrateBriefs, migrateSeo,
  migrateNewsjacks, migrateMonitors, migratePlans, migrateMemory, migrateKeys,
  migrateWatch, migrateWarm, migrateConnectors, migrateBilling, migrateOauth,
  migrateTinyfish, migrateThreadReplies, migrateEvents, migrateAdvanced, migrateCompetitors,
  migrateQualify, migrateModelUsage, migrateSourceStats, migrateSourceReview, migrateHiringFeed, migrateEmailGuess,
]
for (const m of migrates) m(db)
// The queue adapter owns its tables and creates them in its constructor.
new SqliteQueue(db)

const objects = db.prepare(
  `SELECT type, name, tbl_name, sql FROM sqlite_master
   WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
   ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`,
).all() as { type: string; name: string; tbl_name: string; sql: string }[]

const tables = objects.filter(o => o.type === 'table')
const indexes = objects.filter(o => o.type === 'index')
const triggers = objects.filter(o => o.type === 'trigger')

writeFileSync(`${out}.sql`, objects.map(o => o.sql).join(';\n\n') + ';\n')
writeFileSync(`${out}.json`, JSON.stringify({
  tables: tables.map(t => t.name),
  indexes: indexes.map(i => ({ name: i.name, table: i.tbl_name })),
  triggers: triggers.map(t => ({ name: t.name, table: t.tbl_name })),
}, null, 2))

console.log(`tables: ${tables.length}, indexes: ${indexes.length}, triggers: ${triggers.length}`)
for (const t of triggers) console.log(`  trigger ${t.name} on ${t.tbl_name}`)
db.close()
