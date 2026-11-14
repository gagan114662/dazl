// LOCAL location x category matrix (#1099 root cause 7): runs the matrix's 8 cases (default ../scorecard/matrix.json) through the
// REAL scan pipeline on this PC, against real search and fetch, on a throwaway in-memory store, and prints the table Hermes's
// staging matrix prints: candidates, leads, ready, named %, email %, dated %, location+category %, seconds, US$, PASS/FAIL.
// Measure BEFORE asking for review; every PR on the matrix lane shows before/after rows from this.
//
//   cd web && npm run matrix:local -- [--cases toronto-dental,berlin-fintech] [--dry] [--json] [--timeout 300]
//        [--cap 0.50] [--env-file ~/.config/hermes/dazl_matrix.env] [--matrix path/to/matrix.json] [--out dir]
//
// Keys (never printed, never stored; the in-memory store dies with the process). Same ones the staging scans use:
//   TINYFISH_API_KEY                         search and fetch; without it scans fall back to model web search, which no cap bounds: refused
//   MATRIX_ANTHROPIC_KEY                     the model key (then SCOREBOARD_ANTHROPIC_KEY, then DAZL_TRIAL_ANTHROPIC_KEY)
//   TINYFISH_SEARCHES_PER_SCAN, TINYFISH_FETCHES_PER_SCAN, SITECRAWL_ENABLED, NEWS_SEARCH_ENABLED, EMAIL_GUESS_ENABLED:
//                                            the staging knobs, so a local scan behaves like a staging scan
// --env-file reads KEY=VALUE lines into the environment (a value already in the environment wins).
// Cost cap: US$0.50 per case (--cap lowers it, never raises it above 0.50): the case's own run budget (max_usd), enforced
// by the scan spend ledger before every paid call; the table prints what each case really cost. Exit 0 always prints the
// table; exit 2 = not run (missing keys or matrix), 1 = a case crashed the runner itself.
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateEvents } from '../lib/events/store.ts'
import { migrateTinyfish } from '../lib/search/tinyfish.ts'
import { migrateSourceStats } from '../lib/search/trace.ts'
import { migrateSourceRuns } from '../lib/scan/source-runs.ts'
import { migrateMemory } from '../lib/memory.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { measureCase, verdict, matrixTable, type CaseResult, type MatrixCase, type MatrixThresholds } from './matrix-score.mts'

const argv = process.argv.slice(2)
const flag = (n: string) => argv.includes(`--${n}`)
const opt = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined }
const root = path.resolve(import.meta.dirname, '..', '..')
const expand = (p: string) => p.replace(/^~(?=\/|$)/, os.homedir())

// the env file: KEY=VALUE per line, # comments, optional quotes; values never printed
const envFile = opt('env-file') ?? process.env.MATRIX_ENV_FILE
if (envFile) {
  const p = expand(envFile)
  if (!existsSync(p)) { console.error(`--env-file ${p} does not exist. Not running.`); process.exit(2) }
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
}

const matrixPath = expand(opt('matrix') ?? process.env.MATRIX_FILE ?? path.join(root, '..', 'scorecard', 'matrix.json'))
if (!existsSync(matrixPath)) { console.error(`matrix file ${matrixPath} not found (set --matrix or MATRIX_FILE). Not running.`); process.exit(2) }
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8')) as { thresholds: MatrixThresholds; cases: MatrixCase[] }
const only = opt('cases')?.split(',').map(s => s.trim()).filter(Boolean)
const cases = matrix.cases.filter(c => !only || only.includes(c.id))
if (only) for (const id of only) if (!matrix.cases.some(c => c.id === id)) { console.error(`unknown case "${id}"; the matrix has: ${matrix.cases.map(c => c.id).join(', ')}`); process.exit(2) }
const HARD_CAP = 0.5   // the lane's cap per case; --cap can only lower it
const capReq = opt('cap') === undefined ? HARD_CAP : Number(opt('cap'))
if (!Number.isFinite(capReq) || capReq <= 0) { console.error('--cap must be a positive number of US dollars'); process.exit(2) }
const cap = Math.min(capReq, HARD_CAP, matrix.thresholds.per_case_confirm_cap_usd || HARD_CAP)
const timeoutS = Number(opt('timeout') ?? 300)
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
if (!anthropic) { console.error('No model key: set MATRIX_ANTHROPIC_KEY (or SCOREBOARD_ANTHROPIC_KEY / DAZL_TRIAL_ANTHROPIC_KEY), or pass --env-file. Not running.'); process.exit(2) }
if (!tinyfish) { console.error('TINYFISH_API_KEY is required: without it the scans use the model web search, which no cap can bound. Not running.'); process.exit(2) }

const master = randomBytes(32)
process.env.DAZL_MASTER_KEY = master.toString('base64')
const tenantOf = (c: MatrixCase) => `matrix-${c.id}`
// one owner pool per case, so one case's spend can never starve another's, and the run budget below caps the scan itself
process.env.DAZL_RUN_MAX_USD_USERS = cases.map(c => `${tenantOf(c)}:${cap}`).join(',')

const db = new Database(':memory:')
for (const m of [migrateScan, migrateKeys, migratePlans, migrateConnectors, migrateEvents, migrateTinyfish, migrateSourceStats, migrateSourceRuns, migrateMemory]) m(db)
for (const c of cases) saveKey(db, tenantOf(c), 'anthropic', anthropic, master)

const INCOMPLETE = new Set(['budget_stopped', 'scan_timeout', 'key_rejected', 'key_unreadable', 'no_api_key', 'accounting_uncertain'])
const results: CaseResult[] = []
let crashed = false
for (const c of cases) {
  const tenant = tenantOf(c), t0 = Date.now()
  const id = createQueryJob(db, tenant, { query: c.query, seller: c.seller, offer: c.offer ?? null, runBudget: JSON.stringify({ max_usd: cap }) })
  const job = claimKeyedJob(db, id)
  let error: string | null = null
  if (!job) error = 'not_claimed'
  else {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const outcome = await Promise.race([
        runJob(db, job, { master }).then(() => 'ran' as const),
        new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutS * 1000) }),
      ])
      if (outcome === 'timeout') error = 'scan_timeout'
    } catch (e) { error = `crashed: ${String((e as Error)?.message ?? e).slice(0, 120)}`; crashed = true }
    finally { if (timer) clearTimeout(timer) }
  }
  const j = db.prepare('SELECT status, error FROM scan_jobs WHERE id = ?').get(id) as { status: string; error: string | null }
  error = error ?? j.error
  const usdRow = db.prepare('SELECT round(sum(coalesce(actual_usd, reserve_usd)), 4) AS usd FROM scan_spend_calls WHERE scan_job_id = ?').get(id) as { usd: number | null } | undefined
  const m = measureCase(db, tenant, id, c)
  const v = verdict(m, thresholds)
  const incomplete = error !== null && (error.startsWith('crashed') || INCOMPLETE.has(error))
  const status = incomplete ? 'INCOMPLETE' : j.status
  results.push({ id: c.id, label: c.label, status, error, ...m, seconds: Math.round((Date.now() - t0) / 1000), usd: usdRow?.usd ?? 0, pass: v.pass && !incomplete, why: v.why })
  console.error(`${c.id}: ${status}${error ? ` (${error})` : ''} cand=${m.candidates} leads=${m.leads} ready=${m.ready} (${results[results.length - 1].seconds}s)`)
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
