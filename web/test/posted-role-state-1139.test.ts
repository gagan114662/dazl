// #1139: a posted-role signal whose role carries a state word in parentheses ("(filled)", "(closed)", "(paused)",
// "(former)") or joins two sentences with a "." inside a word ("VP Sales.Cut staff") is not the "Posted a <title> role on
// <board>" hiring wording, so an ats_structured board date never backs it. Built from the live #533 Tekion signal (verbatim).
// The route seam runs GET /api/leads on a real store in a child process (stubbed session, no network).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isHiringTrigger, surfaceStoredIntent } from '../lib/scan/scoreboard.ts'

const LIVE = 'Posted a Sales Operations Manager - Deal Desk role on Ashby'

test('#1139: a parenthesised state word or an intra-word sentence break is not a title word', () => {
  for (const no of ['Posted a Sales (paused) role on Lever', 'Posted a Sales Ops (filled) role on Ashby', 'Posted a (closed) Sales role on Greenhouse', 'Posted a (former) VP Sales role on Lever', 'Posted a Sales Operations Manager - Deal Desk (filled) role on Ashby', 'Posted a (closed) Sales Operations Manager - Deal Desk role on Ashby', 'Posted a Sales Ops(filled) role on Ashby', 'Posted a Sales (on-hold) role on Lever', 'Posted a VP Sales.Cut staff role on Lever', 'Posted a U.S.Layoffs role on Lever', 'Posted a Node.js.Layoffs role on Lever', 'Posted a Sales.Netflix role on Lever', 'Posted a U.S.Layoffs. Sales role on Lever', 'Posted a Sales (EMEA/filled) role on Lever', 'Posted a Sales Ops/closed role on Ashby', 'Posted a Sales (Remote/paused) role on Greenhouse', 'Posted a Sr.Mgr.Layoffs role on Lever', 'Posted a Sr.Mgr.(filled) role on Lever', 'Posted a Mgr.St. role on Lever']) assert.equal(isHiringTrigger(no, null), false, no)
  // still hiring: the live wording, a parenthesised region, and the listed abbreviations and dotted acronyms
  for (const yes of [LIVE, 'Posted a Sales Ops (EMEA) Mgr. role on Lever', 'Posted a Sr.Mgr Sales Ops role on Ashby', 'Posted a U.S. Enterprise AE role on Greenhouse', 'Posted a Sales Engineer (Remote) role on Ashby', 'Posted an Account Executive (Mid-Market) role on Greenhouse', 'Posted a Node.js Developer role on Lever', 'Posted an ASP.NET Engineer role on Ashby', 'Posted a Vue.js Dev role on Lever', 'Posted a U.S Enterprise AE role on Greenhouse', 'Posted a Sales (Remote/US) role on Lever', 'Posted a C++ Developer role on Lever', 'Posted a Sr.Mgr.Ops role on Lever', 'Posted a Sr.Dir.Sales role on Lever', 'Posted a (Sr.Mgr) Sales role on Lever', 'Posted an R&D Sales Engineer role on Ashby']) assert.equal(isHiringTrigger(yes, null), true, yes)
  const dated = { intent: 4, event_date: '2026-11-11', event_date_proof: 'ats_structured', signal_kind: null }
  assert.equal(surfaceStoredIntent({ ...dated, signal: LIVE }, { now: new Date('2026-11-12T18:00:00Z') }).timing, 'proof_backed')
  assert.equal(surfaceStoredIntent({ ...dated, signal: 'Posted a Sales Operations Manager - Deal Desk (filled) role on Ashby' }, { now: new Date('2026-11-12T18:00:00Z') }).timing, 'unconfirmed')
})

test('#1139: the posted-role check stays linear on a long run of trailing spaces', () => {
  const t = performance.now()
  assert.equal(isHiringTrigger(`Posted a Sales role on Lever${' '.repeat(30000)}x`, null), false)
  assert.ok(performance.now() - t < 50, `took ${performance.now() - t} ms`)
})

test('#1139 route seam: GET /api/leads holds a stored (filled) / (closed) posted role at intent 0, the live wording surfaces', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/scan-route-loader.mjs',
    '--test', './test/helpers/posted-role-1139-route-runtime.mts',
  ], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 90000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /# pass 1/); assert.match(result.stdout, /# fail 0/)
})
