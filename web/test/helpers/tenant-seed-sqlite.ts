// One row of tenant data in EVERY tenant-scoped table (lib/tenant/scope.ts) on SQLite, today's production store: the
// SQLite counterpart of tenant-seed.ts (Postgres). Each row is built from the live schema: the tenant column is the
// tenant, a parent-scoped row points at this tenant's parent row, every text column carries `${tag}~${table}`. A value
// a CHECK constraint rejects is replaced from the constraint's own text (an allowed literal, a length, a range). A table
// no row could be written to is returned in `failed` with SQLite's reason, never skipped silently.
import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { NOT_DIRECT, TENANT_COLUMNS } from '../../lib/tenant/scope.ts'

type Col = { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }
export const marker = (tag: string, table: string) => `${tag}~${table}`
const PRESET: Record<string, Record<string, unknown>> = { scan_jobs: { status: 'running' } }
const SKIP = new Set(['users', 'tenant_tombstones', 'tenant_tombstone_keys'])

export function tenantTablesSqlite(db: Database.Database): Map<string, Col[]> {
  const out = new Map<string, Col[]>()
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]) {
    if (SKIP.has(name)) continue
    const nd = NOT_DIRECT[name]
    if (nd && 'global' in nd) continue
    const cols = db.prepare(`PRAGMA table_info("${name}")`).all() as Col[]
    if (cols.some(c => TENANT_COLUMNS.includes(c.name)) || (nd && 'via' in nd)) out.set(name, cols)
  }
  return out
}

// A value for one column of a failed CHECK expression, or undefined when the expression is not a shape handled here.
function satisfy(expr: string, cols: string[], tag: string, table: string): [string, unknown] | undefined {
  for (const col of cols) {
    const c = `\\b${col}\\b`
    if (!new RegExp(c).test(expr)) continue
    if (new RegExp(`${c}\\s+LIKE\\s+'http`, 'i').test(expr)) return [col, `https://${tag}.example.test/${table}`]
    if (new RegExp(`${c}\\s*<>\\s*''`).test(expr)) return [col, marker(tag, table)]
    const inList = new RegExp(`${c}\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(expr)
    if (inList) { const first = inList[1].split(',')[0].trim(); return [col, /^'.*'$/.test(first) ? first.slice(1, -1) : Number(first)] }
    const eq = new RegExp(`${c}\\s*=\\s*'([^']*)'`).exec(expr); if (eq) return [col, eq[1]]
    const lenBetween = new RegExp(`length\\(${col}\\)\\s+BETWEEN\\s+(\\d+)\\s+AND\\s+(\\d+)`, 'i').exec(expr)
    if (lenBetween) return [col, marker(tag, table).padEnd(Number(lenBetween[1]), '.').slice(0, Number(lenBetween[2]))]
    const lenEq = new RegExp(`length\\(${col}\\)\\s*=\\s*(\\d+)`, 'i').exec(expr)
    if (lenEq) return [col, marker(tag, table).replace(/[^a-z0-9]/gi, '').padEnd(Number(lenEq[1]), '0').slice(0, Number(lenEq[1]))]
    const lenMin = new RegExp(`length\\(${col}\\)\\s*>=?\\s*(\\d+)`, 'i').exec(expr)
    if (lenMin) return [col, marker(tag, table).padEnd(Number(lenMin[1]) + 1, '.')]
    const lenMax = new RegExp(`length\\(${col}\\)\\s*<=?\\s*(\\d+)`, 'i').exec(expr)
    if (lenMax) return [col, marker(tag, table).slice(0, Math.max(1, Number(lenMax[1]) - 1))]
    const between = new RegExp(`${c}\\s+BETWEEN\\s+(-?[\\d.]+)\\s+AND`, 'i').exec(expr); if (between) return [col, Number(between[1])]
    const ge = new RegExp(`${c}\\s*>=?\\s*(-?[\\d.]+)`).exec(expr); if (ge) return [col, Number(ge[1]) + 1]
    if (/LIKE\s+'https?:/i.test(expr) || /'http/.test(expr)) return [col, `https://${tag}.example.test/${table}`]
    if (/json_valid/i.test(expr)) return [col, JSON.stringify({ marker: marker(tag, table) })]
  }
  return undefined
}

export type SeededSqlite = { tag: string; tenant: string; ids: Record<string, string>; failed: Record<string, string> }
export function seedTenantSqlite(db: Database.Database, tenant: string, tag: string): SeededSqlite {
  const tables = tenantTablesSqlite(db)
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, salt, business_name) VALUES (?, ?, 'x', 'y', ?)").run(tenant, `${tag}@example.test`, marker(tag, 'users'))
  const via = (t: string) => { const nd = NOT_DIRECT[t]; return nd && 'via' in nd ? nd.via : null }
  const refsOf = (t: string) => [...(via(t) ? [via(t)![1]] : []), ...(db.prepare(`PRAGMA foreign_key_list("${t}")`).all() as { table: string }[]).map(f => f.table)].filter(r => r !== t && tables.has(r))
  const depth = (t: string, seen = new Set<string>()): number => seen.has(t) ? 0 : Math.max(0, ...refsOf(t).map(r => 1 + depth(r, new Set([...seen, t]))))
  const ids: Record<string, string> = {}, failed: Record<string, string> = {}
  for (const t of [...tables.keys()].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))) {
    const v = via(t)
    // foreign keys point at this tenant's own row in the referenced table
    const fks = new Map((db.prepare(`PRAGMA foreign_key_list("${t}")`).all() as { from: string; table: string }[]).map(f => [f.from, f.table]))
    const values: Record<string, unknown> = {}
    const id = `${tag}${randomBytes(6).toString('hex')}`
    let missing = ''
    for (const c of tables.get(t)!) {
      if (TENANT_COLUMNS.includes(c.name)) values[c.name] = tenant
      else if (PRESET[t]?.[c.name] !== undefined) values[c.name] = PRESET[t][c.name]
      else if (v && c.name === v[0]) { if (ids[v[1]]) values[c.name] = ids[v[1]]; else missing = `no ${v[1]} row` }
      else if (fks.has(c.name)) { const ref = fks.get(c.name)!; if (ids[ref]) values[c.name] = ids[ref]; else if (c.notnull) missing = `no ${ref} row for ${c.name}` }
      else if (c.name === 'id' && /INT/i.test(c.type) && c.pk) continue
      else if (c.name === 'id') values[c.name] = id
      else if (/INT|REAL|NUM/i.test(c.type)) { if (c.notnull && c.dflt_value === null) values[c.name] = 1 }
      else if (c.notnull && c.dflt_value === null || c.pk) values[c.name] = c.pk ? `${marker(tag, t)}-${c.name}` : marker(tag, t)
      else if (/TEXT|CHAR|^$/i.test(c.type) && c.dflt_value === null) values[c.name] = marker(tag, t)
    }
    if (missing) { failed[t] = missing; continue }
    for (let attempt = 0; ; attempt++) {
      const cols = Object.keys(values)
      try {
        const r = db.prepare(`INSERT INTO "${t}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map(c => values[c] as never))
        ids[t] = String(values.id ?? r.lastInsertRowid)
        break
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const expr = /CHECK constraint failed: (.*)$/.exec(msg)?.[1]
        const fix = expr ? satisfy(expr, tables.get(t)!.map(c => c.name), tag, t) : undefined
        if (/UNIQUE constraint failed/.test(msg) && attempt < 5) { for (const c of cols) if (typeof values[c] === 'number') values[c] = 1 + Math.floor(Math.random() * 1e6); continue }
        if (attempt > 40 || !fix || values[fix[0]] === fix[1]) { failed[t] = msg; break }
        values[fix[0]] = fix[1]
      }
    }
  }
  // leads are written only to a running scan (a trigger); the scan then ends, as a real one would
  if (ids.scan_jobs) db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(ids.scan_jobs)
  return { tag, tenant, ids, failed }
}

// Every row the tenant owns (directly or through its parent chain), table by table, as sorted JSON.
export function snapshotSqlite(db: Database.Database, tenant: string, tables = tenantTablesSqlite(db)): Record<string, string> {
  const where = (t: string): { sql: string; p: string[] } => {
    const nd = NOT_DIRECT[t]
    if (nd && 'via' in nd) { const w = where(nd.via[1]); return { sql: `"${nd.via[0]}" IN (SELECT id FROM "${nd.via[1]}" WHERE ${w.sql})`, p: w.p } }
    const col = (db.prepare(`PRAGMA table_info("${t}")`).all() as Col[]).find(c => TENANT_COLUMNS.includes(c.name))!.name
    return { sql: `"${col}" = ?`, p: [tenant] }
  }
  const out: Record<string, string> = {}
  for (const t of [...tables.keys()].sort()) { const w = where(t); out[t] = JSON.stringify((db.prepare(`SELECT * FROM "${t}" WHERE ${w.sql}`).all(...w.p) as object[]).map(r => JSON.stringify(r)).sort()) }
  out.users = JSON.stringify(db.prepare('SELECT * FROM users WHERE id = ?').all(tenant))
  return out
}
