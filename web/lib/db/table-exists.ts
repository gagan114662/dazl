import type { Db } from './client.ts'

// Legacy SQLite snapshots can predate optional tables. Postgres uses the
// connection's search path, just as the subsequent query does.
export async function tableExists(db: Db, table: string): Promise<boolean> {
  if (db.kind === 'sqlite') {
    const rows = await db.all<{ name: string; type: string }>('PRAGMA main.table_list')
    return rows.some(row => row.name === table && row.type === 'table')
  }
  return (await db.get<{ present: boolean }>('SELECT to_regclass(?) IS NOT NULL AS present', [table]))?.present === true
}
