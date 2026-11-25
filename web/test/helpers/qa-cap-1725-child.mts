import Database from 'better-sqlite3'
import { sharedPool } from '../../lib/llm/spend-pool.ts'
import { SpendRefused } from '../../lib/llm/spend-guard.ts'
const db = new Database(process.argv[2])
db.pragma('busy_timeout = 10000')
try {
  await sharedPool(db, 'qa', { day: 10, month: 100 }, () => Number(process.argv[3])) .reserve(0.25)
  console.log(1)
} catch (error) {
  if (!(error instanceof SpendRefused)) throw error
  console.log(0)
} finally { db.close() }
