import Database from 'better-sqlite3'
import { runWithScanSpend, scanCapConfig } from '../../lib/scan/spend-cap.ts'
import { createSearchBudget } from '../../lib/discover/search-budget.ts'
const [file, jobId, tenantId] = process.argv.slice(2)
const db = new Database(file)
db.pragma('busy_timeout = 10000')
try {
  const allowance = await runWithScanSpend({db,jobId,tenantId,attempt:1,cap:scanCapConfig({}),accountLimits:null,nativeSearch:true},
    async () => (await createSearchBudget().reserve(4)).allowance)
  console.log(allowance)
} finally { db.close() }
