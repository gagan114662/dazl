// Rendered check, fully stubbed (no server, db, network or key). Run: cd web && NODE_PATH=<dir with esbuild and playwright> node test/ui/leads-deep-link.ui.mjs
// #349 (offer journey): a run named in the Leads address bar (?job_id=, as "Open these leads", a play's runs and the
// campaign page link to it) is the run shown. Rule: a scan still in progress never takes the page over from the run the
// link names, whatever that scan's state and whatever the named run's state, including a named run that does not
// exist (it says so; it does not fall back to another scan). Controls: with no run named, or a malformed one, Leads
// still opens the scan in progress; a link to the scan in progress itself shows its progress and Stop control; the
// sidebar's ?latest=1 alone still opens the newest finished run.
// Every /api/* answer is a stub; the scan list answers at once and a named run's status answers late, the order in
// which the old autoselect won. Exit 1 on a failed expectation; SKIP (exit 0) without esbuild/playwright.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
let esbuild, chromium
try { esbuild = require('esbuild'); ({ chromium } = require('playwright')) } catch (e) { console.log(`SKIP: ${e.message.split('\n')[0]}`); process.exit(0) }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = await esbuild.build({
  stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import LeadsClient from '@/app/app/leads/leads-client'; createRoot(document.getElementById('root')).render(<LeadsClient />)`, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'error', alias: { '@': root }, define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'node-shims', setup(b) { b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: 'crypto-shim', namespace: 'shim' })); b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: 'export const createHash = () => ({ update() { return this }, digest() { return "shim" } })', loader: 'js' })) } }],
})
const js = bundle.outputFiles[0].text
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
const ICP = { summary: 'Leeds accountancy firms', who: ['Managing partner'], industries: [], sizes: [], where: ['Leeds'], signals: [], exclude: [] }
const NAMED = 'a'.repeat(24), ACTIVE = 'b'.repeat(24), ACTIVE2 = 'c'.repeat(24)
const summary = (id, status, extra = {}) => ({ id, status, error: null, query: `Run ${id.slice(0, 4)}`, business_name: 'Synthetic Co', csv_domain: null, created_at: 1761500000, finished_at: null, candidates: null, verified: null, needs_review: null, dropped: null, lead_count: 0, test_only: false, ...extra })
const statusOf = (id, status, error = null) => ({ job_id: id, status, created_at: 1761500000, claimed_at: 1761500001, attempts: 1, max_attempts: 3, lead_count: status === 'done' ? 1 : 0, quality: status === 'done' ? { candidates: 1, passed: 1, needs_review: 0, dropped: 0, drop_reasons: {} } : null, error, icp: ICP, icp_source: 'user', query: `Run ${id.slice(0, 4)}`, enrichment: { state: 'none' } })
const lead = { id: '1'.repeat(24), name: '', company: 'Named Run Ltd', contact: 'hello@namedrun.example', signal: 'Hiring a payroll manager', source_url: 'https://news.example/a', score: 70, evidence_excerpt: 'Named Run Ltd is hiring a payroll manager', event_date: '2026-10-20', date_status: 'verified', confidence: 80, review_reason: null, company_domain: null, human_confirmed_at: null, human_confirmed_from: null, fit: 4, intent: 3, action: 3, why: 'Fits.', signals: null, icp_match: null, enrichments: [], events: [] }

const browser = await chromium.launch()
// jobs: the scan list (/api/scan/jobs); named: { id, status, error, missing } for the run the URL names
async function open(search, jobs, named) {
  const polled = new Set()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.route('**/*', async route => {
    const req = route.request(); const u = new URL(req.url())
    if (req.resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>' })
    if (u.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: js })
    if (!u.pathname.startsWith('/api/')) return route.fulfill({ status: 204, body: '' })
    if (u.pathname === '/api/scan/jobs') return json(route, { jobs })
    if (u.pathname === '/api/scan/status') {
      const id = u.searchParams.get('job_id'); polled.add(id)
      if (named && id === named.id) { await new Promise(r => setTimeout(r, 400)); return named.missing ? json(route, { error: 'not_found' }, 404) : json(route, statusOf(id, named.status, named.error ?? null)) }
      const j = jobs.find(x => x.id === id)
      return j ? json(route, statusOf(id, j.status)) : json(route, { error: 'not_found' }, 404)
    }
    if (u.pathname === '/api/leads') return json(route, { job_id: u.searchParams.get('job_id'), status: 'done', hidden_count: 0, leads: named && u.searchParams.get('job_id') === named.id && named.status === 'done' ? [lead] : [] })
    if (u.pathname === '/api/usage') return json(route, { plan: 'pro', scans_used: 1, scan_limit: 10, has_key: true, trial: null })
    if (u.pathname === '/api/outreach') return json(route, { messages: [] })
    return json(route, {}, 404)
  })
  await page.goto(`http://dazl.test/app/leads${search}`)
  await page.waitForTimeout(1500)
  return { page, polled, shown: new URL(page.url()).searchParams.get('job_id') }
}

// Variants: a run is named; another scan is in progress. The named run stays on screen; the other is never read.
const VARIANTS = [
  ['named done, other pending', [summary(ACTIVE, 'pending')], { status: 'done' }],
  ['named done, other running', [summary(ACTIVE, 'running')], { status: 'done' }],
  ['named done, other enriching', [summary(ACTIVE, 'enriching')], { status: 'done' }],
  ['named failed, other running', [summary(ACTIVE, 'running')], { status: 'failed', error: 'provider_error' }],
  ['named cancelled, other pending', [summary(ACTIVE, 'pending')], { status: 'failed', error: 'cancelled' }],
  ['named done with &passive=1, other running', [summary(ACTIVE, 'running')], { status: 'done' }, '&passive=1'],
  ['named done, two others in progress', [summary(ACTIVE, 'running'), summary(ACTIVE2, 'pending')], { status: 'done' }],
  ['named run that does not exist, other running', [summary(ACTIVE, 'running')], { status: 'done', missing: true }],
  ['named done, other running, named is also in the list as done', [summary(ACTIVE, 'running'), summary(NAMED, 'done', { lead_count: 1 })], { status: 'done' }],
  // the other automatic jump: ?latest=1 opens the newest finished run, never instead of the run the link names
  ['named done with &latest=1, a newer finished run exists', [summary(ACTIVE, 'done', { lead_count: 3, created_at: 1761600000 })], { status: 'done' }, '&latest=1'],
]
const failures = []
for (const [name, jobs, n, extra = ''] of VARIANTS) {
  const { page, polled, shown } = await open(`?job_id=${NAMED}${extra}`, jobs, { id: NAMED, ...n })
  try {
    assert.equal(shown, NAMED, `${name}: the address bar still names the linked run`)
    for (const j of jobs.filter(x => x.id !== NAMED)) assert.ok(!polled.has(j.id), `${name}: the other run (${j.status}) was not opened`)
    assert.equal(await page.getByRole('button', { name: 'Stop this scan' }).count(), 0, `${name}: no Stop control for a scan that is not shown`)
    if (n.status === 'done' && !n.missing) await page.getByText('Named Run Ltd').first().waitFor({ timeout: 5000 })
    if (n.missing) await page.getByText('That scan was not found in this account.').waitFor({ timeout: 5000 })
  } catch (e) { failures.push(e.message.split('\n')[0]) }
  await page.close()
}
// Controls: nothing named, or a malformed id, opens the scan in progress; a link to that scan shows its progress.
for (const [name, search] of [['no run named', ''], ['malformed job_id', '?job_id=not-a-run'], ['the scan in progress itself', `?job_id=${ACTIVE}`]]) {
  const { page, shown } = await open(search, [summary(ACTIVE, 'running')], null)
  try {
    await page.getByRole('button', { name: 'Stop this scan' }).waitFor({ timeout: 5000 })
    assert.equal(shown, ACTIVE, `${name}: the scan in progress is shown`)
  } catch (e) { failures.push(`control ${name}: ${e.message.split('\n')[0]}`) }
  await page.close()
}
{ const { page, shown } = await open('?latest=1', [summary(ACTIVE, 'done', { lead_count: 3 })], null)
  try { assert.equal(shown, ACTIVE, 'control ?latest=1: the newest finished run is opened') } catch (e) { failures.push(e.message.split('\n')[0]) }
  await page.close() }
await browser.close()
assert.deepEqual(failures, [], `${failures.length} case(s) failed:\n${failures.join('\n')}`)
console.log(`leads-deep-link.ui: ok (${VARIANTS.length} variants, 4 controls)`)
