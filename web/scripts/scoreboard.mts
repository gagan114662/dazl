// Runs the fixed scoreboard searches (../scoreboard/searches.json) through the REAL scan pipeline on a throwaway
// in-memory database and scores every lead (lib/scan/scoreboard.ts). Costs real model calls on the supplied key.
//
//   SCOREBOARD_ANTHROPIC_KEY=sk-ant-...   required: the model key the scans run on (never printed or stored)
//   TINYFISH_API_KEY=...                  optional: TinyFish search/fetch (production's primary search backend)
//   SCOREBOARD_MAX_USD=0.75               optional: spend cap per search (default 0.75; applies only with TinyFish)
//   SCOREBOARD_ONLY=ohio-payroll,...      optional: run a subset
//
//   cd web && node --experimental-strip-types scripts/scoreboard.mts
//
// Writes ../scoreboard/results/<date>-<commit>.json and .md, and prints the markdown table.
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
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
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { scoreSearch, scoreboardMarkdown, type ScoredLeadInput, type SearchScore } from '../lib/scan/scoreboard.ts'

const key = process.env.SCOREBOARD_ANTHROPIC_KEY?.trim()
if (!key) { console.error('SCOREBOARD_ANTHROPIC_KEY is required'); process.exit(2) }
// The spend guard refuses the model's built-in web search (its result tokens are unbounded), and without TinyFish that
// is the only search path, so a capped run without TinyFish could never search. Cap only when TinyFish is on.
const maxUsd = process.env.TINYFISH_API_KEY ? Number(process.env.SCOREBOARD_MAX_USD || 0.75) : 0
if (!maxUsd) console.error('WARNING: no per-search spend cap (no TINYFISH_API_KEY, or SCOREBOARD_MAX_USD=0): scans use the model web search, uncapped')
const root = path.resolve(import.meta.dirname, '..', '..')
const searches = (JSON.parse(readFileSync(path.join(root, 'scoreboard', 'searches.json'), 'utf8')) as { id: string; query: string; seller?: string }[])
  .filter(s => !process.env.SCOREBOARD_ONLY || process.env.SCOREBOARD_ONLY.split(',').includes(s.id))

const master = randomBytes(32)
process.env.DAZL_MASTER_KEY = master.toString('base64') // enrichment resolves its key from env
const TENANT = 'scoreboard'
if (maxUsd > 0) process.env.DAZL_RUN_MAX_USD_USERS = `${TENANT}:${maxUsd}` // hard per-scan spend cap (runner.ownerMaxUsd)

const db = new Database(':memory:')
for (const m of [migrateScan, migrateKeys, migratePlans, migrateConnectors, migrateEvents, migrateTinyfish, migrateSourceStats, migrateSourceRuns, migrateMemory]) m(db)
saveKey(db, TENANT, 'anthropic', key, master)

const commit = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim() } catch { return 'unknown' } })()
const date = new Date().toISOString().slice(0, 10)
const rows: { id: string; search: string; status: string; error: string | null; seconds: number; score: SearchScore; leads: unknown[] }[] = []

for (const s of searches) {
  const t0 = Date.now()
  const id = createQueryJob(db, TENANT, { query: s.query, seller: s.seller })
  const job = claimKeyedJob(db, id)
  let status = 'not_claimed'; let error: string | null = null
  if (job) {
    try { status = await runJob(db, job, { master }) } catch (e) { status = 'crashed'; error = String((e as Error)?.message ?? e).slice(0, 120) }
  }
  const j = db.prepare('SELECT status, error FROM scan_jobs WHERE id = ?').get(id) as { status: string; error: string | null }
  error = error ?? j.error
  const raw = db.prepare('SELECT id, name, company, contact, review_reason, event_date, fit, signal, source_url FROM leads WHERE scan_job_id = ?').all(id) as (ScoredLeadInput & { id: string; company: string; signal: string; source_url: string })[]
  const contactsOf = db.prepare("SELECT value FROM lead_enrichments WHERE lead_id = ? AND kind = 'contact'")
  const leads = raw.map(l => ({ ...l, contacts: (contactsOf.all(l.id) as { value: string }[]).map(r => r.value) }))
  const score = scoreSearch(leads)
  rows.push({ id: s.id, search: s.id, status: `${status}/${j.status}`, error, seconds: Math.round((Date.now() - t0) / 1000), score, leads: leads.map(({ id: _id, ...l }) => l) })
  console.error(`${s.id}: ${j.status} ${error ?? ''} qualified=${score.qualified} leads=${score.leads} (${Math.round((Date.now() - t0) / 1000)}s)`)
}

const md = scoreboardMarkdown(rows, { commit, date })
const out = path.join(root, 'scoreboard', 'results')
mkdirSync(out, { recursive: true })
writeFileSync(path.join(out, `${date}-${commit}.json`), JSON.stringify({ commit, date, tinyfish: !!process.env.TINYFISH_API_KEY, maxUsdPerSearch: maxUsd, rows }, null, 2))
writeFileSync(path.join(out, `${date}-${commit}.md`), md)
console.log(md)
