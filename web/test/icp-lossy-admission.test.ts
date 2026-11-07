// #917: explicit client-supplied ICP criteria are never silently cut at scan admission; a long fallback request discloses
// what its profile does not carry. Pure functions here; the real POST /api/scan run is test/helpers/icp-lossy-route-runtime.mts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { budgetedIcp, fallbackCoverage, fallbackIcp, icpLoss, normalizeIcp, MAX_QUERY } from '../lib/scan/icp.ts'

const BASE = { summary: 'Find independent local businesses', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] }

test('the issue reproduction: normalizeIcp drops the 7th exclusion and budgetedIcp still says ok - icpLoss names it', () => {
  const raw = { ...BASE, exclude: ['chains', 'software vendors', 'franchises', 'government', 'nonprofits', 'agencies', 'healthcare'] }
  const n = normalizeIcp(raw)!
  assert.ok(!n.exclude.includes('healthcare')); assert.equal(budgetedIcp(n).ok, true)   // why a separate check is needed
  assert.deepEqual(icpLoss(raw), [{ field: 'exclude', kind: 'too_many_items', limit: 6, actual: 7 }])
})

test('icpLoss: 5th size, 7th location, item > 160 (with its index), summary > 300', () => {
  assert.deepEqual(icpLoss({ ...BASE, sizes: ['a', 'b', 'c', 'd', 'e'] }), [{ field: 'sizes', kind: 'too_many_items', limit: 4, actual: 5 }])
  assert.deepEqual(icpLoss({ ...BASE, where: ['1', '2', '3', '4', '5', '6', '7'] }), [{ field: 'where', kind: 'too_many_items', limit: 6, actual: 7 }])
  assert.deepEqual(icpLoss({ ...BASE, who: ['ok', 'y'.repeat(161)] }), [{ field: 'who', kind: 'item_too_long', index: 1, limit: 160, actual: 161 }])
  assert.deepEqual(icpLoss({ ...BASE, summary: 's'.repeat(301) }), [{ field: 'summary', kind: 'too_long', limit: 300, actual: 301 }])
})

test('icpLoss: a list field of the wrong shape or a non-text item is a typed refusal, not a silent erase; absent/null/blank slots are not criteria', () => {
  assert.deepEqual(normalizeIcp({ ...BASE, who: 'VP Sales at SaaS' })!.who, [], 'what normalization does today: the explicit criterion is erased')
  assert.deepEqual(icpLoss({ ...BASE, who: 'VP Sales at SaaS' }), [{ field: 'who', kind: 'wrong_type', expected: 'array', actual: 'string' }])
  assert.deepEqual(icpLoss({ ...BASE, industries: { a: 1 }, sizes: 5, where: true }), [
    { field: 'industries', kind: 'wrong_type', expected: 'array', actual: 'object' }, { field: 'sizes', kind: 'wrong_type', expected: 'array', actual: 'number' }, { field: 'where', kind: 'wrong_type', expected: 'array', actual: 'boolean' }])
  assert.deepEqual(icpLoss({ ...BASE, exclude: ['chains', 42, { x: 1 }, ['n']] }), [
    { field: 'exclude', kind: 'item_not_text', index: 1, actual: 'number' }, { field: 'exclude', kind: 'item_not_text', index: 2, actual: 'object' }, { field: 'exclude', kind: 'item_not_text', index: 3, actual: 'array' }])
  assert.deepEqual(icpLoss({ ...BASE, who: undefined, signals: null, exclude: [null, undefined, '', '  '] }), [])
  // the nit: an over-long item reports its position in the array the caller SENT, not after blanks were filtered
  assert.deepEqual(icpLoss({ ...BASE, who: ['', 'ok', '   ', 'y'.repeat(161)] }), [{ field: 'who', kind: 'item_too_long', index: 3, limit: 160, actual: 161 }])
})

test('icpLoss: nothing at the caps, and whitespace/blank items that normalizeIcp legitimately collapses are not loss', () => {
  assert.deepEqual(icpLoss({ ...BASE, summary: 's'.repeat(300), exclude: ['a', 'b', 'c', 'd', 'e', 'f', '', '  '], signals: ['z'.repeat(160)], who: ['  spaced   out  '] }), [])
  assert.deepEqual(icpLoss(null), []); assert.deepEqual(icpLoss('x'), [])
  const ok = { ...BASE, exclude: ['a', 'b'] }; assert.deepEqual(normalizeIcp(ok)!.exclude, ok.exclude)
})

test('fallback coverage: a request over 300 chars says its tail is not in the profile; a short one is complete', () => {
  const q = 'Independent bakeries in Toronto '.repeat(12) + 'EXCEPT any chain franchises'   // 388+ chars, under MAX_QUERY
  assert.ok(q.length > 300 && q.length <= MAX_QUERY)
  assert.ok(!fallbackIcp(q).summary.includes('EXCEPT'))   // the loss the issue reports
  const c = fallbackCoverage(q)
  assert.equal(c.complete, false)
  if (!c.complete) { assert.equal(c.kept_chars, 300); assert.equal(c.request_chars, q.length); assert.match(c.dropped, /EXCEPT any chain franchises$/) }
  assert.deepEqual(fallbackCoverage('Dentists in Ottawa'), { complete: true })
})

test('source order: the scan route refuses a lossy profile before offers, reservations, trial admission or the queue', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../app/api/scan/route.ts', import.meta.url), 'utf8')
  const at = src.indexOf("error: 'profile_lossy'")
  assert.ok(at > 0)
  for (const later of ['readSellerLine(', 'budgetedIcp(', 'trialPrincipal(', 'normalizeScanBudget(']) assert.ok(src.indexOf(later) > at, later)
  const preview = readFileSync(new URL('../app/api/scan/icp/route.ts', import.meta.url), 'utf8')
  assert.match(preview, /coverage: fallbackCoverage\(query\)/)
})

test('POST /api/scan refuses each lossy profile with zero jobs and zero provider requests (real handler, stubbed)', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/scan-route-loader.mjs', '--test', './test/helpers/icp-lossy-route-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 60000 })
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /# pass 9/); assert.match(result.stdout, /# fail 0/)
})
