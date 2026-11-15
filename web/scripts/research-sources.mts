// MISSION v2 part E: run the research engine's signal sources live for one market and print what they return (no key, no model, no DB).
//   node --experimental-strip-types --no-warnings scripts/research-sources.mts <city> <region> <country> <category> [days=90] [--json out.json]
// e.g. scripts/research-sources.mts Austin TX US roofing
import { writeFileSync } from 'node:fs'
import { safeGet } from '../lib/sources/http.ts'
import { socrataPermitsSource } from '../lib/research/sources/socrata-permits.ts'

const [city, region, country, category, daysArg] = process.argv.slice(2)
if (!city || !region || !country || !category) { console.error('usage: research-sources.mts <city> <region> <country> <category> [days]'); process.exit(2) }
const days = Number(daysArg && !daysArg.startsWith('--') ? daysArg : 90)
const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
const market = { city, region, country, category }
const sources = [socrataPermitsSource()]
const all = []
for (const s of sources.filter(x => x.covers(market))) {
  const t0 = Date.now()
  const r = await s.collect(market, since, safeGet)
  console.log(`${s.id}: ${r.signals.length} companies in ${((Date.now() - t0) / 1000).toFixed(1)} s${r.notes.length ? ` (notes: ${r.notes.join(', ')})` : ''}`)
  all.push(...r.signals)
}
const named = all.filter(x => x.personName).length, dated = all.filter(x => x.eventDate >= since).length
console.log(`${all.length} companies | named ${named} (${Math.round(100 * named / Math.max(all.length, 1))}%) | dated inside ${days} days ${dated} (${Math.round(100 * dated / Math.max(all.length, 1))}%) | with a source URL ${all.filter(x => x.sourceUrl).length}`)
for (const x of all.slice(0, 15)) console.log(`  ${x.eventDate} | ${x.company.slice(0, 34).padEnd(34)} | ${(x.personName ?? '-').padEnd(20)} | ${x.eventCount} | ${x.eventSummary.slice(0, 70)}`)
const out = process.argv.indexOf('--json'); if (out > 0) writeFileSync(process.argv[out + 1], JSON.stringify({ market, since, signals: all }, null, 1))
