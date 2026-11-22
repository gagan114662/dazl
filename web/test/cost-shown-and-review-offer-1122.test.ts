// #1122 copy bugs. (1) The Leads page's cost line said "per lead ... across N leads" with N = the scan's verified counter,
// which still counts leads the final checks hold off the page; N is now the leads the page shows. (2) "Review profile first"
// on a request naming the workspace ("Find leads for <workspace>") against a different saved offer showed no
// "Use: <workspace>" choice (the direct run and the website review had it) and silently pre-filled the saved offer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { costPerShownLead } from '../lib/scan/cost-per-verification-pass.ts'
import { reviewOffer, websiteReviewOffer } from '../app/app/leads/website-review-offer.ts'

const page = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')

test('#1122 (1) through the real GET /api/leads: the cost line counts the leads shown, never held ones', () => {
  const env = { ...process.env } as NodeJS.ProcessEnv
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/scan-route-loader.mjs', '--test', './test/helpers/cost-shown-leads-1122-runtime.mts'], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 90000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 2/)
})

test('#1122 (1) costPerShownLead: running, unrecorded cost and zero shown stay named, never 0 or a made-up ratio', () => {
  const ready = [{ review_reason: null }, { review_reason: null }]
  assert.equal(costPerShownLead({ model_usd: 0.2, scanEnded: false, leads: ready, showSeen: false, leadsRead: true })?.unavailable, 'scan still running')
  assert.equal(costPerShownLead({ model_usd: null, scanEnded: true, leads: ready, showSeen: false, leadsRead: true })?.unavailable, 'model cost not recorded')
  const ok = costPerShownLead({ model_usd: 0.2, scanEnded: true, leads: [...ready, { review_reason: 'no_sales_hiring_evidence' }], showSeen: false, leadsRead: true })!
  assert.equal(ok.shown, 2); assert.equal(ok.usd_per_lead, 0.1)
  // a list the page could not read gives no line at all: never "no leads shown", never a hedge in its place
  assert.equal(costPerShownLead({ model_usd: 0.2, scanEnded: true, leads: [], showSeen: false, leadsRead: false }), null)
})

test('#1122 (1) the page renders the shown-lead count, not the verified counter', () => {
  assert.match(page, /costPerShownLead\(\{ model_usd: cost\?\.actual\?\.model_usd \?\? null, scanEnded: status === 'done' \|\| status === 'failed', leads, showSeen, leadsRead: currentView !== null \}\)/)
  assert.match(page, /\{cost\?\.per_verification_pass && perLead && \(status === 'done' \|\| status === 'failed'\) && \(/)
  // no hedge text for an unread list: none in the cost function's strings, none in the per-lead line
  assert.doesNotMatch(readFileSync(new URL('../lib/scan/cost-per-verification-pass.ts', import.meta.url), 'utf8'), /['"`][^'"`\n]*not read[^'"`\n]*['"`]/)
  const line = page.slice(page.indexOf('data-testid="scan-cost-per-pass"'), page.indexOf('</p>', page.indexOf('data-testid="scan-cost-per-pass"')))
  assert.doesNotMatch(line, /not read/)
  assert.doesNotMatch(page, /across \{cost\.per_verification_pass\.verified\}/)
  assert.match(page, /across \{perLead\.shown\} \{perLead\.shown === 1 \? 'lead' : 'leads'\} shown\./)
})

const saved = { offer: 'Appointment scheduling for dental clinics', business: 'dazl', seller: 'Appointment scheduling for dental clinics' }
test('#1122 (2) review: "Find leads for <workspace>" against a different saved offer offers "Use: <workspace>" (prod wording, Quest 2026-11-21)', () => {
  const r = reviewOffer('Find leads for dazl', saved)
  assert.equal(r.conflict?.stated, 'dazl'); assert.equal(r.conflict?.recorded, saved.offer); assert.equal(r.conflict?.freshTarget, true)
  // the same choice the website review already made, so the two review paths agree
  assert.deepEqual(r.conflict, websiteReviewOffer('Find leads for dazl', saved, '').conflict)
})

test('#1122 (2) controls: no workspace name, another business name, a stated offer conflict and the same offer keep their old results', () => {
  assert.deepEqual(reviewOffer('Find operations leaders', saved), { offer: saved.offer, conflict: null })
  assert.equal(reviewOffer('Find leads for Other Business', saved).conflict, null)
  assert.equal(reviewOffer('Find operations leaders; Seller: Fixture Systems, reviewed outreach', saved).conflict?.stated, 'Fixture Systems, reviewed outreach')
  assert.equal(reviewOffer('Find leads for dazl', { ...saved, offer: null }).conflict, null)   // nothing saved: nothing to carry
})

test('#1122 (2) the review chooser asks what the play sells; only a direct run offers the targeting choice', () => {
  assert.match(page, /const targeting = c\.freshTarget && !onWrite/)
  assert.match(page, /\{targeting \? 'Keep saved targeting' : `Use: \$\{c\.saved\}`\}/)
})

test('#1122 (2) the plain "Review profile first" path uses the shared review choice', () => {
  const start = page.slice(page.indexOf('async function startOffer('), page.indexOf('// Extra sources this page asked the run for'))
  assert.match(start, /reviewOffer\(q, base\)/)
})
