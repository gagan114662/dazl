// Agent eval suite (docs/design/agent-evals.md): replays every case in test/fixtures/evals/cases against its frozen World
// with the real scan code, scores it with the deterministic evaluators, and compares with the baseline of known failures.
// Offline by construction: run under the test net fence, no keys, no network.
//   SITECRAWL_ENABLED=0 NEWS_SEARCH_ENABLED=0 node --experimental-strip-types --no-warnings --import ./test/helpers/net-fence.ts scripts/evals.mts [--json out.json]
// Exit 1 when any case differs from the baseline (a regression, or a fix the baseline still lists).
import { writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { runSuite, loadBaseline, compareBaseline } from '../test/helpers/eval-suite.ts'

const dir = new URL('../test/fixtures/evals/', import.meta.url).pathname
// The net fence scrubs env names containing KEY, which can leave git's GIT_CONFIG_COUNT pointing at a deleted GIT_CONFIG_KEY_n.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_CONFIG_'))) as NodeJS.ProcessEnv
let commit: string | null = process.env.GITHUB_SHA?.slice(0, 7) ?? null
if (!commit) try { commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv }).toString().trim() } catch { /* not a checkout */ }
const rows = await runSuite(`${dir}cases`, { commit })
const diff = compareBaseline(rows, loadBaseline(`${dir}baseline.json`))
console.log(`eval suite ${commit ?? '(no commit)'}: ${rows.length} case(s), SYNTHETIC worlds only (not live performance)\n`)
console.log('case | status | validated | unknown | model calls | http | pages | cost | misses')
for (const r of rows) console.log(`${r.case} | ${r.score.status} | ${r.score.validated_rate?.toFixed(2) ?? '-'} | ${r.score.unknown_rate?.toFixed(2) ?? '-'} | ${r.totals.model_calls} | ${r.totals.http_calls} | ${r.totals.page_fetches} | ${r.totals.cost_usd === null ? 'unknown' : `$${r.totals.cost_usd.toFixed(4)}${r.totals.cost_complete ? '' : '+'}`} | ${r.result.misses.length}`)
for (const r of rows) for (const v of r.score.verdicts.filter(v => v.status !== 'pass')) console.log(`  ${r.case}: ${v.status.toUpperCase()} ${v.evaluator} ${v.subject} - ${v.rationale}`)
let bad = false
for (const d of diff) {
  if (d.regressions.length) { bad = true; console.log(`\nREGRESSION ${d.case}:\n  ${d.regressions.join('\n  ')}`) }
  if (d.fixed.length) { bad = true; console.log(`\nFIXED ${d.case} (remove from test/fixtures/evals/baseline.json):\n  ${d.fixed.join('\n  ')}`) }
}
const json = process.argv.indexOf('--json')
if (json > 0) writeFileSync(process.argv[json + 1], JSON.stringify({ commit, rows: rows.map(r => ({ case: r.case, score: r.score, totals: r.totals, misses: r.result.misses })), diff }, null, 1))
console.log(bad ? '\neval gate: FAIL (differs from baseline)' : '\neval gate: ok (matches baseline)')
process.exit(bad ? 1 : 0)
