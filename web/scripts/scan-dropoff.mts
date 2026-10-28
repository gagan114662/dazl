// Where do a scan's candidates die? Reads a scan's run report (the `run_report` array from GET /api/scan/status, or a saved fixture under test/fixtures/scan-runs/) and prints the funnel
// stage by stage with the reason at each drop, so the biggest drop-off is visible at a glance. Read-only; no network.
//   node --experimental-strip-types --no-warnings scripts/scan-dropoff.mts <report.json> [more.json ...]
import { readFileSync } from 'node:fs'
import { dropoffOf, formatDropoff } from '../lib/scan/dropoff.ts'

const files = process.argv.slice(2)
if (files.length === 0) { console.error('usage: scan-dropoff.mts <run-report.json> [...]'); process.exit(2) }
for (const f of files) {
  const raw = JSON.parse(readFileSync(f, 'utf8'))
  const report = Array.isArray(raw) ? raw.at(-1) : raw.run_report ? [].concat(raw.run_report).at(-1) : raw
  console.log(`== ${f}`); console.log(formatDropoff(dropoffOf(report)))
}
