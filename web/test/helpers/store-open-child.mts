// One process for the concurrent-start test in test/scan-worker-836.test.ts: opens the SQLite file in DB_PATH the way
// every app process does and runs the store setup (migrateAllSqlite) W_ROUNDS times, starting at the shared instant
// W_GO (epoch ms) so the processes really overlap. Prints "ok" when every round finished.
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'

const db = new Database(process.env.DB_PATH!)
db.pragma('journal_mode = WAL')
while (Date.now() < Number(process.env.W_GO)) { /* spin to the shared start */ }
for (let i = 0; i < Number(process.env.W_ROUNDS ?? 1); i++) migrateAllSqlite(db)
db.close()
console.log('ok')
