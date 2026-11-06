// The scoped discovery API (#392): lib/api-tokens.ts parsing, and the real route handlers (token management and the MCP
// endpoint) in helpers/api-tokens-route-runtime.mts, which runs under the scan-route loader in its own process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { scrub } from '../lib/ops/errors.ts'
import { bearerSecret, parseTokenSpec, DEFAULT_SCANS_PER_DAY, DEFAULT_USD_PER_SCAN, DEFAULT_TTL_DAYS } from '../lib/api-tokens.ts'

test('bearerSecret: exactly "Bearer dzl_<43 base64url>", anything else is no credential', () => {
  const s = `dzl_${'a'.repeat(43)}`
  assert.equal(bearerSecret(`Bearer ${s}`), s)
  for (const h of [null, '', s, `bearer ${s}`, `Bearer ${s}x`, `Bearer ${s} extra`, `Basic ${s}`, 'Bearer dzl_short', `Bearer ${'a'.repeat(64)}`]) assert.equal(bearerSecret(h), null, String(h))
})

test('scrub: an API token secret never survives an error record, whatever surrounds it', () => {
  for (const tail of ['A'.repeat(43), 'A'.repeat(41) + '--', '-' + 'A'.repeat(42), '_'.repeat(43)]) {
    const s = `dzl_${tail}`
    for (const line of [s, `token=${s}`, `"${s}"`, `x-${s}-y`, `https://h.test/api/mcp/${s}`, `Bearer ${s}`]) assert.ok(!scrub(line).includes(tail.slice(0, 20)), line)
  }
})

test('parseTokenSpec: defaults for a scan token, nothing clamped, no send scope, read always required', () => {
  assert.deepEqual(parseTokenSpec({ label: ' ChatGPT\u0007 ', scopes: ['scan', 'read'] }), { ok: true, spec: { label: 'ChatGPT', scopes: ['read', 'scan'], scansPerDay: DEFAULT_SCANS_PER_DAY, maxUsdPerScan: DEFAULT_USD_PER_SCAN, ttlDays: DEFAULT_TTL_DAYS } })
  assert.deepEqual(parseTokenSpec({ label: 'r', scopes: ['read'], expires_in_days: 7 }), { ok: true, spec: { label: 'r', scopes: ['read'], scansPerDay: 0, maxUsdPerScan: 0, ttlDays: 7 } })
  for (const bad of [null, [], { label: '', scopes: ['read'] }, { label: 'x', scopes: [] }, { label: 'x', scopes: ['send'] }, { label: 'x', scopes: ['read', 'admin'] }, { label: 'x', scopes: ['scan'] },
    { label: 'x', scopes: ['read'], max_usd_per_scan: 1 }, { label: 'x', scopes: ['read', 'scan'], scans_per_day: 0 }, { label: 'x', scopes: ['read', 'scan'], scans_per_day: 1.5 },
    { label: 'x', scopes: ['read', 'scan'], max_usd_per_scan: 0 }, { label: 'x', scopes: ['read', 'scan'], max_usd_per_scan: '2' }, { label: 'x', scopes: ['read'], expires_in_days: 366 }]) {
    assert.equal(parseTokenSpec(bad).ok, false, JSON.stringify(bad))
  }
})

test('API tokens and the MCP endpoint through the real route handlers (two workspaces, no network)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/scan-route-loader.mjs', '--test', './test/helpers/api-tokens-route-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 11\b/); assert.match(r.stdout, /# fail 0\b/)
})
