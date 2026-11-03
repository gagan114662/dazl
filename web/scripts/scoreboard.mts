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
import { scoreLeadV2, scoreSearchV2, scoreboardMarkdownV2, RUBRIC_VERSION, type RouteInput, type ScoredLeadInputV2, type SearchScoreV2 } from '../lib/scan/scoreboard.ts'
import { requiredGateHeld } from '../lib/scan/held-state.ts'
import { getMemory, isExcluded } from '../lib/memory.ts'
import { whoOf, personMatchesRole, NOT_A_FOUNDER_ROUTE } from '../lib/scan/actionable.ts'
import { parseWindowDays } from '../lib/scan/window.ts'
import { TIMING_REQUESTED } from '../lib/scan/scoreboard.ts'

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
const rows: { id: string; search: string; status: string; error: string | null; complete: boolean; seconds: number; score: SearchScoreV2; window_days: number | null; timing_required: boolean; leads: unknown[] }[] = []
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
  // V2 rubric (#377/#378): the counters below use the SAME gates as the live actionable path
  // (lib/scan/actionable.ts): buyer gates first (quarantined / excluded / held / fit), a crawl-confirmed
  // domain, a role-matched person and a company-published route from sitecrawl enrichments. Timing is
  // proof-backed only (event_date_proof); a requested window makes timing mandatory. Eligibility is
  // never guessed here: it stays unknown and is reported, not counted.
  const jobRow = db.prepare('SELECT query, icp FROM scan_jobs WHERE id = ?').get(id) as { query: string | null; icp: string | null }
  const who = whoOf(jobRow.icp) || 'founder'
  let icpWindow: number | null = null
  try { const j = jobRow.icp ? JSON.parse(jobRow.icp) as { window_days?: unknown } : null; icpWindow = typeof j?.window_days === 'number' ? j.window_days : null } catch { icpWindow = null }
  const windowDays = parseWindowDays(jobRow.query ?? '') ?? icpWindow
  // Timing is mandatory when the request truly asks for it: an explicit window OR recency intent
  // (recent/currently/newly/latest/just-verb/verb-now). A windowless request invents no gate; it still
  // requires recognized, non-future proof before timing counts (semantics ruling 15:42).
  const opts = { who, windowDays, timingRequired: windowDays != null || TIMING_REQUESTED.test(jobRow.query ?? '') }
  let memory: ReturnType<typeof getMemory> | null = null
  try { memory = getMemory(db, TENANT) } catch { memory = null }
  const raw = db.prepare('SELECT id, name, company, contact, review_reason, confidence, event_date, event_date_proof, signal, signal_kind, fit, source_url, quarantined_at, company_domain FROM leads WHERE scan_job_id = ?').all(id) as { id: string; name: string; company: string; contact: string | null; review_reason: string | null; confidence: number | null; event_date: string | null; event_date_proof: string | null; signal: string | null; signal_kind: string | null; fit: number | null; source_url: string; quarantined_at: number | null; company_domain: string | null }[]
  const contactsOf = db.prepare("SELECT value FROM lead_enrichments WHERE lead_id = ? AND kind = 'contact'")
  const siteOf = db.prepare("SELECT kind, value FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = 'sitecrawl' AND kind IN ('person', 'email', 'phone')")
  const leads = raw.map(l => {
    const site = siteOf.all(l.id, TENANT) as { kind: string; value: string }[]
    const person = site.filter(r => r.kind === 'person').map(r => r.value).find(v => personMatchesRole(v, who)) ?? null
    const routes: RouteInput[] = site.filter(r => r.kind === 'email' || r.kind === 'phone').map(r => r.kind === 'phone'
      ? { kind: 'phone' as const, value: r.value, role_ok: true }
      : { kind: 'email' as const, value: r.value, role_ok: !NOT_A_FOUNDER_ROUTE.test(r.value.split('@')[0].replace(/[._-]/g, '')) })
    const v2: ScoredLeadInputV2 = {
      name: l.name, review_reason: l.review_reason, confidence: l.confidence,
      quarantined: l.quarantined_at != null, excluded: isExcluded(memory, l), held: requiredGateHeld(db, TENANT, l.id) !== null,
      fit: l.fit, company_domain_confirmed: l.company_domain != null, person_title: person, routes,
      event_date: l.event_date, event_date_proof: l.event_date_proof, signal: l.signal, signal_kind: l.signal_kind,
    }
    return { ...l, v2, contacts: (contactsOf.all(l.id) as { value: string }[]).map(r => r.value) }
  })
  const score = scoreSearchV2(leads.map(l => l.v2), opts)
  for (const l of leads) if (scoreLeadV2(l.v2, opts).qualified) qualifiedCompanies.add(companyKey(l.company))
  const status = complete ? j.status : 'INCOMPLETE'
  rows.push({ id: s.id, search: s.id, status, error, complete, seconds: Math.round((Date.now() - t0) / 1000), score, window_days: windowDays, timing_required: opts.timingRequired, leads: leads.map(({ id: _id, v2, ...l }) => ({ ...l, person_title: v2.person_title, routes: v2.routes })) })
  console.error(`${s.id}: ${status} ${error ?? ''} qualified=${score.qualified} leads=${score.leads} (${rows[rows.length - 1].seconds}s)`)
}

const md = scoreboardMarkdownV2(rows, { commit, date, model, rubric: `${RUBRIC_VERSION}:${rubric}`, uniqueQualified: qualifiedCompanies.size, budgetUsd: totalUsd })
const out = path.join(root, 'scoreboard', 'results')
mkdirSync(out, { recursive: true })
writeFileSync(path.join(out, `${date}-${commit}.json`), JSON.stringify({ commit, date, model, rubric, budgetUsdTotal: totalUsd, uniqueQualifiedCompanies: qualifiedCompanies.size, rows }, null, 2))
writeFileSync(path.join(out, `${date}-${commit}.md`), md)
console.log(md)
