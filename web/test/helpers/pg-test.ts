// Postgres for tests: DAZL_TEST_PG_URL (loopback only, e.g. the CI service container). Each caller gets its own fresh
// schema, dropped afterwards, so tests never share or keep state. Without the URL the PG tests skip, unless
// DAZL_REQUIRE_PG=1 (the CI postgres job), where a missing URL fails instead of silently skipping.
import pg from 'pg'
import { randomBytes } from 'node:crypto'

export const PG_URL = process.env.DAZL_TEST_PG_URL || undefined
if (!PG_URL && process.env.DAZL_REQUIRE_PG === '1') throw new Error('DAZL_REQUIRE_PG=1 but DAZL_TEST_PG_URL is not set')
if (PG_URL) {
  const h = new URL(PG_URL).hostname
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(h)) throw new Error(`DAZL_TEST_PG_URL must be loopback, got ${h}`)
}
export const pgSkip = PG_URL ? false : 'DAZL_TEST_PG_URL not set'

export async function freshSchema(): Promise<{ schema: string; drop: () => Promise<void> }> {
  const schema = 't_' + randomBytes(6).toString('hex')
  const admin = new pg.Client({ connectionString: PG_URL })
  await admin.connect()
  await admin.query(`CREATE SCHEMA ${schema}`)
  await admin.end()
  return {
    schema,
    drop: async () => {
      const c = new pg.Client({ connectionString: PG_URL })
      await c.connect()
      try { await c.query(`DROP SCHEMA ${schema} CASCADE`) } finally { await c.end() }
    },
  }
}
