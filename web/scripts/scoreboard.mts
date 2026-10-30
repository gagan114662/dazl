// Runs the fixed scoreboard searches (../scoreboard/searches.json) through the REAL scan pipeline on a throwaway
// in-memory database and scores every lead (lib/scan/scoreboard.ts). Costs real model calls on the supplied key.
//
//   SCOREBOARD_ANTHROPIC_KEY=sk-ant-...   required: the model key the scans run on (never printed or stored)
//   TINYFISH_API_KEY=...                  required: without it scans fall back to the model's web search, which the
//                                         spend guard cannot bound, so the run refuses to start
//   SCOREBOARD_MAX_USD_TOTAL=3            optional: ONE budget for the whole run, shared by all searches (default 3)
//   SCOREBOARD_ONLY=ohio-payroll,...      optional: run a subset
//
//   cd web && node --experimental-strip-types scripts/scoreboard.mts
//
// Writes ../scoreboard/results/<date>-<commit>.{json,md} (gitignored: results hold lead and contact data) and prints
// the markdown table. A search stopped by the budget is reported as INCOMPLETE, never as zero leads.
import Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
import { companyKey } from '../lib/scan/evidence.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { scoreJob, scoreboardMarkdown, SCOREBOARD_RUBRIC, type SearchScore } from '../lib/scan/scoreboard.ts'
import { scoreboardInputs } from '../lib/scan/actionable.ts'

const key = process.env.SCOREBOARD_ANTHROPIC_KEY?.trim()
if (!key) { console.error('SCOREBOARD_ANTHROPIC_KEY is required'); process.exit(2) }
if (!process.env.TINYFISH_API_KEY?.trim()) { console.error('TINYFISH_API_KEY is required: without it the scans use the model web search, which no budget can bound. Not running.'); process.exit(2) }
const totalUsd = Number(process.env.SCOREBOARD_MAX_USD_TOTAL || 3)
if (!Number.isFinite(totalUsd) || totalUsd <= 0) { console.error('SCOREBOARD_MAX_USD_TOTAL must be a positive number'); process.exit(2) }
const root = path.resolve(import.meta.dirname, '..', '..')
const searches = (JSON.parse(readFileSync(path.join(root, 'scoreboard', 'searches.json'), 'utf8')) as { id: string; query: string; seller?: string }[])
  .filter(s => !process.env.SCOREBOARD_ONLY || process.env.SCOREBOARD_ONLY.split(',').includes(s.id))

const master = randomBytes(32)
process.env.DAZL_MASTER_KEY = master.toString('base64') // enrichment resolves its key from env
const TENANT = 'scoreboard'
// One spend pool per owner per process (llm/spend-guard ownerPool): this is the WHOLE run's budget, not per search.
process.env.DAZL_RUN_MAX_USD_USERS = `${TENANT}:${totalUsd}`

const db = new Database(':memory:')
for (const m of [migrateScan, migrateKeys, migratePlans, migrateConnectors, migrateEvents, migrateTinyfish, migrateSourceStats, migrateSourceRuns, migrateMemory]) m(db)
saveKey(db, TENANT, 'anthropic', key, master)

const commit = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim() } catch { return 'unknown' } })()
const date = new Date().toISOString().slice(0, 10)
// Pin what the grade means: the model that grades and a hash of the grading code (rubric, prompt, gates).
const model = process.env.DAZL_ANTHROPIC_MODEL || 'claude-sonnet-4-5'
const rubric = createHash('sha256').update(readFileSync(path.join(root, 'web', 'lib', 'scan', 'score.ts'))).digest('hex').slice(0, 12)
const INCOMPLETE = new Set(['budget_stopped', 'scan_timeout', 'key_rejected', 'key_unreadable', 'no_api_key'])
const rows: { id: string; search: string; status: string; error: string | null; complete: boolean; seconds: number; score: SearchScore; leads: unknown[] }[] = []
const qualifiedCompanies = new Set<string>()

for (const s of searches) {
  const t0 = Date.now()
  const id = createQueryJob(db, TENANT, { query: s.query, seller: s.seller })
  const job = claimKeyedJob(db, id)
  let error: string | null = null
  if (job) {
    try { await runJob(db, job, { master }) } catch (e) { error = `crashed: ${String((e as Error)?.message ?? e).slice(0, 120)}` }
  }
  const j = db.prepare('SELECT status, error FROM scan_jobs WHERE id = ?').get(id) as { status: string; error: string | null }
  error = error ?? j.error
  const complete = !error?.startsWith('crashed') && !INCOMPLETE.has(j.error ?? '') && j.status !== 'pending' && j.status !== 'running'
  const jobRow = db.prepare('SELECT id, user_id, query, icp FROM scan_jobs WHERE id = ?').get(id) as { id: string; user_id: string; query: string | null; icp: string | null }
  const { score, leads } = scoreJob(scoreboardInputs(db, jobRow), jobRow)   // qualified = the product's own actionable gates (#378)
  for (const l of leads) if (l.qualified) qualifiedCompanies.add(companyKey(l.company))
  const status = complete ? j.status : 'INCOMPLETE'
  rows.push({ id: s.id, search: s.id, status, error, complete, seconds: Math.round((Date.now() - t0) / 1000), score, leads: leads.map(({ lead_id: _id, ...l }) => l) })
  console.error(`${s.id}: ${status} ${error ?? ''} qualified=${score.qualified} leads=${score.leads} (${rows[rows.length - 1].seconds}s)`)
}

const md = scoreboardMarkdown(rows, { commit, date, model, rubric, uniqueQualified: qualifiedCompanies.size, budgetUsd: totalUsd })
const out = path.join(root, 'scoreboard', 'results')
mkdirSync(out, { recursive: true })
writeFileSync(path.join(out, `${date}-${commit}.json`), JSON.stringify({ commit, date, model, rubric, qualification: SCOREBOARD_RUBRIC, budgetUsdTotal: totalUsd, uniqueQualifiedCompanies: qualifiedCompanies.size, rows }, null, 2))
writeFileSync(path.join(out, `${date}-${commit}.md`), md)
console.log(md)
