// #762: the published source-capability matrix is reconciled with PLATFORM_SUPPORT and served per tenant, keeping three states apart:
// available / unavailable (built, worker disconnected) / not_built (no adapter). Pure; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MATRIX, byId, workerEntries } from '../lib/sources/capability-matrix.ts'
import { capabilityReport, tenantCapabilities, type WorkerState } from '../lib/sources/capability-report.ts'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateConnectors, saveCredential, recentAudit } from '../lib/connectors/store.ts'
import { migrateAdvanced, acceptConsent, collectAdvanced, xViaOperatorIndex, type WorkerFetch } from '../lib/advanced/index.ts'
import { migrateTinyfish, resetTinyfishState } from '../lib/search/tinyfish.ts'
import { ADV_PLATFORMS, PLATFORM_SUPPORT, connectorId, type AdvPlatform } from '../lib/advanced/config.ts'

const ON = { enabled: true, linkedin: true }
const none: WorkerState = { connectors: [], consented: new Set(), flags: ON, xViaOperatorIndex: false }
const master = randomBytes(32)
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
  assert.match(src, /tenantCapabilities/); assert.match(src, /requireUser/)
  const rep = readFileSync(new URL('../lib/sources/capability-report.ts', import.meta.url), 'utf8')
  assert.match(rep, /readConsent/); assert.match(rep, /connectorStatus/); assert.match(rep, /xViaOperatorIndex\(env\)/)
  for (const r of capabilityReport(none)) assert.equal(Object.keys(r).some(k => /last4|credential|cookie|token/.test(k)), false, 'no credential field is ever published')
})

// ---- #1032 review (Ziggy / Greptile P1): X availability and the scan must use ONE rule for the operator-index path ----
const ADV_ON = { ADVANCED_CONNECTORS: '1', ADVANCED_WORKER_URL: 'http://worker.internal:9000', ADVANCED_WORKER_TOKEN: 't' }
// [name, env extras, X reachable with consent and NO session]
const X_CASES: [string, Record<string, string>, boolean][] = [
  ['key set, X_VIA_SEARCH unset', { TINYFISH_API_KEY: 'tf-key' }, true],
  ['key set, X_VIA_SEARCH=1', { TINYFISH_API_KEY: 'tf-key', X_VIA_SEARCH: '1' }, true],
  ['key set, X_VIA_SEARCH=0', { TINYFISH_API_KEY: 'tf-key', X_VIA_SEARCH: '0' }, false],
  ['no key, X_VIA_SEARCH unset', {}, false],
  ['no key, X_VIA_SEARCH=0', { X_VIA_SEARCH: '0' }, false],
  ['key set but TinyFish switched off', { TINYFISH_API_KEY: 'tf-key', TINYFISH_ENABLED: '0' }, false],
]
async function xStore() {
  const raw = new Database(':memory:'); migrateConnectors(raw); migrateAdvanced(raw); migrateTinyfish(raw); resetTinyfishState()
  acceptConsent(raw, 'A', 'advanced')
  return { raw, db: sqliteDb(raw) }
}

test('xViaOperatorIndex: the operator index is used only with the TinyFish key AND X_VIA_SEARCH not 0', () => {
  for (const [name, extra, want] of X_CASES) assert.equal(xViaOperatorIndex(extra), want, name)
})

test('capabilities report (the route\'s function): consented X with no session is available only when the scan would use the operator index', async () => {
  for (const [name, extra, want] of X_CASES) {
    const { raw, db } = await xStore()
    try {
      const rows = await tenantCapabilities(db, 'A', { ...ADV_ON, ...extra })
      assert.equal(row(rows, 'adv:x').availability, want ? 'available' : 'unavailable', name)
      assert.equal(row(rows, 'adv:reddit').availability, 'unavailable', `${name}: reddit has no session`)
    } finally { raw.close() }
  }
  // a stored enabled X session makes X available whatever X_VIA_SEARCH says (the scan then uses the worker with that session)
  const { raw, db } = await xStore()
  try {
    saveCredential(raw, 'A', 'adv:x', 'x-session-of-A', master)
    for (const v of ['0', '1']) assert.equal(row(await tenantCapabilities(db, 'A', { ...ADV_ON, TINYFISH_API_KEY: 'tf-key', X_VIA_SEARCH: v }), 'adv:x').availability, 'available', `session, X_VIA_SEARCH=${v}`)
    // and another tenant's consent or session never counts for this one
    assert.equal(row(await tenantCapabilities(db, 'B', { ...ADV_ON, TINYFISH_API_KEY: 'tf-key' }), 'adv:x').availability, 'unavailable', 'tenant B has no consent')
  } finally { raw.close() }
})

test('no drift: for every X_VIA_SEARCH / key setting, "available" with no session == a real collectAdvanced run reads X without a worker session', async () => {
  for (const [name, extra, want] of X_CASES) {
    const { raw, db } = await xStore()
    try {
      const env = { ...ADV_ON, ...extra }
      let workerCalls = 0
      const worker: WorkerFetch = async () => { workerCalls++; return null }   // no session anywhere: the worker answers no_session = worker_error
      const fetchImpl = (async () => new Response(JSON.stringify({ results: [{ url: 'https://x.com/acme/status/12345', title: 't', snippet: 'we are dumping our current sales tool, it never works', date: '2026-10-20' }] }), { status: 200 })) as unknown as typeof fetch
      const out = await collectAdvanced(raw, 'A', 'j1', ['x'], 'sales software alternatives', { worker, master, env, fetchImpl })
      const status = (recentAudit(raw, 'A', 10) as { connector: string; status: string }[]).find(r => r.connector === 'adv:x')?.status
      const scanReadX = status === 'ok' && out.length > 0
      assert.equal(scanReadX, want, `${name}: scan audit ${status}`)
      assert.equal(workerCalls, want ? 0 : 1, `${name}: worker path iff not the operator index`)
      assert.equal(row(await tenantCapabilities(db, 'A', env), 'adv:x').availability === 'available', scanReadX, `${name}: report and scan disagree`)
    } finally { raw.close() }
  }
})

test('worker rows claim only the proof their evidence carries (xhawk): no author identity, dates only where the worker returns one, Bilibili is Latin-script', () => {
  const rows = capabilityReport(none)
  for (const p of ADV_PLATFORMS) assert.equal(row(rows, `adv:${p}`).identityProof, 'none', `${p}: collectAdvanced drops the worker author object`)
  for (const p of ['instagram', 'linkedin']) assert.equal(row(rows, `adv:${p}`).dateProof, 'none', `${p}: worker date is always null`)
  for (const p of ['x', 'reddit', 'bilibili']) assert.equal(row(rows, `adv:${p}`).dateProof, 'published_date', p)
  assert.deepEqual(row(rows, 'adv:bilibili').languages, ['en'], 'the worker discards CJK text, so zh coverage is not claimed')
  for (const p of ['x', 'reddit']) assert.match(row(rows, `adv:${p}`).failureReporting, /connector_audit only - the scan run report does not list it yet/)
})

test('collectAdvanced really drops the worker author (the reason worker rows say identityProof none)', async () => {
  const { raw } = await xStore()
  try {
    saveCredential(raw, 'A', 'adv:reddit', 'reddit-of-A', master)
    const worker: WorkerFetch = async () => ({ items: [{ url: 'https://www.reddit.com/r/x/comments/1', title: 't', quote: 'a quote that is long enough to keep', date: '2026-10-01', login_walled: false, author: { name: 'someone', headline: null, company: 'Acme', url: null } }], unsupported: null }) as never
    const out = await collectAdvanced(raw, 'A', 'j1', ['reddit'], 'q', { worker, master, env: ADV_ON })
    assert.equal(out.length, 1); assert.equal('author' in out[0], false)
  } finally { raw.close() }
})
