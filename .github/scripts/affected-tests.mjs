#!/usr/bin/env node
// Gate 2 (Gagan, 2026-11-16): pull requests run only the tests affected by the changed files; the full suite runs after
// merge on main (post-merge-full in web-ci.yml). Prints a space-separated list of web/ test files (relative to web/).
// usage: node .github/scripts/affected-tests.mjs <base-sha> [head-sha]
// Rules: a changed runnable top-level test runs itself; other test-tree changes select ALL; a changed source file under web/ runs every test whose text imports or names
// its module (basename without extension); a change to shared plumbing (package files, test helpers, db schema/migrations,
// lib/db/*) prints ALL so the PR falls back to the full suite. Nothing affected prints NONE.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, basename, extname } from 'node:path'

const [base, head = 'HEAD'] = process.argv.slice(2)
if (!base) { console.error('usage: affected-tests.mjs <base-sha> [head-sha]'); process.exit(2) }
const changed = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', `${base}...${head}`], { encoding: 'utf8' }).split('\0').filter(Boolean)
const web = changed.filter(f => f.startsWith('web/')).map(f => f.slice(4))
const ALL = [/^package(-lock)?\.json$/, /^test\/helpers\//, /^lib\/db\//, /^migrations?\//, /schema/, /^tsconfig/]
if (web.some(f => ALL.some(r => r.test(f)))) { console.log('ALL'); process.exit(0) }
const testDir = 'web/test'
const tests = readdirSync(testDir).filter(f => /\.test\.(ts|mjs)$/.test(f))
const out = new Set()
for (const f of web) {
  if (f.startsWith('test/')) {
    // Only existing top-level tests are runnable shard entries. The text scan
    // below cannot prove a complete consumer set for fixtures, helpers or
    // runtime registries (including indirect imports and directory reads).
    // A textual hit is not sufficient to rule out another consumer.
    if (!tests.includes(f.slice('test/'.length))) { console.log('ALL'); process.exit(0) }
    out.add(f)
    continue
  }
  if (!/\.(ts|tsx|mts|mjs|js)$/.test(f)) continue
  const mod = basename(f, extname(f))
  if (mod === 'index' || mod.length < 3) { console.log('ALL'); process.exit(0) }
  const re = new RegExp(`[/'"]${mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.[a-z]+)?['"]`)
  for (const t of tests) if (re.test(readFileSync(join(testDir, t), 'utf8'))) out.add(`test/${t}`)
}
console.log(out.size ? [...out].sort().join(' ') : 'NONE')
