// LOCAL location x category matrix (#1099 root cause 7): runs the matrix's 8 cases (default ../scorecard/matrix.json) through the
// REAL scan pipeline on this PC, against real search and fetch, on a throwaway in-memory store, and prints a table of the same
// columns Hermes's staging matrix prints: candidates, leads, ready, named %, email %, dated %, place+category %, seconds, US$,
// PASS/FAIL. The DEFINITIONS differ in places (see the footer the table prints), so compare a local row with a local row: run it
// BEFORE a change and AFTER it, and show both in the PR.
//
//   cd web && npm run matrix:local -- [--cases toronto-dental,berlin-fintech] [--dry] [--json] [--timeout 300]
//        [--cap 0.50] [--env-file ~/.config/hermes/dazl_matrix.env] [--matrix path/to/matrix.json] [--out dir]
//
// Keys (never printed, never stored; the in-memory store dies with the process). Same ones the staging scans use:
//   TINYFISH_API_KEY                         search and fetch; without it scans fall back to model web search, which no cap bounds: refused
//   MATRIX_ANTHROPIC_KEY                     the model key (then SCOREBOARD_ANTHROPIC_KEY, then DAZL_TRIAL_ANTHROPIC_KEY)
//   TINYFISH_SEARCHES_PER_SCAN, TINYFISH_FETCHES_PER_SCAN, SITECRAWL_ENABLED, NEWS_SEARCH_ENABLED, EMAIL_GUESS_ENABLED and any
//   other scan knob: the staging values, so a local scan behaves like a staging scan
// --env-file reads KEY=VALUE lines into the environment BEFORE the pipeline loads (a non-empty value already in the environment wins).
// Cost cap: US$0.50 per case (--cap lowers it, never raises it): the case's own run budget (max_usd), enforced by the scan spend
// ledger before every paid call; the table prints what each case cost. TinyFish calls are priced at US$0 while dazl's own daily
// counters stay inside TinyFish's free allowance, so the US$ column leaves TinyFish out (the table says so).
// Exit 0 prints the table; exit 2 = not run (missing keys, bad flags or matrix); exit 1 = a case crashed the runner itself.
import { randomBytes } from 'node:crypto'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CaseResult, MatrixCase, MatrixThresholds } from './matrix-score.mts'
import { parseEnvFile } from './matrix-env.mts'   // no pipeline import: the env file is read before the pipeline loads

const argv = process.argv.slice(2)
const flag = (n: string) => argv.includes(`--${n}`)
const opt = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined }
const root = path.resolve(import.meta.dirname, '..', '..')
const expand = (p: string) => p.replace(/^~(?=\/|$)/, os.homedir())
const refuse = (msg: string): never => { console.error(msg); process.exit(2) }

const envFile = opt('env-file') ?? process.env.MATRIX_ENV_FILE
if (envFile) {
  const p = expand(envFile)
  if (!existsSync(p)) refuse(`--env-file ${p} does not exist. Not running.`)
  for (const [k, v] of Object.entries(parseEnvFile(readFileSync(p, 'utf8')))) if (!process.env[k]) process.env[k] = v
}

const matrixPath = expand(opt('matrix') ?? process.env.MATRIX_FILE ?? path.join(root, '..', 'scorecard', 'matrix.json'))
if (!existsSync(matrixPath)) refuse(`matrix file ${matrixPath} not found (set --matrix or MATRIX_FILE). Not running.`)
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8')) as { thresholds: MatrixThresholds; cases: MatrixCase[] }
const only = opt('cases')?.split(',').map(s => s.trim()).filter(Boolean)
const cases = matrix.cases.filter(c => !only || only.includes(c.id))
if (only) for (const id of only) if (!matrix.cases.some(c => c.id === id)) refuse(`unknown case "${id}"; the matrix has: ${matrix.cases.map(c => c.id).join(', ')}`)
if (cases.length === 0) refuse('no cases to run. Not running.')
const HARD_CAP = 0.5   // the lane's cap per case; --cap and the matrix file can only lower it
const capReq = opt('cap') === undefined ? HARD_CAP : Number(opt('cap'))
const fileCap = Number(matrix.thresholds?.per_case_confirm_cap_usd ?? HARD_CAP)
const cap = Math.min(capReq, fileCap, HARD_CAP)
if (!(cap > 0 && cap <= HARD_CAP)) refuse(`the per-case cap must be a number above 0 and at most US$${HARD_CAP} (--cap ${opt('cap') ?? '-'}, matrix file ${matrix.thresholds?.per_case_confirm_cap_usd ?? '-'}). Not running.`)
const timeoutS = Number(opt('timeout') ?? 300)
if (!Number.isFinite(timeoutS) || timeoutS <= 0) refuse('--timeout must be a number of seconds above 0. Not running.')
const thresholds: MatrixThresholds = { ...matrix.thresholds, per_case_confirm_cap_usd: cap }

const anthropic = (process.env.MATRIX_ANTHROPIC_KEY || process.env.SCOREBOARD_ANTHROPIC_KEY || process.env.DAZL_TRIAL_ANTHROPIC_KEY || '').trim()
const tinyfish = (process.env.TINYFISH_API_KEY || '').trim()
const commit = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim() } catch { return 'unknown' } })()
const date = new Date().toISOString().slice(0, 16).replace('T', ' ')

if (flag('dry')) {
  // no network, no model call, nothing created: the plan and what is missing
  console.log(`matrix:local --dry @ ${commit}: ${cases.length} case(s) from ${matrixPath}, cap US$${cap.toFixed(2)} each (total at most US$${(cap * cases.length).toFixed(2)}), timeout ${timeoutS}s each`)
  for (const c of cases) console.log(`  ${c.id.padEnd(24)} ${c.query}`)
  const knobs = ['TINYFISH_SEARCHES_PER_SCAN', 'TINYFISH_FETCHES_PER_SCAN', 'SITECRAWL_ENABLED', 'NEWS_SEARCH_ENABLED', 'EMAIL_GUESS_ENABLED']
  console.log(`keys: TINYFISH_API_KEY ${tinyfish ? 'set' : 'MISSING'}; Anthropic key ${anthropic ? 'set' : 'MISSING'} (MATRIX_ANTHROPIC_KEY / SCOREBOARD_ANTHROPIC_KEY / DAZL_TRIAL_ANTHROPIC_KEY)`)
  console.log(`staging knobs: ${knobs.map(k => `${k}=${process.env[k] === undefined ? 'unset' : 'set'}`).join(' ')}`)
  process.exit(anthropic && tinyfish ? 0 : 2)
}
if (!anthropic) refuse('No model key: set MATRIX_ANTHROPIC_KEY (or SCOREBOARD_ANTHROPIC_KEY / DAZL_TRIAL_ANTHROPIC_KEY), or pass --env-file. Not running.')
if (!tinyfish) refuse('TINYFISH_API_KEY is required: without it the scans use the model web search, which no cap can bound. Not running.')

// the pipeline loads only now, so knobs read at import time (timeouts, crawl budgets, scan age) see the env file
const master = randomBytes(32)
process.env.DAZL_MASTER_KEY = master.toString('base64')
const { default: Database } = await import('better-sqlite3')
const { migrateAllSqlite } = await import('../lib/db/sqlite-migrations.ts')
const { saveKey } = await import('../lib/llm/key-store.ts')
const { runCase } = await import('./matrix-run.mts')
const { matrixTable } = await import('./matrix-score.mts')

const db = new Database(':memory:')
migrateAllSqlite(db)   // every table the app's own scan store has, so no pipeline step fails on a missing table
const tenantOf = (c: MatrixCase) => `matrix-${c.id}`
for (const c of cases) saveKey(db, tenantOf(c), 'anthropic', anthropic, master)

const results: CaseResult[] = []
let crashed = false
for (const c of cases) {
  const r = await runCase(db, c, { tenant: tenantOf(c), cap, timeoutS, thresholds, deps: { master } })
  if (r.error?.startsWith('crashed')) crashed = true
  results.push(r)
  console.error(`${c.id}: ${r.status}${r.error ? ` (${r.error})` : ''} cand=${r.candidates} leads=${r.leads} ready=${r.ready} usd=${r.usd?.toFixed(3)} (${r.seconds}s)`)
}

const table = matrixTable(results, thresholds, { commit, date })
const outDir = path.resolve(expand(opt('out') ?? process.env.MATRIX_OUT ?? path.join(root, '..', 'matrix-local-results')))
mkdirSync(outDir, { recursive: true })
const stamp = `${new Date().toISOString().slice(0, 10)}-${commit}-${Date.now().toString(36)}`
writeFileSync(path.join(outDir, `${stamp}.txt`), table + '\n')
if (flag('json')) writeFileSync(path.join(outDir, `${stamp}.json`), JSON.stringify({ commit, date, cap_usd: cap, thresholds, results }, null, 2))
console.log(table)
console.error(`written: ${path.join(outDir, `${stamp}.txt`)}`)
process.exit(crashed ? 1 : 0)
