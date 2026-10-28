// Postgres-readiness audit (docs/PLATFORM.md "Postgres cutover"). Finds every SQL statement the app source passes to a
// store, statically, so a path no test happens to exercise is still checked:
//   raw  - better-sqlite3: handle.prepare(sql) / handle.exec(sql). Synchronous, so it can only ever run on the SQLite
//          file: a module with any raw statement is not on Postgres, whatever DATABASE_URL says.
//   db   - the async Db layer (lib/db/client.ts): db.get/all/run(sql, ...) and t.get/all/run inside db.tx.
//   pg   - Postgres-native SQL sent with a pg client's query(sql, ...) (lib/db/leads-read-pg.ts).
// test/pg-sql-audit.test.ts then PREPAREs each statement on a freshly migrated Postgres schema: that parses it and
// resolves every table, column, function and parameter type, without running it.
// SQL built at runtime (a template with ${...} that is not a same-file string constant) cannot be checked statically:
// it is listed as 'dynamic' with the text around the holes.
import ts from 'typescript'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export interface SqlSite {
  file: string // relative to web/
  line: number
  api: 'raw' | 'db' | 'pg'
  sql: string
  dynamic: boolean // built from runtime values: not checkable statically
}

const SQL_START = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE|CREATE|ALTER|DROP|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|ANALYZE)\b/i

const SKIP_DIRS = new Set(['node_modules', '.next', 'test', 'tests', 'public'])
export function sourceFiles(root: string, dirs = ['lib', 'app']): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(name)) walk(p); continue }
      if (/\.(ts|tsx|mts)$/.test(name) && !/\.(test|spec)\.\w+$/.test(name) && !name.endsWith('.d.ts')) out.push(p)
    }
  }
  for (const d of dirs) if (existsSync(join(root, d))) walk(join(root, d))
  return out.sort()
}

// Same-file `const NAME = 'sql'` (or a template of other such constants) resolves; anything else is a runtime value.
function constStrings(sf: ts.SourceFile): Map<string, ts.Expression> {
  const m = new Map<string, ts.Expression>()
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclarationList(n) && n.flags & ts.NodeFlags.Const) {
      for (const d of n.declarations) if (ts.isIdentifier(d.name) && d.initializer) m.set(d.name.text, d.initializer)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return m
}

function evalString(e: ts.Expression, consts: Map<string, ts.Expression>, depth = 0): { text: string; dynamic: boolean } | null {
  if (depth > 5) return null
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { text: e.text, dynamic: false }
  if (ts.isParenthesizedExpression(e)) return evalString(e.expression, consts, depth + 1)
  if (ts.isIdentifier(e)) { const init = consts.get(e.text); return init ? evalString(init, consts, depth + 1) : null }
  if (ts.isTemplateExpression(e)) {
    let text = e.head.text, dynamic = false
    for (const span of e.templateSpans) {
      const v = evalString(span.expression, consts, depth + 1)
      if (v) { text += v.text; dynamic ||= v.dynamic } else { text += '/*${}*/'; dynamic = true }
      text += span.literal.text
    }
    return { text, dynamic }
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = evalString(e.left, consts, depth + 1), r = evalString(e.right, consts, depth + 1)
    if (!l && !r) return null
    return { text: (l?.text ?? '/*${}*/') + (r?.text ?? '/*${}*/'), dynamic: !l || !r || l.dynamic || r.dynamic }
  }
  return null
}

export function sqlSitesIn(path: string, root: string): SqlSite[] {
  const src = readFileSync(path, 'utf8')
  if (!/\.(prepare|exec|get|all|run|query)\s*[(<]/.test(src)) return []
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const consts = constStrings(sf)
  const out: SqlSite[] = []
  const file = relative(root, path)
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.arguments.length > 0) {
      const method = n.expression.name.text
      const api = method === 'prepare' || method === 'exec' ? 'raw' : method === 'get' || method === 'all' || method === 'run' ? 'db' : method === 'query' ? 'pg' : null
      if (api) {
        const v = evalString(n.arguments[0], consts)
        if (v && SQL_START.test(v.text)) {
          out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, api, sql: v.text, dynamic: v.dynamic })
        } else if (api === 'raw' && !v && method === 'prepare') {
          // handle.prepare(someRuntimeString): a raw statement whose text this audit cannot see
          out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, api, sql: '/*${}*/', dynamic: true })
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

// Code that speaks each engine's own dialect on purpose, branching on db.kind, and is tested on both engines: the Db
// layer's SQLite engine, and the cross-engine tooling (store copy, this audit). Left out of the inventory.
export const ENGINE_FILES = new Set(['lib/db/client.ts', 'lib/db/copy-store.ts', 'lib/db/sql-audit.ts'])

export function sqlInventory(root: string): SqlSite[] {
  return sourceFiles(root).filter(f => !ENGINE_FILES.has(relative(root, f))).flatMap(f => sqlSitesIn(f, root))
}

// Statements that only make sense on SQLite and that the Postgres side replaces as a whole: schema setup (the PG
// schema is lib/db/migrations/pg, checked against the SQLite one by test/pg-schema-equivalence), PRAGMAs, and
// transaction control (the Db layer owns transactions).
export function isSqliteAdmin(sql: string): boolean {
  return /^\s*(CREATE|ALTER|DROP|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|ANALYZE)\b/i.test(sql)
}

// SQLite placeholders (?, ?NNN, @name, :name, $name) to Postgres $n, outside quotes. A named parameter keeps one number.
export function toPgParams(sql: string): string {
  let out = '', n = 0
  const named = new Map<string, number>()
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    if (c === "'" || c === '"') {
      const j = sql.indexOf(c, i + 1)
      const end = j < 0 ? sql.length : j
      out += sql.slice(i, end + 1); i = end; continue
    }
    if (c === '-' && sql[i + 1] === '-') { const j = sql.indexOf('\n', i); const end = j < 0 ? sql.length : j; out += sql.slice(i, end); i = end - 1; continue }
    if (c === '?') {
      const m = /^\?(\d+)/.exec(sql.slice(i))
      if (m) { const k = `?${m[1]}`; if (!named.has(k)) named.set(k, ++n); out += `$${named.get(k)}`; i += m[0].length - 1 } else out += `$${++n}`
      continue
    }
    if ((c === '@' || c === ':' || c === '$') && /[A-Za-z_]/.test(sql[i + 1] ?? '') && !(c === ':' && sql[i - 1] === ':')) {
      const m = /^[@:$]([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i))!
      if (!named.has(m[1])) named.set(m[1], ++n)
      out += `$${named.get(m[1])}`; i += m[0].length - 1; continue
    }
    out += c
  }
  return out
}

// Modules that need the synchronous SQLite handle: they run raw queries or writes on it, or they get it
// (getAuthDb/getScanDb, called or passed on) for code that does. None of these can run on Postgres until it is ported to Db.
// Not counted:
//   - SQLite schema setup: a module whose only raw statements are the migrate*() DDL. The Postgres side of that
//     schema is lib/db/migrations/pg, and test/pg-schema-equivalence holds the two together.
//   - ENGINE_FILES (below).
export function rawSqliteModules(root: string): string[] {
  const out = new Set(sqlInventory(root).filter(s => s.api === 'raw' && (s.dynamic || !isSqliteAdmin(s.sql))).map(s => s.file))
  for (const f of sourceFiles(root)) {
    const src = readFileSync(f, 'utf8').replace(/^\s*import\b[^;]*?from\s*['"][^'"]+['"];?\s*$/gm, '')
    if (/\bget(Auth|Scan)Db\b/.test(src)) out.add(relative(root, f))
  }
  return [...out].filter(f => !ENGINE_FILES.has(f)).sort()
}

export interface PgFinding { site: SqlSite; error: string }
// PREPAREs every statically known, non-admin statement on a migrated Postgres schema (the caller's search_path), one
// connection, nothing executed. Returns the statements Postgres rejects.
export async function pgRejects(client: { query(sql: string): Promise<unknown> }, sites: SqlSite[]): Promise<PgFinding[]> {
  const out: PgFinding[] = []
  let i = 0
  for (const site of sites) {
    if (site.dynamic || isSqliteAdmin(site.sql)) continue
    const name = `dazl_audit_${i++}`
    try { await client.query(`PREPARE ${name} AS ${toPgParams(site.sql)}`); await client.query(`DEALLOCATE ${name}`) }
    catch (e) { out.push({ site, error: (e as Error).message }) }
  }
  return out
}

// The manifest lib/db/pg-port-status.ts holds: each raw module and how many of its statements Postgres rejects.
export function portStatus(raw: string[], rejects: PgFinding[]): Record<string, number> {
  const m: Record<string, number> = {}
  for (const f of raw) m[f] = 0
  for (const r of rejects) m[r.site.file] = (m[r.site.file] ?? 0) + 1
  return Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)))
}
