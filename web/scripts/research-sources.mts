// MISSION v2 part E: run the research engine's registry sources live for one case and print the Candidates hunt.ts would get (no key, no
// model, no DB).  node --experimental-strip-types --no-warnings scripts/research-sources.mts "<where>" "<category>" [days=90] [--json out.json]
// e.g. scripts/research-sources.mts "Austin, Texas" "roofing contractors"
import { writeFileSync } from 'node:fs'
import { safeGet } from '../lib/sources/http.ts'
import { REGISTRY_SOURCES } from '../lib/research/sources/index.ts'
import { afterDate } from '../lib/research/hunt.ts'
import type { Candidate, ResearchCase } from '../lib/research/types.ts'

const [where, category, daysArg] = process.argv.slice(2)
if (!where || !category) { console.error('usage: research-sources.mts "<where>" "<category>" [days]'); process.exit(2) }
const c: ResearchCase = { tenant: '-', jobId: '-', query: `${category} in ${where}`, offer: '-', where, category, windowDays: Number(daysArg && !daysArg.startsWith('--') ? daysArg : 90), today: new Date().toISOString().slice(0, 10) }
const since = afterDate(c), all: Candidate[] = []
for (const s of REGISTRY_SOURCES.filter(x => x.covers(c))) {
  const t0 = performance.now()
  const r = await s.collect(c, since, safeGet)
  console.log(`${s.id}: ${r.candidates.length} candidates in ${((performance.now() - t0) / 1000).toFixed(1)} s${r.notes.length ? ` (notes: ${r.notes.join(', ')})` : ''}`)
  all.push(...r.candidates)
}
const named = all.filter(x => /(?:Contractor of record|Named on the filing): /.test(x.snippet)).length, dated = all.filter(x => x.date && x.date >= since).length
console.log(`${all.length} candidates | person named in the record ${named} (${Math.round(100 * named / Math.max(all.length, 1))}%) | dated inside ${c.windowDays} days ${dated} (${Math.round(100 * dated / Math.max(all.length, 1))}%)`)
for (const x of all.slice(0, 15)) console.log(`  ${x.date} | ${x.triggerId.padEnd(36)} | ${x.title.slice(0, 60).padEnd(60)} | ${x.url.slice(0, 70)}`)
const out = process.argv.indexOf('--json'); if (out > 0) writeFileSync(process.argv[out + 1], JSON.stringify({ case: c, since, candidates: all }, null, 1))
