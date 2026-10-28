// Stubbed replay across countries, languages and non-tech categories: which scenarios does discovery + verification handle? verifier-passed is NOT scoreboard-qualified (no contact or fit grade here).
//   SITECRAWL_ENABLED=0 NEWS_SEARCH_ENABLED=0 node --experimental-strip-types --no-warnings --import ./test/helpers/net-fence.ts scripts/global-replay.mts
import { SCENARIOS, replay } from '../test/helpers/global-scenarios.ts'
let ok = 0
for (const s of SCENARIOS) { const r = await replay(s); if (r.passed) ok++; console.log(`${s.id.padEnd(16)} ${s.country} ${s.lang} ${s.category.padEnd(30)} ${r.outcome}`) }
console.log(`\nverifier-passed ${ok} / ${SCENARIOS.length} (3+ countries: ${new Set(SCENARIOS.map(s => s.country)).size}, languages: ${new Set(SCENARIOS.map(s => s.lang)).size}, categories: ${new Set(SCENARIOS.map(s => s.category)).size})`)
process.exit(0)
