// One scan worker process for test/scan-worker-836.test.ts: the production entry point (scanWorkerMain, the function
// scripts/scan-worker.mts calls) on the SQLite file in DB_PATH, with the model provider and the page fetch stubbed
// through the runner's own RunDeps, so the claim, the bind, the run, the lead writes and the settle are the real code
// and nothing leaves the process (the net fence is loaded too).
//   W_NAME    this worker's instance id          W_MASTER  the key store's master key, base64
//   W_MODE    answer: every scan finds one lead  hang: the provider never answers (a scan stays mid-run)
//   W_SLOW_MS answer mode: how long the provider takes
// DAZL_ENV and DAZL_STAGING_SCAN_HOLD_MS pass through from the test (the staging-only pause before a scan runs).
import { scanWorkerMain } from '../../lib/scan/worker.ts'
import type { RunDeps } from '../../lib/scan/runner.ts'

process.env.DAZL_INSTANCE_ID = process.env.W_NAME!
const master = Buffer.from(process.env.W_MASTER!, 'base64')
const slow = Number(process.env.W_SLOW_MS ?? 0)
const QUOTE = 'Northside Builders announced it is hiring three roofing crews for the Toronto market'
const recent = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10)
const leadJson = JSON.stringify([{ name: 'Pat', company: 'Northside Builders', contact: null, signal: 'Hiring', source_url: 'https://a.com', score: 80, excerpt: QUOTE, event_date: recent }])
let calls = 0
const research = async () => {
  console.log(`[child] provider call ${++calls}`)
  if (process.env.W_MODE === 'hang') return new Promise<never>(() => {})
  if (slow) await new Promise(r => setTimeout(r, slow))
  return { text: 'Here: ' + leadJson, citedUrls: ['https://a.com'] }
}
const fetchPage = async () => ({ text: `News ${recent.slice(0, 4)}. ${QUOTE}. More text.`, title: 'Northside Builders news', retrievedAt: Math.floor(Date.now() / 1000) })
scanWorkerMain({ deps: { providers: { anthropic: { research }, openai: { research } } as never, master, fetchPage, score: false } as RunDeps })
