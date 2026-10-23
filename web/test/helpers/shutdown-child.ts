// Child process for shutdown-requeue.test.ts: runs the REAL instrumentation register() against a temp DB.
process.env.NEXT_RUNTIME = 'nodejs'
const { register } = await import('../../instrumentation.ts')
const { getAuthDb } = await import('../../lib/auth-db.ts')
const { migrateScan } = await import('../../lib/scan/store.ts')
const { trackInFlight } = await import('../../lib/scan/runner.ts')
const db = getAuthDb(); migrateScan(db)
const ins = db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, attempts, claimed_at, created_at) VALUES (?, 'A', 'Acme', 'x', 'y', 'running', ?, 12345, 1)")
ins.run('own-job', 1); ins.run('other-job', 1); ins.run('reclaimed-job', 2); ins.run('maxed-job', 3)
// this process executes own-job (attempt 1), maxed-job (attempt 3) and reclaimed-job as attempt 1 (the row is already attempt 2)
trackInFlight({ id: 'own-job', attempts: 1 } as never); trackInFlight({ id: 'maxed-job', attempts: 3 } as never); trackInFlight({ id: 'reclaimed-job', attempts: 1 } as never)
const before = process.listenerCount('SIGTERM')
await register()
console.log('LISTENERS_DELTA=' + (process.listenerCount('SIGTERM') - before))
// Next's own SIGTERM cleanup exits the process; stand in for it (registered AFTER ours, as in production)
process.on('SIGTERM', () => setTimeout(() => process.exit(143), 50))
console.log('READY')
setInterval(() => {}, 1000)
export {}
