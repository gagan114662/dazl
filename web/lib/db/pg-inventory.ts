// What still assumes SQLite, as one generated list (docs/PG_INVENTORY.md, a snapshot that scripts/pg-migrate/inventory.mts
// writes; each port slice regenerates it). It reads the source statically, so it needs no database:
//   - modules: every module in lib/db/pg-port-status.ts (raw better-sqlite3 handle), its raw statement count, the
//     statements Postgres rejects (from the manifest, which test/pg-sql-audit.test.ts checks on a real PG), and the
//     SQLite-only SQL constructs found in its statements;
//   - locks: SQLite transaction and lock idioms that have no meaning on a pooled Postgres (better-sqlite3
//     transaction()/immediate(), busy_timeout, BEGIN IMMEDIATE), and the advisory locks already ported;
//   - process state: module-level Maps/Sets in lib/ and app/, which two web instances would not share;
//   - migrations: every sqlite migrate*() (each has a PG twin in lib/db/migrations/pg, held by pg-schema-equivalence);
//   - tests: test files that open a SQLite store and never run on Postgres.
import ts from 'typescript'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { sourceFiles, sqlInventory, isSqliteAdmin, ENGINE_FILES } from './sql-audit.ts'
import { RAW_SQLITE_MODULES } from './pg-port-status.ts'

// SQLite-only constructs. Each has a known Postgres replacement, named so the port is mechanical.
export const DIALECT: { id: string; re: RegExp; fix: string }[] = [
  { id: 'insert-or', re: /\b(INSERT\s+OR\s+(IGNORE|REPLACE)|REPLACE\s+INTO)\b/i, fix: 'INSERT … ON CONFLICT (key) DO NOTHING / DO UPDATE' },
  { id: 'strftime-now', re: /\b(strftime|julianday|unixepoch)\s*\(|\b(datetime|date|time)\s*\(\s*'now'/i, fix: 'bind the caller clock (Math.floor(Date.now()/1000)) as a parameter' },
  { id: 'rowid', re: /\b_?rowid_?\b/i, fix: 'an explicit insert_seq / id column (lib/db/insertion-order.ts)' },
  { id: 'sqlite_master', re: /\bsqlite_(master|schema)\b|\bPRAGMA\b/i, fix: 'schema lives in lib/db/migrations/pg; drop runtime schema probes' },
  { id: 'json1', re: /\bjson_(extract|each|group_array|group_object|set|insert|remove|type|valid|tree)\b/i, fix: 'jsonb operators (->, ->>) or decode in code' },
  { id: 'group_concat', re: /\bgroup_concat\s*\(/i, fix: 'string_agg(x, \',\')' },
  { id: 'ifnull', re: /\bifnull\s*\(/i, fix: 'COALESCE' },
  { id: 'glob', re: /\bGLOB\b/i, fix: 'LIKE / ~ (regex)' },
  { id: 'scalar-max-min', re: /\b(MAX|MIN)\s*\(\s*[^(),]*(\([^()]*\)[^(),]*)*,[^()]*\)/i, fix: 'GREATEST / LEAST' },
  { id: 'like-case', re: /\bLIKE\b/i, fix: 'SQLite LIKE ignores ASCII case, PG LIKE does not: use lower(x) LIKE lower(?) or ILIKE' },
  { id: 'changes', re: /\b(last_insert_rowid|changes)\s*\(\s*\)/i, fix: 'RETURNING / RunResult.changes' },
]

export const LOCKS: { id: string; re: RegExp; note: string }[] = [
  { id: 'sqlite-tx', re: /\.transaction\s*\(/, note: 'better-sqlite3 transaction (process-serial; on PG use db.tx and a row or advisory lock)' },
  { id: 'immediate', re: /\.(immediate|exclusive|deferred)\s*\(/, note: 'SQLite write lock taken up front' },
  { id: 'busy-timeout', re: /busy_timeout|\btimeout\s*:\s*\d{3,}/, note: 'file-lock wait' },
  { id: 'begin-immediate', re: /BEGIN\s+(IMMEDIATE|EXCLUSIVE)/i, note: 'explicit SQLite write lock' },
  { id: 'pg-advisory', re: /pg_(try_)?advisory_x?act_lock|pg_(try_)?advisory_lock/, note: 'already ported: Postgres advisory lock' },
]

// Every module-level Map/Set, reviewed: what it holds and whether two instances need to share it. A new one fails
// test/pg-inventory.test.ts until it is classified here.
export const STATE_NOTES: Record<string, { share: 'must share' | 'safe to lose' | 'constant' ; note: string }> = {
  'lib/connectors/sitecrawl.ts:lastHit': { share: 'safe to lose', note: 'per-host crawl politeness delay; each instance waits on its own' },
  'lib/llm/spend-guard.ts:pools': { share: 'must share', note: 'owner spend pool; resets on restart and differs per instance (#363)' },
  'lib/ops/emitted.ts:seen': { share: 'safe to lose', note: 'which bundles this build emitted' },
  'lib/outreach/reopen.ts:inFlight': { share: 'must share', note: 're-open sends running in this process; another instance cannot see them (row claim fences the send, this guards resolve)' },
  'lib/rate-limit.ts:local': { share: 'safe to lose', note: "per-process shadow, only for the low-risk 'local' kinds while the shared store fails; closed kinds refuse (#356, #400)" },
  'lib/scan/countries.ts:BY_NAME': { share: 'constant', note: 'filled once from a literal table' },
  'lib/scan/countries.ts:ALPHA3': { share: 'constant', note: 'filled once from a literal table' },
  'lib/scan/held-state.ts:inProcess': { share: 'must share', note: 'last-resort hold when no write succeeded; another instance would not see the hold' },
  'lib/sources/github.ts:cache': { share: 'safe to lose', note: 'response cache' },
  'lib/sources/jina.ts:cache': { share: 'safe to lose', note: 'response cache' },
  'lib/sources/v2ex.ts:cache': { share: 'safe to lose', note: 'response cache' },
  'lib/sources/youtube.ts:cache': { share: 'safe to lose', note: 'response cache' },
}

export interface ModuleRow { file: string; area: string; raw: number; rejected: number; dialect: string[]; locks: string[]; migrate: boolean }
export interface StateRow { file: string; line: number; name: string; kind: string }
export interface Inventory {
  modules: ModuleRow[]
  locks: { file: string; ids: string[] }[]
  state: StateRow[]
  migrations: string[]
  sqliteOnlyTests: string[]
  bothEngineTests: string[]
  totals: { statements: number; onDb: number; dynamic: number; raw: number; rejected: number }
}

// The product areas #354's acceptance names, by path. First match wins.
const AREAS: [RegExp, string][] = [
  [/auth|gmail\/(oauth|connect|callback|disconnect)|secrets-rewrap|llm\/key-store/, 'auth & keys'],
  [/billing|plans|checkout|stripe/, 'billing'],
  [/outreach\/(service|send|send-budget|ledger|autopilot|followups|sequences|attribution|conversion)|unsubscribe|app\/api\/outreach\/(route|\[id\]|autopilot|sequences|settings|conversion)/, 'sends'],
  [/replies|inbox|reopen|threads/, 'inbox'],
  [/outreach|crm/, 'drafts & CRM'],
  [/memory/, 'profile & memory'],
  [/enrich|people|find-contact|contact|sitecrawl|email-pattern|page-signals|hiring-feed|job-feed|qualify/, 'enrichment'],
  [/watch|monitor|competitor-reddit|tick/, 'monitors'],
  [/scan|leads|search\/|signals\/|advanced|lookalike|campaigns|connectors|events/, 'scans'],
  [/queue|lease|ops\/|health/, 'platform'],
]
export function areaOf(file: string): string { return AREAS.find(([re]) => re.test(file))?.[1] ?? 'other' }

function topLevelState(path: string, root: string): StateRow[] {
  const src = readFileSync(path, 'utf8')
  if (!/new (Map|Set|WeakMap)\b/.test(src)) return []
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out: StateRow[] = []
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue
    for (const d of st.declarationList.declarations) {
      let init = d.initializer
      while (init && (ts.isAsExpression(init) || ts.isParenthesizedExpression(init) || ts.isBinaryExpression(init))) {
        init = ts.isBinaryExpression(init) ? init.right : init.expression
      }
      if (init && ts.isNewExpression(init) && ts.isIdentifier(init.expression) && /^(Map|Set)$/.test(init.expression.text) && ts.isIdentifier(d.name)) {
        // A Map/Set built from initial entries is a lookup table, not state.
        if (init.arguments?.length) continue
        out.push({ file: relative(root, path), line: sf.getLineAndCharacterOfPosition(d.getStart()).line + 1, name: d.name.text, kind: init.expression.text })
      }
    }
  }
  return out
}

export function buildInventory(root: string): Inventory {
  const sites = sqlInventory(root)
  const files = sourceFiles(root)
  const src = new Map(files.map(f => [relative(root, f), readFileSync(f, 'utf8')]))
  const modules: ModuleRow[] = Object.entries(RAW_SQLITE_MODULES).map(([file, rejected]) => {
    const mine = sites.filter(s => s.file === file)
    const text = mine.map(s => s.sql).join('\n')
    const code = src.get(file) ?? ''
    return {
      file, area: areaOf(file), rejected,
      raw: mine.filter(s => s.api === 'raw' && !isSqliteAdmin(s.sql)).length,
      dialect: DIALECT.filter(d => d.re.test(text)).map(d => d.id),
      locks: LOCKS.filter(l => l.id !== 'pg-advisory' && l.re.test(code)).map(l => l.id),
      migrate: /export function migrate\w*\s*\(/.test(code),
    }
  })
  const locks = [...src].filter(([f]) => !ENGINE_FILES.has(f))
    .map(([file, code]) => ({ file, ids: LOCKS.filter(l => l.re.test(code)).map(l => l.id) }))
    .filter(r => r.ids.length)
  const state = files.flatMap(f => topLevelState(f, root))
  const migSrc = readFileSync(join(root, 'lib/db/sqlite-migrations.ts'), 'utf8')
  const migrations = [...migSrc.matchAll(/import \{ (migrate\w+|SqliteQueue) \} from '([^']+)'/g)].map(m => `${m[1]} (${m[2].replace(/^\.\.\//, 'lib/').replace(/^\.\//, 'lib/db/')})`)
  const testDir = join(root, 'test')
  const tests = readdirSync(testDir).filter(f => f.endsWith('.test.ts')).sort()
  const sqliteOnlyTests: string[] = [], bothEngineTests: string[] = []
  for (const t of tests) {
    const code = readFileSync(join(testDir, t), 'utf8')
    if (/engines\.ts|pg-test\.ts|DAZL_TEST_PG_URL|PG_URL/.test(code)) bothEngineTests.push(t)
    else if (/better-sqlite3|getAuthDb|getScanDb|getDb\b|DB_PATH|sqliteDb\(|tenant-route-db/.test(code)) sqliteOnlyTests.push(t)
  }
  return {
    modules, locks, state, migrations, sqliteOnlyTests, bothEngineTests,
    totals: {
      statements: sites.length, onDb: sites.filter(s => s.api === 'db').length, dynamic: sites.filter(s => s.dynamic).length,
      raw: modules.length, rejected: modules.reduce((n, m) => n + m.rejected, 0),
    },
  }
}

export function renderInventory(inv: Inventory): string {
  const L: string[] = []
  const t = inv.totals
  L.push('# What still assumes SQLite', '',
    'Snapshot generated by `cd web && node --experimental-strip-types scripts/pg-migrate/inventory.mts --write`; each port slice regenerates it. The gate itself is `web/lib/db/pg-port-status.ts`, held by `web/test/pg-sql-audit.test.ts`.',
    'Tracking: #354 (Postgres port). Gate: `web/lib/db/pg-port-status.ts` empty (docs/PLATFORM.md "Postgres cutover").', '',
    `- ${t.statements} SQL statements in lib/ and app/; ${t.onDb} already on the async Db layer; ${t.dynamic} built at runtime.`,
    `- **${t.raw} modules** still need the synchronous SQLite handle; **${t.rejected} of their statements** Postgres rejects as written.`,
    `- ${inv.locks.filter(l => l.ids.some(i => i !== 'pg-advisory')).length} modules use SQLite transaction or lock idioms; ${inv.state.length} module-level Maps/Sets hold per-process state.`,
    `- ${inv.sqliteOnlyTests.length} test files touch a store but run on SQLite only; ${inv.bothEngineTests.length} already run on both engines.`, '')
  L.push('## Modules on the raw SQLite handle', '', 'Dialect ids are explained under "SQLite-only SQL". `pg✗` = statements Postgres rejects today.', '')
  const areas = [...new Set(inv.modules.map(m => m.area))].sort()
  for (const a of areas) {
    const ms = inv.modules.filter(m => m.area === a)
    L.push(`### ${a} (${ms.length})`, '', '| module | raw stmts | pg✗ | SQLite-only SQL | locks | owns migrate |', '|---|---:|---:|---|---|---|')
    for (const m of ms) L.push(`| \`${m.file}\` | ${m.raw} | ${m.rejected || ''} | ${m.dialect.join(', ')} | ${m.locks.join(', ')} | ${m.migrate ? 'yes' : ''} |`)
    L.push('')
  }
  L.push('## SQLite-only SQL', '', '| id | matches | Postgres replacement |', '|---|---|---|')
  for (const d of DIALECT) L.push(`| ${d.id} | ${inv.modules.filter(m => m.dialect.includes(d.id)).length} modules | ${d.fix} |`)
  L.push('', '## Transactions and locks', '', '| module | idioms |', '|---|---|')
  for (const l of inv.locks) L.push(`| \`${l.file}\` | ${l.ids.join(', ')} |`)
  L.push('', LOCKS.map(l => `- \`${l.id}\`: ${l.note}`).join('\n'), '')
  L.push('## Per-process state (not shared between web instances)', '',
    'Module-level Maps/Sets. Each is either a cache that is safe to lose, or state that must move to the shared store before two instances serve one tenant.', '',
    '| where | name | share? | holds |', '|---|---|---|---|')
  for (const s of inv.state) {
    const n = STATE_NOTES[`${s.file}:${s.name}`]
    L.push(`| \`${s.file}:${s.line}\` | \`${s.name}\` (${s.kind}) | ${n?.share ?? '**unclassified**'} | ${n?.note ?? ''} |`)
  }
  L.push('', '## SQLite migrations', '', 'Each has a Postgres twin under `web/lib/db/migrations/pg`; `test/pg-schema-equivalence` holds them together. They stay until SQLite is retired.', '')
  for (const m of inv.migrations) L.push(`- ${m}`)
  L.push('', '## Tests that run on SQLite only', '', 'These open a SQLite store and never run on Postgres. A ported module moves its tests onto `test/helpers/engines.ts` (`bothEngines`).', '')
  for (const x of inv.sqliteOnlyTests) L.push(`- \`${x}\``)
  L.push('')
  return L.join('\n')
}
