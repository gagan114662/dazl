import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { saveKey } from '../../lib/llm/key-store.ts'
import { customerView, type RunEstimate } from '../../lib/scan/price-estimate.ts'
import { POST as ESTIMATE } from '../../app/api/scan/estimate/route.ts'
import { POST as SCAN } from '../../app/api/scan/route.ts'
import { GET as STATUS } from '../../app/api/scan/status/route.ts'

// #1319 item 2, through the real POST /api/scan/estimate, POST /api/scan and GET /api/scan/status handlers on a throwaway
// in-memory store (network fenced, runner never started). A keyless account with a linked Google identity is
// trial-eligible; the trial's per-scan cap is $0.30 (#680). No dollar amount above the cap may reach the customer without
// the line that says the trial stops there: not on the cost box before the run, not on the run page after it.
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
Object.assign(process.env, { DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-fixture-not-real', DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1', DAZL_TRIAL_GLOBAL_DAILY_USD: '10',
  TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.004', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.002' })
globalThis.fetch = (async (u: unknown) => { throw new Error(`network fenced: ${String(u)}`) }) as typeof fetch
const CAP = 0.3
// The live request from the issue's run (Quest, 2026-11-17): Toronto agencies hiring an SDR.
const Q = 'Small marketing and creative agencies in Toronto, Ontario - hiring an SDR'
let n = 0
const post = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', 'x-forwarded-for': `198.51.100.${++n % 250}` }, body: JSON.stringify(body) })
const status = (jobId: string) => STATUS(new NextRequest(`http://localhost/api/scan/status?job_id=${jobId}&readonly=1`, { headers: { host: 'localhost' } }))
function tenant(google: boolean) {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); setScanDb(raw)
  const id = (++n).toString(16).padStart(32, '0'), email = `founder${n}@example.test`
  raw.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')").run(id, email)
  if (google) raw.prepare("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)").run(`sub-${id}`, id)
  raw.prepare("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'b', 'personal', ?, 1700000000)").run(id, id)
  setUser({ id, business_name: 'b', email })
  return { raw, id }
}
// Quote, confirm, start; then mark the run ended (the run page shows its cost line only then). Nothing is spent here.
async function endedRun(raw: Database.Database) {
  const e = await ESTIMATE(post('/api/scan/estimate', { query: Q }))
  assert.equal(e.status, 200, JSON.stringify(await e.clone().json()))
  const { estimate } = await e.json() as { estimate: RunEstimate }
  const s = await SCAN(post('/api/scan', { query: Q, estimate_ack: estimate.ack }))
  assert.equal(s.status, 202, JSON.stringify(await s.clone().json()))
  const { job_id } = await s.json() as { job_id: string }
  raw.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job_id)
  raw.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job_id)
  return { estimate, job_id }
}
type Cost = { estimate: { total: { min: number; max: number }; trial_cap_line?: string | null }; actual: { summary: string } | null }
// every dollar amount written in a string
const dollars = (s: string) => [...s.matchAll(/\$(\d+(?:\.\d+)?)/g)].map(m => Number(m[1]))

test('#1319 item 2: the pre-run cost box of a trial-eligible search never shows a total above the $0.30 trial cap, and says the trial stops there', async () => {
  tenant(true)
  const r = await ESTIMATE(post('/api/scan/estimate', { query: Q }))
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
  const { estimate } = await r.json() as { estimate: RunEstimate }
  assert.equal(estimate.payer, 'trial')
  assert.ok(estimate.total.max > CAP, `precondition: the priced rows reach above the cap (${estimate.total.max})`)
  const v = customerView(estimate)
  assert.ok(v.total.min <= CAP && v.total.max <= CAP, JSON.stringify(v.total))
  assert.equal(v.trial_cap_line, 'Free trial scans stop at $0.30.')
})

test('#1319 item 2: after a trial scan, the run page cost line never shows a number above the $0.30 trial cap, and says the trial stops there', async () => {
  const { raw } = tenant(true)
  const { estimate, job_id } = await endedRun(raw)
  assert.equal((raw.prepare('SELECT funded_by FROM scan_jobs WHERE id = ?').get(job_id) as { funded_by: string }).funded_by, 'trial')
  assert.ok(estimate.total.max > CAP, 'precondition: the confirmed estimate itself reaches above the cap')
  const st = await status(job_id)
  assert.equal(st.status, 200)
  const { cost } = await st.json() as { cost: Cost }
  assert.ok(cost, 'the run page has its cost line')
  assert.ok(cost.estimate.total.max <= CAP && cost.estimate.total.min <= CAP, `"Estimated $x - $y at start" stays within the trial cap: ${JSON.stringify(cost.estimate.total)}`)
  assert.equal(cost.estimate.trial_cap_line, 'Free trial scans stop at $0.30.')
  for (const d of dollars(cost.actual?.summary ?? '')) assert.ok(d <= CAP, `the actual-vs-estimate line shows $${d}, above the trial cap: ${cost.actual!.summary}`)
})

test('#1319 item 2: an own-key run is not clamped and carries no trial line', async () => {
  const { raw, id } = tenant(false)
  saveKey(raw, id, 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  const { estimate, job_id } = await endedRun(raw)
  assert.equal(estimate.payer, 'you')
  const { cost } = await (await status(job_id)).json() as { cost: Cost }
  assert.deepEqual(cost.estimate.total, estimate.total, 'own key: the confirmed total, unchanged')
  assert.ok(!cost.estimate.trial_cap_line)
})

test('#1319 item 2: a trial job saved before the estimate kept its cap still shows within the cap its trial reservation held', async () => {
  const { raw } = tenant(true)
  const { job_id } = await endedRun(raw)
  const saved = JSON.parse((raw.prepare('SELECT estimate FROM scan_jobs WHERE id = ?').get(job_id) as { estimate: string }).estimate) as Record<string, unknown>
  delete saved.trial_scan_cap_usd
  raw.prepare('UPDATE scan_jobs SET estimate = ? WHERE id = ?').run(JSON.stringify(saved), job_id)
  assert.equal((raw.prepare('SELECT reserve_usd FROM trial_reservations WHERE job_id = ?').get(job_id) as { reserve_usd: number }).reserve_usd, CAP)
  const { cost } = await (await status(job_id)).json() as { cost: Cost }
  assert.ok(cost.estimate.total.max <= CAP, JSON.stringify(cost.estimate.total))
  assert.equal(cost.estimate.trial_cap_line, 'Free trial scans stop at $0.30.')
})

// Council R1: an older trial job with no cap kept and no reservation row (or a read that fails) never fails open.
test('#1319 item 2: a trial job with no cap kept and no reservation row: still clamped to the trial cap configured now, with the note', async () => {
  const { raw } = tenant(true)
  const { job_id } = await endedRun(raw)
  const saved = JSON.parse((raw.prepare('SELECT estimate FROM scan_jobs WHERE id = ?').get(job_id) as { estimate: string }).estimate) as Record<string, unknown>
  delete saved.trial_scan_cap_usd
  raw.prepare('UPDATE scan_jobs SET estimate = ? WHERE id = ?').run(JSON.stringify(saved), job_id)
  raw.prepare('DELETE FROM trial_reservations WHERE job_id = ?').run(job_id)
  const { cost } = await (await status(job_id)).json() as { cost: Cost }
  assert.ok(cost.estimate.total.max <= CAP, JSON.stringify(cost.estimate.total))
  assert.equal(cost.estimate.trial_cap_line, 'Free trial scans stop at $0.30.')
  for (const d of dollars(cost.actual?.summary ?? '')) assert.ok(d <= CAP, cost.actual!.summary)
})

test('#1319 item 2: a trial job whose cap cannot be found at all shows no dollar estimate, only that the trial stops at its limit', async () => {
  const { raw } = tenant(true)
  const { job_id } = await endedRun(raw)
  const saved = JSON.parse((raw.prepare('SELECT estimate FROM scan_jobs WHERE id = ?').get(job_id) as { estimate: string }).estimate) as Record<string, unknown>
  delete saved.trial_scan_cap_usd
  raw.prepare('UPDATE scan_jobs SET estimate = ? WHERE id = ?').run(JSON.stringify(saved), job_id)
  raw.exec('DROP TABLE trial_reservations') // the read fails: "could not read" is never "no cap"
  const reserve = process.env.DAZL_TRIAL_SCAN_RESERVE_USD
  delete process.env.DAZL_TRIAL_SCAN_RESERVE_USD
  try {
    const { cost } = await (await status(job_id)).json() as { cost: { estimate: { total: unknown; trial_cap_line: string }; actual: { summary: string } | null } }
    assert.equal(cost.estimate.total, null, 'no range to show')
    assert.equal(cost.estimate.trial_cap_line, 'Free trial scans stop at their per-scan limit.')
    assert.equal(cost.actual?.summary, 'The cost line is not shown: this free scan\'s trial limit could not be read.', 'never "not recorded" when it was')
  } finally { process.env.DAZL_TRIAL_SCAN_RESERVE_USD = reserve }
})

test('#1319 item 2: the pre-run box rows and its "Model requests expected" line never read above the trial cap either', async () => {
  tenant(true)
  const { estimate } = await (await ESTIMATE(post('/api/scan/estimate', { query: Q }))).json() as { estimate: RunEstimate }
  const v = customerView(estimate)
  for (const r of v.rows) if (r.usd) assert.ok(r.usd.max <= CAP, `${r.id}: ${JSON.stringify(r.usd)}`)
  assert.ok(v.capped_total.max <= CAP && v.capped_total.min <= CAP, JSON.stringify(v.capped_total))
})
