// The stale-running lease floor is computed from the ACTUAL configured paid-call timeouts (lib/scan/store.ts
// MAX_PAID_CALL_MS). A non-finite or non-positive SCAN_LLM_TIMEOUT_MS override must never make that floor NaN
// (Math.max(NaN, ...) -> NaN -> the clamp silently disables and a live paid call could be reaped and re-run - a
// double bill). The floor bound itself is asserted against the imported configured constants, not a hardcoded number.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { configuredTimeoutMs } from '../lib/llm/timeout-env.ts'
import { LLM_TIMEOUT_MS } from '../lib/llm/provider.ts'
import { TINYFISH_TIMEOUT_MS } from '../lib/search/tinyfish.ts'
import { RENDER_TIMEOUT_MS } from '../lib/scan/fetch-page.ts'
import { APOLLO_TIMEOUT_MS } from '../lib/enrich/apollo.ts'
import { PDL_TIMEOUT_MS } from '../lib/enrich/pdl.ts'
import { MAX_PAID_CALL_MS, MIN_STALE_RUNNING_S, staleRunningSeconds } from '../lib/scan/store.ts'

test('configuredTimeoutMs: invalid overrides fall back loudly; unset/valid pass through', () => {
  const errs: string[] = []
  const orig = console.error
  console.error = (m?: unknown) => { errs.push(String(m)) }
  try {
    for (const bad of ['abc', 'NaN', 'Infinity', '-Infinity', '0', '-5', '1e999']) {
      assert.equal(configuredTimeoutMs(bad, 150_000, 'SCAN_LLM_TIMEOUT_MS'), 150_000, `${bad} falls back to the default`)
    }
    assert.equal(errs.length, 7, `every invalid value is loud: ${JSON.stringify(errs)}`)
    assert.ok(errs.every(e => e.includes('SCAN_LLM_TIMEOUT_MS') && e.includes('150000')))
    assert.equal(configuredTimeoutMs(undefined, 150_000, 'SCAN_LLM_TIMEOUT_MS'), 150_000, 'unset = the default, silently')
    assert.equal(configuredTimeoutMs('', 150_000, 'SCAN_LLM_TIMEOUT_MS'), 150_000, 'empty = the default, silently')
    assert.equal(errs.length, 7, 'unset/empty are not errors')
    assert.equal(configuredTimeoutMs('90000', 150_000, 'SCAN_LLM_TIMEOUT_MS'), 90_000, 'a valid override applies')
  } finally { console.error = orig }
})

test('the floor is computed from the configured constants, never hardcoded: max over paths plus a 45 s margin (#1157)', () => {
  const paths = { LLM_TIMEOUT_MS, RENDER_TIMEOUT_MS, TINYFISH_TIMEOUT_MS, APOLLO_TIMEOUT_MS, PDL_TIMEOUT_MS }
  for (const [name, ms] of Object.entries(paths)) assert.ok(Number.isFinite(ms) && ms > 0, `${name} is finite positive (${ms})`)
  assert.equal(MAX_PAID_CALL_MS, Math.max(...Object.values(paths)), 'the max is over every paid (reserved) call path')
  assert.equal(MIN_STALE_RUNNING_S, Math.ceil(MAX_PAID_CALL_MS / 1000) + 45, 'the floor is the max call length plus a 45 s margin (settle write, clock skew)')
  for (const [name, ms] of Object.entries(paths)) assert.ok(MIN_STALE_RUNNING_S >= Math.ceil(ms / 1000) + 45, `the floor covers ${name} (${ms}ms) with a 45 s margin`)
  assert.ok(staleRunningSeconds({}) >= MIN_STALE_RUNNING_S, 'the default stale window is never below the floor')
  assert.equal(staleRunningSeconds({ SCAN_STALE_RUNNING_S: '10' }), MIN_STALE_RUNNING_S, 'a below-floor override clamps UP')
})

test('the env wiring is real: a child process with SCAN_LLM_TIMEOUT_MS=abc gets the default, =90000 gets 90000', () => {
  const read = (v: string) => execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    "const m = await import('./lib/llm/provider.ts'); console.log(m.LLM_TIMEOUT_MS)"],
    { cwd: process.cwd(), env: { ...process.env, SCAN_LLM_TIMEOUT_MS: v }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  assert.equal(read('abc'), '150000', 'NaN override -> default, never NaN')
  assert.equal(read('Infinity'), '150000', 'Infinity override -> default')
  assert.equal(read('90000'), '90000', 'a valid override reaches the constant the floor reads')
})
