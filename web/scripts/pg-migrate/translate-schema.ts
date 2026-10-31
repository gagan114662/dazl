// Mechanical SQLite DDL -> Postgres DDL translator. FAILS CLOSED: any
// construct it does not know how to translate - including tokens inside string
// literals and any column type other than TEXT/INTEGER - aborts the whole
// translation. A silent or guessed translation is worse than none.
//
// Semantic choices (reviewed):
//  - INTEGER -> BIGINT: epoch seconds overflow int4 in 2038. Numeric JS policy
//    lives in lib/db/leads-read-pg.ts (explicit safe-integer coercion).
//  - epoch defaults: floor(extract(epoch from now())): PG numeric->bigint CAST
//    ROUNDS; sqlite strftime('%s') TRUNCATES. floor() removes the +/-1s drift.
//  - sqlite LIKE is ASCII case-INSENSITIVE by default; PG LIKE is sensitive.
//    CHECK-level LIKE patterns are translated to lower(x) LIKE lower('pat')
//    to preserve sqlite semantics.
// Input: sqlite_master dump from extract-schema.ts (authoritative CODE schema -
// NOT proven equal to the production DB's actual schema; that needs an
// authorized production schema read).
import { readFileSync, writeFileSync } from 'node:fs'

const src = readFileSync(process.env.SQLITE_SCHEMA || '/tmp/full-schema.sql', 'utf8')
const out = process.env.PG_SCHEMA_OUT || '/tmp/full-schema-pg.sql'

// Insertion order (lib/db/insertion-order.ts): SQLite stamps insert_seq from an AFTER INSERT trigger; Postgres gets the
// same column with a sequence default instead. Only this exact trigger shape is recognised; the table names must agree.
const seqRe = /CREATE TRIGGER (?:IF NOT EXISTS )?(\w+)_insert_seq\s+AFTER INSERT ON (\w+)\s+WHEN NEW\.insert_seq IS NULL\s+BEGIN UPDATE (\w+) SET insert_seq = \(SELECT coalesce\(max\(insert_seq\), 0\) \+ 1 FROM (\w+)\) WHERE rowid = NEW\.rowid; END;/g
const seqTables: string[] = []
const srcNoSeq = src.replace(seqRe, (_m, name, table, upd, from) => {
  if (name !== table || upd !== table || from !== table) throw new Error(`insert_seq trigger ${name}_insert_seq names other tables`)
  seqTables.push(table as string)
  return ''
})
const seqName = (t: string) => `${t}_insert_seq_seq`

// Split: triggers contain semicolons inside BEGIN...END, so pull them out first.
// WHEN is optional: a guard without one (immutable / append-only tables) always aborts.
const triggerRe = /CREATE TRIGGER (?:IF NOT EXISTS )?(\w+)\s+BEFORE (INSERT|DELETE|UPDATE(?: OF \w+)?) ON (\w+)\s+(?:WHEN ([\s\S]*?)\s+)?BEGIN SELECT RAISE\(ABORT, '([^']*)'\); END;/g
const triggers: { name: string; event: string; table: string; when: string; msg: string }[] = []
const rest = srcNoSeq.replace(triggerRe, (_m, name, event, table, when, msg) => {
  triggers.push({ name, event, table: table as string, when: (when as string | undefined) ?? 'TRUE', msg: msg as string })
  return ''
})
if (/CREATE TRIGGER/i.test(rest)) throw new Error('untranslated trigger shape remains - extend the translator')

// Split a statement into code and string-literal segments ('' escape aware).
function segments(s: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = []
  let i = 0, cur = '', code = true
  while (i < s.length) {
    const ch = s[i]
    if (code && ch === "'") { out.push({ code: true, text: cur }); cur = "'"; code = false; i++; continue }
    if (!code && ch === "'") {
      if (s[i + 1] === "'") { cur += "''"; i += 2; continue }
      out.push({ code: false, text: cur + "'" }); cur = ''; code = true; i++; continue
    }
    cur += ch; i++
  }
  if (!code) throw new Error('unterminated string literal in: ' + s.slice(0, 80))
  if (cur) out.push({ code: true, text: cur })
  return out
}

const LITERAL_TOKENS = /unixepoch|strftime|\blength\(|AUTOINCREMENT|\bINTEGER\b|\bREAL\b|\bBLOB\b/i
const SQLITE_ONLY_CODE = /unixepoch|strftime|AUTOINCREMENT|\bRAISE\(|PRAGMA|json_extract|json_set|randomblob|zeroblob|\bGLOB\b|\bsoundex\(|\bjulianday\(|\bhex\(|\bquote\(|(?<!extract\(epoch from )\bnow\(\) *AS INTEGER/i
const KNOWN_TYPES = /^(TEXT|INTEGER|REAL)\b/

const stmts = rest.split(/;\s*\n/).map(s => s.trim()).filter(Boolean)
const translated: string[] = []

for (const raw of stmts) {
  // Fail closed on column types outside the known map (CREATE TABLE only):
  // split the body on top-level commas, take name+type from each column piece.
  if (/^CREATE TABLE/.test(raw)) {
    const body = raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')'))
    const pieces: string[] = []
    let depth = 0, cur = ''
    for (const ch of body) {
      if (ch === '(') depth++
      if (ch === ')') depth--
      if (ch === ',' && depth === 0) { pieces.push(cur); cur = ''; continue }
      cur += ch
    }
    if (cur.trim()) pieces.push(cur)
    for (const piece of pieces) {
      const line = piece.trim()
      if (/^(PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK|CONSTRAINT)[\s(]/i.test(line)) continue
      const m = line.match(/^(\w+)\s+([A-Za-z]+)/)
      if (!m) throw new Error(`unparsed column piece: ${line.slice(0, 60)}`)
      if (!KNOWN_TYPES.test(m[2].toUpperCase())) throw new Error(`unsupported column type '${m[2]}' on column '${m[1]}' - extend the type map deliberately`)
    }
  }
  // sqlite CHECK-level LIKE is case-insensitive; preserve with lower() both sides.
  // Epoch functions: patterns include their quoted args, so they are replaced
  // on the raw statement BEFORE literal segmentation.
  let s = raw.replace(/(\w+) LIKE ('[^']*')/gi, 'lower($1) LIKE lower($2)')
  s = s.replace(/CAST\(strftime\('%s','now'\) AS INTEGER\)/g, 'CAST(floor(extract(epoch from now())) AS BIGINT)')
  s = s.replace(/CAST\(strftime\('%s','now'\) AS ([A-Z]+)\)/g, "CAST(floor(extract(epoch from now())) AS $1)")
  s = s.replace(/strftime\('%s','now'\)/g, 'floor(extract(epoch from now()))')
  s = s.replace(/unixepoch\(\)/g, 'floor(extract(epoch from now()))')
  // sqlite length(CAST(x AS BLOB)) counts bytes, which is PG octet_length.
  s = s.replace(/\blength\(CAST\((\w+) AS BLOB\)\)/g, 'octet_length($1)')
  const segs = segments(s)
  const rebuilt = segs.map(seg => {
    if (!seg.code) {
      if (LITERAL_TOKENS.test(seg.text)) throw new Error(`sqlite-only token inside string literal ${seg.text.slice(0, 50)} - refusing to guess`)
      return seg.text
    }
    let t = seg.text
    t = t.replace(/\blength\(/g, 'char_length(')
    // sqlite INTEGER PRIMARY KEY is the auto-assigned rowid; PG needs an identity column for the same insert behaviour.
    t = t.replace(/\bINTEGER PRIMARY KEY\b/g, 'BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY')
    t = t.replace(/\bINTEGER\b/g, 'BIGINT')
    // sqlite REAL is an 8-byte IEEE float.
    t = t.replace(/\bREAL\b/g, 'DOUBLE PRECISION')
    const tm = raw.match(/^CREATE TABLE (?:IF NOT EXISTS )?(\w+)/)
    if (tm && /\binsert_seq BIGINT\b/.test(t)) {
      if (!seqTables.includes(tm[1])) throw new Error(`${tm[1]}.insert_seq has no insert_seq trigger to translate`)
      t = t.replace(/\binsert_seq BIGINT\b/, `insert_seq BIGINT DEFAULT nextval('${seqName(tm[1])}')`)
    }
    const bad = t.match(/unixepoch|strftime|AUTOINCREMENT|\bRAISE\(|PRAGMA|json_extract|json_set|randomblob|zeroblob|\bGLOB\b|\bsoundex\(|\bjulianday\(|\bhex\(|\bquote\(/i)
    if (bad) throw new Error(`untranslatable token '${bad[0]}' survives in: ${seg.text.slice(0, 80)}`)
    return t
  }).join('')
  translated.push(rebuilt)
}

// FK-aware ordering: PG requires the referenced table to exist first.
const isTable = (st: string) => /^CREATE TABLE/.test(st)
const tableName = (st: string) => st.match(/^CREATE TABLE (?:IF NOT EXISTS )?(\w+)/)![1]
const refs = (st: string) => [...st.matchAll(/REFERENCES (\w+)/g)].map(m => m[1])
const tableStmts = translated.filter(isTable)
const otherStmts = translated.filter(st => !isTable(st))
const remaining = new Map(tableStmts.map(st => [tableName(st), st]))
const ordered: string[] = []
let progress = true
while (remaining.size && progress) {
  progress = false
  for (const [name, st] of [...remaining]) {
    if (refs(st).every(r => !remaining.has(r) || r === name)) { ordered.push(st); remaining.delete(name); progress = true }
  }
}
if (remaining.size) throw new Error('FK cycle or missing table among: ' + [...remaining.keys()].join(', '))
for (const t of seqTables) if (!ordered.some(st => tableName(st) === t && st.includes(`nextval('${seqName(t)}')`))) throw new Error(`insert_seq trigger on ${t}, but no insert_seq column`)
// Sequences before the tables whose defaults use them; owned by their column, so dropping the table drops them.
const seqCreate = seqTables.map(t => `CREATE SEQUENCE IF NOT EXISTS ${seqName(t)}`)
const seqOwned = seqTables.map(t => `ALTER SEQUENCE ${seqName(t)} OWNED BY ${t}.insert_seq`)
const finalStmts = [...seqCreate, ...ordered, ...seqOwned, ...otherStmts]

// Triggers -> PG functions. WHEN clause becomes an IF guard in the body so
// subqueries (leads_only_while_running) are legal, which PG trigger WHEN
// clauses do not allow.
const pgTriggers: string[] = []
for (const t of triggers) {
  const cond = t.when.replace(/\bIS NOT\b/g, 'IS DISTINCT FROM')
    .replace(/CAST\(strftime\('%s','now'\) AS INTEGER\)/g, 'CAST(floor(extract(epoch from now())) AS BIGINT)')
  if (/strftime|unixepoch|RAISE\(/i.test(cond)) throw new Error(`untranslated token in trigger ${t.name} WHEN clause`)
  // A BEFORE DELETE trigger that returns NULL silently skips the delete in PG, so it must return OLD.
  const ret = t.event === 'DELETE' ? 'OLD' : 'NEW'
  const ev = t.event.startsWith('UPDATE OF') ? `UPDATE OF ${t.event.slice(10)}` : t.event
  pgTriggers.push(`
CREATE OR REPLACE FUNCTION dazl_guard_${t.name}() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (${cond}) THEN RAISE EXCEPTION '${t.msg}'; END IF;
  RETURN ${ret};
END $$;
DROP TRIGGER IF EXISTS ${t.name} ON ${t.table};
CREATE TRIGGER ${t.name} BEFORE ${ev} ON ${t.table} FOR EACH ROW EXECUTE FUNCTION dazl_guard_${t.name}();`)
}

// PG only: row triggers never see TRUNCATE, so a table whose rows may never be deleted outside its own guard also
// refuses TRUNCATE with a statement trigger (SQLite has no TRUNCATE). Listed by name, so no existing table changes.
const NO_TRUNCATE = ['audit_events']
for (const table of NO_TRUNCATE) {
  if (!triggers.some(t => t.table === table && t.event === 'DELETE')) throw new Error(`NO_TRUNCATE lists ${table}, which has no delete guard`)
  pgTriggers.push(`
CREATE OR REPLACE FUNCTION dazl_guard_${table}_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '${triggers.find(t => t.table === table && t.event === 'DELETE')!.msg}';
END $$;
DROP TRIGGER IF EXISTS ${table}_no_truncate ON ${table};
CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION dazl_guard_${table}_no_truncate();`)
}

// Target-identity guard INSIDE the generated file: refuses any database that
// is not a provisioned dazl_rehearse_* target with the ownership marker table.
// The TS runner additionally checks the marker token; this DO block is the
// last line of defense when the file is applied by hand.
const guard = `DO $guard$
BEGIN
  IF current_database() NOT LIKE 'dazl\\_rehearse\\_%' THEN
    RAISE EXCEPTION 'rehearsal schema refused: database % is not a dazl_rehearse_* target', current_database();
  END IF;
  IF to_regclass('dazl_rehearse_meta') IS NULL THEN
    RAISE EXCEPTION 'rehearsal schema refused: ownership marker table dazl_rehearse_meta is missing';
  END IF;
END $guard$;

`
const tables = finalStmts.filter(isTable).map(tableName)
const header = `-- GENERATED by translate-schema.ts from the app's own sqlite migrations.
-- ${tables.length} tables, ${otherStmts.length} indexes, ${triggers.length + NO_TRUNCATE.length} triggers, ${seqTables.length} insertion-order sequences.
-- Type mapping: INTEGER -> BIGINT (epoch seconds overflow int4 in 2038).
-- Defaults: floor(extract(epoch from now())) - PG rounds, sqlite truncates.
-- CHECK LIKE translated to lower() both sides - sqlite LIKE is ASCII case-insensitive.
` + guard
const drop = `DROP TABLE IF EXISTS ${tables.join(', ')} CASCADE;\n\n`
writeFileSync(out, header + drop + finalStmts.join(';\n\n') + ';\n' + pgTriggers.join('\n') + '\n')

// Baseline migration body for the app's PG migration runner (lib/db/migrate-pg.ts): the same translated DDL with no
// rehearsal guard and no DROP. Written only when PG_MIGRATION_OUT is set; the drift test compares it with
// lib/db/migrations/pg/0001_baseline.sql.
if (process.env.PG_MIGRATION_OUT) {
  writeFileSync(process.env.PG_MIGRATION_OUT, `-- GENERATED by translate-schema.ts (PG_MIGRATION_OUT): baseline of the app's sqlite migrations.
-- ${tables.length} tables, ${otherStmts.length} indexes, ${triggers.length + NO_TRUNCATE.length} triggers, ${seqTables.length} insertion-order sequences. Do not edit; regenerate.
` + finalStmts.join(';\n\n') + ';\n' + pgTriggers.join('\n') + '\n')
}

// Slice subset for the pg-mem contract test: the leads-read tables and their
// indexes, same translated types/defaults as the full file. No guard, no DROP -
// pg-mem is in-memory and does not run plpgsql DO blocks.
const SLICE = ['scan_jobs', 'leads', 'outreach_messages', 'sequences', 'sequence_steps', 'sequence_settings', 'lead_enrichments', 'company_events', 'suppressions', 'inbound_messages']
const sliceStmts = finalStmts.filter(st => {
  const sq = st.match(/^CREATE SEQUENCE IF NOT EXISTS (\w+)_insert_seq_seq$/)
  if (sq) return SLICE.includes(sq[1])
  const tm = st.match(/^CREATE TABLE (\w+)/)
  if (tm) return SLICE.includes(tm[1])
  const im = st.match(/^CREATE (?:UNIQUE )?INDEX \w+ ON (\w+)/)
  if (im) return SLICE.includes(im[1])
  return false
})
const sliceOut = process.env.PG_SLICE_SCHEMA_OUT || '/tmp/slice-schema.sql'
writeFileSync(sliceOut, `-- GENERATED by translate-schema.ts: leads-read slice subset of schema-full.generated.sql.\n-- Same types/defaults/checks as the full translation (BIGINT numerics, floor epoch defaults, lower() LIKE).\n-- No guard/DROP: pg-mem contract-test use (in-memory). Live application must use schema-full.generated.sql.\n\n` + sliceStmts.join(';\n\n') + ';\n')
console.log(`translated: ${finalStmts.length} statements (${tables.length} tables), ${triggers.length} triggers -> functions; slice subset: ${sliceStmts.length} statements`)
