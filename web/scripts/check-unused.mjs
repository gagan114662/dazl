#!/usr/bin/env node
// Repeatable unused-symbol check (#898). Runs the normal type check with noUnusedLocals/noUnusedParameters and fails on any
// unused local, import, private helper or parameter that is not listed in EXEMPT below.
// Fix a finding by removing the symbol, or (for a parameter whose position is part of a callback/API contract) by
// prefixing it with `_`. Never silence it with `void x`, a dummy read or a ts-ignore.
// Exemptions must be narrow (file + symbol) and say which tracked decision keeps the symbol.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const EXEMPT = [
  // An intended Postgres-translation guard that was never wired into the translator. Wiring it changes which schemas the
  // translator accepts, so it is a Postgres-rollout decision (#898 follow-up), not hygiene cleanup.
  { file: 'scripts/pg-migrate/translate-schema.ts', symbol: 'SQLITE_ONLY_CODE' },
]

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tsc = path.join(web, 'node_modules', 'typescript', 'bin', 'tsc')
const r = spawnSync(process.execPath, [...(process.env.CHECK_UNUSED_HEAP ? [`--max-old-space-size=${process.env.CHECK_UNUSED_HEAP}`] : []), tsc, '--noEmit', '--incremental', 'false', '--noUnusedLocals', '--noUnusedParameters', '-p', 'tsconfig.json'], { cwd: web, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
if (r.error || r.signal || r.status === null) { console.error(`tsc did not finish (${r.error?.message ?? r.signal ?? 'no exit status'})`); process.exit(1) }
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
const lines = out.split('\n').filter(Boolean)
const UNUSED = /^(.+?)\(\d+,\d+\): error TS(6133|6196|6192|6198|6205): '?([^' ]+)'?/
const findings = [], used = new Set(), other = []
for (const line of lines) {
  const m = line.match(UNUSED)
  if (!m) { if (/error TS\d+/.test(line)) other.push(line); continue }
  const ex = EXEMPT.findIndex(e => e.file === m[1] && e.symbol === m[3])
  if (ex >= 0) used.add(ex); else findings.push(line)
}
const stale = EXEMPT.filter((_, i) => !used.has(i))
if (other.length) console.error(`Type errors (fix these first; run npx tsc --noEmit):\n${other.join('\n')}`)
if (findings.length) console.error(`Unused symbols (${findings.length}):\n${findings.join('\n')}`)
if (stale.length) console.error(`Stale exemptions (the symbol is used or gone; remove the entry):\n${stale.map(e => `${e.file}: ${e.symbol}`).join('\n')}`)
if (r.status !== 0 && !findings.length && !other.length && !used.size) { console.error(out || `tsc exited ${r.status}`); process.exit(1) }
if (other.length || findings.length || stale.length) process.exit(1)
console.log(`check-unused: clean (${EXEMPT.length} documented exemption${EXEMPT.length === 1 ? '' : 's'})`)
