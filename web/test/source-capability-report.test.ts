// #762: the published source-capability matrix is reconciled with PLATFORM_SUPPORT and served per tenant, keeping three states apart:
// available / unavailable (built, worker disconnected) / not_built (no adapter). Pure; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MATRIX, byId, workerEntries } from '../lib/sources/capability-matrix.ts'
import { capabilityReport, type WorkerState } from '../lib/sources/capability-report.ts'
import { ADV_PLATFORMS, PLATFORM_SUPPORT, connectorId, type AdvPlatform } from '../lib/advanced/config.ts'

const ON = { enabled: true, linkedin: true }
const none: WorkerState = { connectors: [], consented: new Set(), flags: ON, xViaOperatorIndex: false }
const row = (rows: ReturnType<typeof capabilityReport>, id: string) => rows.find(r => r.id === id)!

test('every worker platform has exactly one entry and its built-ness equals PLATFORM_SUPPORT (Facebook / Xiaohongshu are not shipped)', () => {
  for (const p of ADV_PLATFORMS) {
    const c = byId(`adv:${p}`)!; assert.ok(c, `no matrix entry for worker platform ${p}`)
    assert.equal(c.status === 'shipped', PLATFORM_SUPPORT[p].supported, p)
    assert.equal(c.worker, p)
  }
  for (const p of ['facebook', 'xiaohongshu'] as const) { const c = byId(`adv:${p}`)!; assert.equal(c.status, 'planned'); assert.equal(c.blocker, PLATFORM_SUPPORT[p].reason) }
  assert.equal(byId('adv:social'), undefined, 'the lumped social entry overstated coverage')
  // a platform that flips to unsupported flips its entry: nothing is a literal label
  const flipped = workerEntries({ ...PLATFORM_SUPPORT, x: { supported: false, reason: 'signing broke' } }).find(c => c.id === 'adv:x')!
  assert.equal(flipped.status, 'planned'); assert.equal(flipped.blocker, 'signing broke')
})

test('disconnected worker = unavailable (not zero opportunity); unbuilt platform = not_built; connected = available', () => {
  const rows = capabilityReport(none)
  assert.equal(row(rows, 'adv:reddit').availability, 'unavailable'); assert.match(row(rows, 'adv:reddit').statusLine, /unavailable.*not "no opportunities"/)
  for (const id of ['adv:facebook', 'adv:xiaohongshu']) { assert.equal(row(rows, id).availability, 'not_built'); assert.match(row(rows, id).statusLine, /not built yet - no coverage claimed/); assert.equal(row(rows, id).advertisable, false) }
  assert.equal(row(rows, 'rss').availability, 'available')
  const connected: WorkerState = { ...none, consented: new Set<AdvPlatform>(['reddit']), connectors: [{ connector: connectorId('reddit'), enabled: true }] }
  assert.equal(row(capabilityReport(connected), 'adv:reddit').availability, 'available')
  // an unbuilt platform with a stored session and consent is still not_built: connecting cannot enable an adapter nobody wrote
  const stale: WorkerState = { ...none, consented: new Set<AdvPlatform>(['facebook']), connectors: [{ connector: connectorId('facebook'), enabled: true }] }
  assert.equal(row(capabilityReport(stale), 'adv:facebook').availability, 'not_built')
})

test('connected needs operator switch AND consent AND an enabled session; X can use the operator index with consent alone', () => {
  const sess = (p: AdvPlatform, enabled = true) => [{ connector: connectorId(p), enabled }]
  const base = { ...none, consented: new Set<AdvPlatform>(['reddit']), connectors: sess('reddit') }
  assert.equal(row(capabilityReport(base), 'adv:reddit').availability, 'available')
  assert.equal(row(capabilityReport({ ...base, flags: { enabled: false, linkedin: false } }), 'adv:reddit').availability, 'unavailable', 'operator tier off')
  assert.equal(row(capabilityReport({ ...base, consented: new Set() }), 'adv:reddit').availability, 'unavailable', 'no consent')
  assert.equal(row(capabilityReport({ ...base, connectors: sess('reddit', false) }), 'adv:reddit').availability, 'unavailable', 'session switched off')
  assert.equal(row(capabilityReport({ ...none, consented: new Set<AdvPlatform>(['x']), xViaOperatorIndex: true }), 'adv:x').availability, 'available')
  assert.equal(row(capabilityReport({ ...none, xViaOperatorIndex: true }), 'adv:x').availability, 'unavailable')
  assert.equal(row(capabilityReport({ ...none, flags: { enabled: true, linkedin: false }, consented: new Set<AdvPlatform>(['linkedin']), connectors: sess('linkedin') }), 'adv:linkedin').availability, 'unavailable', 'LinkedIn needs its separate switch')
})

test('the published row carries the whole policy and nothing is advertised without evidence', () => {
  const rows = capabilityReport(none)
  assert.equal(rows.length, MATRIX.length)
  for (const r of rows) {
    for (const k of ['label', 'refresh', 'license', 'failureReporting', 'access', 'identityProof', 'dateProof'] as const) assert.ok(String(r[k]).length > 0, `${r.id}.${k}`)
    assert.ok(r.markets.length && r.languages.length && r.signals.length, r.id)
    assert.equal(r.advertisable, false); assert.equal(r.defaultEligible, false)
    assert.equal(r.blocker !== null, r.status === 'planned', r.id)
  }
})

test('the matrix is consumed by a real route, not just tests', () => {
  const src = readFileSync(new URL('../app/api/sources/capabilities/route.ts', import.meta.url), 'utf8')
  assert.match(src, /capabilityReport/); assert.match(src, /requireUser/); assert.match(src, /readConsent/); assert.match(src, /connectorStatus/)
  for (const r of capabilityReport(none)) assert.equal(Object.keys(r).some(k => /last4|credential|cookie|token/.test(k)), false, 'no credential field is ever published')
})
