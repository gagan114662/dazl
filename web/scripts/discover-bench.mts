// Runs the benchmark prompts (../bench/prompts.json) through the Claude discovery loop alone (lib/discover), with real
// web search and model calls, and prints the benchmark columns. It measures what the loop finds before it is wired into
// the scan runner, so a prompt change can be judged in minutes.
//
//   cd web && node --experimental-strip-types --no-warnings scripts/discover-bench.mts [--cases a,b] [--max-leads 10]
//        [--out ../bench/results] [--private-out <dir outside the repo>]
//
// Key: DISCOVER_ANTHROPIC_KEY, else MATRIX_ANTHROPIC_KEY, SCOREBOARD_ANTHROPIC_KEY, DAZL_TRIAL_ANTHROPIC_KEY (never printed).
// --out gets the table only (counts; the repo is public). --private-out gets the leads themselves, for a hand check.
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DISCOVER_MODEL } from '../lib/discover/agent.ts'
import { runDiscovery } from '../lib/discover/run.ts'
import { isShown } from '../lib/discover/check.ts'
import { ENRICH_MODEL } from '../lib/discover/enrich.ts'

const argv = process.argv.slice(2)
const opt = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined }
const root = path.resolve(import.meta.dirname, '..', '..')
const key = (process.env.DISCOVER_ANTHROPIC_KEY || process.env.MATRIX_ANTHROPIC_KEY || process.env.SCOREBOARD_ANTHROPIC_KEY || process.env.DAZL_TRIAL_ANTHROPIC_KEY || '').trim()
if (!key) { console.error('No model key (DISCOVER_ANTHROPIC_KEY / MATRIX_ANTHROPIC_KEY / SCOREBOARD_ANTHROPIC_KEY / DAZL_TRIAL_ANTHROPIC_KEY). Not running.'); process.exit(2) }
const file = path.resolve(opt('prompts') ?? path.join(root, 'bench', 'prompts.json'))
const all = (JSON.parse(readFileSync(file, 'utf8')) as { cases: { id: string; query: string; offer?: string }[] }).cases
const only = opt('cases')?.split(',').map(s => s.trim()).filter(Boolean)
const cases = all.filter(c => !only || only.includes(c.id))
if (!cases.length) { console.error('no cases to run'); process.exit(2) }
const maxLeads = Number(opt('max-leads') ?? 10)
const commit = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return process.env.BENCH_COMMIT || 'unknown' } })()
const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 100))
const runStamp = `${new Date().toISOString().slice(0, 10)}-${commit}-discover-${Date.now().toString(36)}`
const privDir = opt('private-out')
if (privDir) mkdirSync(path.resolve(privDir), { recursive: true })
const privFile = privDir ? path.join(path.resolve(privDir), `${runStamp}.json`) : null

interface Row { id: string; status: string; leads: number; shown: number; datedProof: number; printedDate: number; domain: number; named: number; email: number; dated: number; usd: number; secs: number; model: string; note: string }
const rows: Row[] = [], priv: Record<string, unknown> = {}
for (const c of cases) {
  const t0 = Date.now()
  try {
    const run = await runDiscovery({ query: c.query, offer: c.offer, maxLeads }, { maxUsd: Number(opt('max-usd') ?? 1) }, { apiKey: key, signal: AbortSignal.timeout(900_000), ...(argv.includes('--no-enrich') ? { enrich: null } : {}) })
    const leads = run.leads
    const r = { stop: run.stop, model: run.model, note: run.note, usage: { usd: run.usd, searches: run.searches, requests: run.requests, passes: run.passes, enriched: run.enriched } }
    const s = leads.filter(isShown)
    rows.push({ id: c.id, status: r.stop, leads: leads.length, shown: s.length, datedProof: s.filter(l => l.date).length, printedDate: s.filter(l => l.date_source === 'page').length, domain: pct(s.filter(l => l.domain).length, s.length), named: pct(s.filter(l => l.person).length, s.length), email: pct(s.filter(l => l.email).length, s.length), dated: pct(s.filter(l => l.date).length, s.length), usd: r.usage.usd, secs: Math.round((Date.now() - t0) / 1000), model: r.model, note: r.note ?? '' })
    priv[c.id] = { usage: r.usage, note: r.note, leads }
    if (privFile) writeFileSync(privFile, JSON.stringify(priv, null, 2))
  } catch (e) {
    rows.push({ id: c.id, status: `error: ${String((e as Error)?.message ?? e).slice(0, 80)}`, leads: 0, shown: 0, datedProof: 0, printedDate: 0, domain: 0, named: 0, email: 0, dated: 0, usd: 0, secs: Math.round((Date.now() - t0) / 1000), model: '-', note: '' })
  }
  const x = rows[rows.length - 1]
  console.error(`${x.id}: ${x.status} leads=${x.leads} shown=${x.shown} dated_proof=${x.datedProof} named=${x.named}% usd=${x.usd.toFixed(3)} (${x.secs}s)`)
}

const cols = ['prompt', 'status', 'leads', 'shown', 'dated proof', 'date on page', 'domain%', 'named%', 'email%', 'dated%', 'usd', 'secs']
const body = rows.map(r => [r.id, r.status, r.leads, r.shown, r.datedProof, r.printedDate, r.domain, r.named, r.email, r.dated, r.usd.toFixed(3), r.secs].map(String))
const w = cols.map((c, i) => Math.max(c.length, ...body.map(b => b[i].length)))
const line = (cells: string[]) => cells.map((c, i) => c.padEnd(w[i])).join('  ')
const at5 = rows.filter(r => r.shown >= 5).length, totalShown = rows.reduce((n, r) => n + r.shown, 0), totalUsd = rows.reduce((n, r) => n + r.usd, 0)
const date = new Date().toISOString().slice(0, 16).replace('T', ' ')
const table = [
  `DISCOVER loop @ ${commit} ${date} UTC, model ${DISCOVER_MODEL}${argv.includes('--no-enrich') ? '' : ` + ${ENRICH_MODEL} for people`}: ${at5}/${rows.length} prompts with 5+ shown; ${totalShown} shown in all; US$${totalUsd.toFixed(2)} total`,
  line(cols), line(w.map(n => '-'.repeat(n))), ...body.map(line), '',
  'definitions:',
  '  leads: records the loop returned with a company, a signal and a proof URL',
  '  shown: of those, the ones whose proof page names the company (read by Claude\'s reader or by dazl), or came back in the search results with the company in its title',
  '  dated proof: shown leads that carry a date and a proof link. date on page: of those, the ones where Claude read the date on the proof page itself; the rest take the day the search index dates the page',
  '  domain% / named% / email% / dated%: of the shown leads, those with a company website, a named person, an email address a public page prints, a date',
  '  usd: model tokens at list price plus web searches; secs: wall clock, search and page reads included',
].join('\n')
console.log(table)
const stamp = runStamp
const out = opt('out')
if (out) { mkdirSync(path.resolve(out), { recursive: true }); writeFileSync(path.join(path.resolve(out), `${stamp}.txt`), table + '\n') }
if (privFile) writeFileSync(privFile, JSON.stringify(priv, null, 2))
