// One row of tenant data in EVERY tenant-scoped table (helpers/tenant-tables.ts), for the two-instance sweep
// (test/pg-table-isolation.test.ts). Each row is built from the live schema: the tenant column is the tenant, a
// parent-scoped row points at that tenant's parent row, and every text column carries a marker naming the tenant and
// the table (`${tag}~${table}`) so any response that returns the row can be traced to it. A value a CHECK constraint
// rejects is replaced from that constraint's own definition (an allowed literal, a fixed length, a URL pattern); a
// foreign key points at this tenant's own row in the referenced table. A table no row could be written to is
// returned in `failed` with the database's reason, never skipped silently.
import { randomBytes } from 'node:crypto'
import type { Db, Param } from '../../lib/db/client.ts'
import { NOT_DIRECT, TENANT_COLUMNS } from './tenant-tables.ts'

type Col = { table: string; column: string; type: string; nullable: boolean; hasDefault: boolean }
export const marker = (tag: string, table: string) => `${tag}~${table}`

// Values the schema's triggers need while seeding (a lead is written only to a running scan).
const PRESET: Record<string, Record<string, unknown>> = { scan_jobs: { status: 'running' } }

// A value for `col` that satisfies the CHECK constraint `def`, or undefined when the definition is not one of the
// shapes the schema uses.
function satisfy(def: string, col: string, tag: string, table: string): unknown {
  const c = `\\(?${col}\\)?`
  const lit = new RegExp(`${c} = ANY \\(ARRAY\\['([^']*)'`).exec(def) ?? new RegExp(`${c} = '([^']*)'::text`).exec(def)
  if (lit) return lit[1]
  const len = new RegExp(`char_length\\(${col}\\) = (\\d+)`).exec(def)
  if (len) return marker(tag, table).replace(/[^a-z0-9]/g, '').padEnd(Number(len[1]), '0').slice(0, Number(len[1]))
  if (new RegExp(`lower\\(${col}\\) ~~`).test(def)) return `https://${tag}.example/${marker(tag, table)}`
  const min = new RegExp(`char_length\\(${col}\\) >= (\\d+)`).exec(def)
  if (min) return marker(tag, table).padEnd(Number(min[1]), '.')
  const max = new RegExp(`char_length\\(${col}\\) <= (\\d+)`).exec(def)
  if (max) return marker(tag, table).slice(0, Number(max[1]))
  const ge = new RegExp(`\\(${col} >= (\\d+)\\)`).exec(def)
  if (ge) return Number(ge[1])
  return undefined
}

export async function tenantTables(db: Db): Promise<Map<string, Col[]>> {
  const rows = await db.all<{ t: string; c: string; ty: string; n: string; d: string | null }>(
    `SELECT table_name AS t, column_name AS c, data_type AS ty, is_nullable AS n, column_default AS d FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name <> 'dazl_schema_migrations' ORDER BY table_name, ordinal_position`)
  const all = new Map<string, Col[]>()
  for (const r of rows) all.set(r.t, [...(all.get(r.t) ?? []), { table: r.t, column: r.c, type: r.ty, nullable: r.n === 'YES', hasDefault: r.d !== null }])
  const out = new Map<string, Col[]>()
  for (const [t, cols] of all) {
    const nd = NOT_DIRECT[t]
    if (nd && 'global' in nd) continue
    if (cols.some(c => TENANT_COLUMNS.includes(c.column)) || (nd && 'via' in nd)) out.set(t, cols)
  }
  return out
}

const isText = (ty: string) => ty === 'text' || ty.startsWith('character')
const isNum = (ty: string) => ['integer', 'bigint', 'smallint', 'double precision', 'real', 'numeric'].includes(ty)

// ids: each table's row id; texts: every text value written (what a caller could name a row by: a keyword, a domain)
export type Seeded = { tag: string; tenant: string; ids: Record<string, string[]>; texts: string[]; failed: Record<string, string> }

// Seeds one row per tenant-scoped table for `tenant`. Parents first (scan_jobs before leads before lead_sources).
export async function seedTenant(db: Db, tenant: string, tag: string): Promise<Seeded> {
  const tables = await tenantTables(db)
  const cons = await db.all<{ t: string; name: string; ty: string; def: string }>(`SELECT conrelid::regclass::text AS t, conname AS name, contype AS ty, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE connamespace = current_schema()::regnamespace AND contype IN ('c', 'f')`)
  const checks = new Map(cons.filter(c => c.ty === 'c').map(c => [c.name, c.def]))
  // FOREIGN KEY (col) REFERENCES parent(id)
  const fks = new Map<string, Map<string, string>>()
  for (const c of cons.filter(c => c.ty === 'f')) {
    const m = /FOREIGN KEY \((\w+)\) REFERENCES (\w+)\(/.exec(c.def)
    if (m) fks.set(c.t, (fks.get(c.t) ?? new Map()).set(m[1], m[2]))
  }
  const parents = (t: string) => { const nd = NOT_DIRECT[t]; return [...(nd && 'via' in nd ? [nd.via[1]] : []), ...(fks.get(t)?.values() ?? [])].filter(p => p !== t && tables.has(p)) }
  const depth = (t: string, seen = new Set<string>()): number => seen.has(t) ? 0 : Math.max(0, ...parents(t).map(p => 1 + depth(p, new Set([...seen, t]))))
  const ids: Record<string, string[]> = {}, failed: Record<string, string> = {}, texts = new Set<string>()
  for (const t of [...tables.keys()].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))) {
    const nd = NOT_DIRECT[t]
    const refs = new Map(fks.get(t) ?? [])
    if (nd && 'via' in nd) refs.set(nd.via[0], nd.via[1])
    const id = `${tag}${randomBytes(6).toString('hex')}`
    const values: Record<string, unknown> = {}
    let missing = ''
    for (const c of tables.get(t)!) {
      if (TENANT_COLUMNS.includes(c.column)) values[c.column] = tenant
      else if (PRESET[t]?.[c.column] !== undefined) values[c.column] = PRESET[t][c.column]
      else if (refs.has(c.column)) {
        const parentId = ids[refs.get(c.column)!]?.[0]
        if (parentId !== undefined) values[c.column] = parentId
        else if (!c.nullable) missing = `no ${refs.get(c.column)} row for ${c.column}`
      } else if (c.column === 'id' && isText(c.type)) values[c.column] = id
      else if (c.column === 'id' && c.hasDefault) continue
      else if (isText(c.type)) values[c.column] = marker(tag, t)
      else if (isNum(c.type) && (!c.nullable || !c.hasDefault)) values[c.column] = 1
      else if (!c.nullable && !c.hasDefault) values[c.column] = c.type === 'boolean' ? false : 1
    }
    if (missing) { failed[t] = missing; continue }
    for (let attempt = 0; ; attempt++) {
      const cols = Object.keys(values)
      try {
        const row = await db.get<{ id?: unknown }>(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING *`, cols.map(c => values[c]) as Param[])
        ids[t] = [String(row?.id ?? values.id ?? '')].filter(Boolean)
        for (const v of Object.values(values)) if (typeof v === 'string' && v !== tenant) texts.add(v)
        break
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // a key made of numbers (a day, a counter) the other tenant already used: pick other numbers
        if (/duplicate key/.test(msg) && attempt < 5) {
          for (const c of tables.get(t)!) if (isNum(c.type) && typeof values[c.column] === 'number' && !refs.has(c.column)) values[c.column] = 1 + Math.floor(Math.random() * 1e6)
          continue
        }
        const name = /violates check constraint "([^"]+)"/.exec(msg)?.[1]
        const def = name ? checks.get(name) : undefined
        const col = def ? cols.find(c => satisfy(def, c, tag, t) !== undefined && def.includes(c)) : undefined
        const v = def && col ? satisfy(def, col, tag, t) : undefined
        if (attempt > 40 || !col || v === undefined || values[col] === v) { failed[t] = msg; break }
        values[col] = v
      }
    }
  }
  // leads are written only to a running scan (a trigger); the scan then ends, as a real one would
  if (ids.scan_jobs) await db.run("UPDATE scan_jobs SET status = 'done' WHERE id = ?", [ids.scan_jobs[0]])
  return { tag, tenant, ids, texts: [...texts].sort(), failed }
}

// Every row a tenant owns, table by table (directly, or through its parent chain), as JSON: compared before and after
// the other tenant's sweep, it must be byte-identical.
export async function snapshot(db: Db, tenant: string): Promise<Record<string, string>> {
  const tables = await tenantTables(db)
  const out: Record<string, string> = {}
  const where = (t: string): string => {
    const nd = NOT_DIRECT[t]
    if (nd && 'via' in nd) return `${nd.via[0]} IN (SELECT ${nd.via[1] === 'scan_jobs' || !NOT_DIRECT[nd.via[1]] ? 'id' : 'id'} FROM ${nd.via[1]} WHERE ${where(nd.via[1])})`
    const col = tables.get(t)!.find(c => TENANT_COLUMNS.includes(c.column))!.column
    return `${col} = '${tenant.replace(/'/g, "''")}'`
  }
  for (const t of [...tables.keys()].sort()) {
    const rows = await db.all(`SELECT * FROM ${t} WHERE ${where(t)}`)
    out[t] = JSON.stringify(rows.map(r => JSON.stringify(r)).sort())
  }
  // the tenant's identity rows (global by classification: the id is the tenant), so a snapshot covers them too
  out.users = JSON.stringify(await db.all('SELECT * FROM users WHERE id = ?', [tenant]))
  out.organizations = JSON.stringify(await db.all('SELECT * FROM organizations WHERE id = ?', [tenant]))
  return out
}
