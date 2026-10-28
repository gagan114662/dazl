// Deploy step: npm run db:migrate. Applies pending Postgres migrations when DATABASE_URL is set.
// Without DATABASE_URL (today's production, SQLite) it does nothing: SQLite tables are created by the app at startup.
// Setting DATABASE_URL in production needs the owner's authorization (docs/PLATFORM.md, "Production go/no-go").
import pg from 'pg'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'

const url = process.env.DATABASE_URL
if (!url) {
  console.log('db:migrate: DATABASE_URL not set; SQLite store, nothing to do')
  process.exit(0)
}
const pool = new pg.Pool({ connectionString: url, max: 1 })
try {
  const r = await runPgMigrations(pool)
  console.log(`db:migrate: applied [${r.applied.join(', ')}], already applied [${r.alreadyApplied.join(', ')}]`)
} catch (e) {
  console.error('db:migrate failed:', e instanceof Error ? e.message : e)
  process.exitCode = 1
} finally {
  await pool.end()
}
