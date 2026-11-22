// ATS board index refresh (Refs #1122). Its own process, run by ops/ats-index/dazl-ats-index-discover.timer: never inside a scan,
// never on a scan's budget, never on the web server's event loop. Free sources only (Common Crawl open data; the boards' own APIs).
//   node --experimental-strip-types scripts/ats-index.mts discover [--max-blocks 40]
// discover: seeds the boards of stored leads (source 'past_leads'), then reads the next Common Crawl index blocks of the newest two
// crawls for the four board hosts, resumable from the stored cursors, one block at a time with a pause, backing off on a failure.
import { getScanDb } from '../lib/scan/service.ts'
import { CDX_PATTERNS, discoverStep, latestCrawls, seedFromPastLeads } from '../lib/sources/ats-index.ts'

const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined }
const mode = process.argv[2]
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
if (mode !== 'discover') { console.error('usage: ats-index.mts discover [--max-blocks N]'); process.exit(2) }
const maxBlocks = Math.max(1, Math.min(500, Number(arg('--max-blocks') ?? 40) || 40))
const db = getScanDb() as unknown as import('better-sqlite3').Database
const seeded = seedFromPastLeads(db)
let blocks = 0, added = 0, failures = 0
const crawls = await latestCrawls(fetch).catch(e => { console.error(`ats-index: crawl list failed: ${e instanceof Error ? e.message : e}`); return [] as string[] })
outer: for (const crawl of crawls) for (const pattern of CDX_PATTERNS) {
  for (;;) {
    if (blocks >= maxBlocks) break outer
    try {
      const s = await discoverStep(db, fetch, crawl, pattern)
      if (!s) break
      blocks++; added += s.added
    } catch (e) {
      failures++
      console.error(`ats-index: ${crawl} ${pattern}: ${e instanceof Error ? e.message : e}`)
      if (failures >= 5) break outer
      await sleep(30_000 * failures)
      break
    }
    await sleep(1_000)
  }
}
console.log(JSON.stringify({ seeded_past_leads: seeded, crawls, blocks, added, failures }))
