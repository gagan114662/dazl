// Refs #1099, Gagan's rule (15 Nov 03:38): dazl calls no paid third-party API in its default path except Claude. Every gate below runs with
// DAZL_PAID_VENDORS empty (the default an operator gets) and proves NO request reaches the vendor; a control names the vendor and proves
// the same code still runs when an operator opts in. Tests of the vendor code paths opt in (test/paid-vendors-on.ts),
// so each test here sets the variable itself. Invented companies and keys; fake fetch; no network.
// Part of the #1273 split: the policy itself (lib/paid-vendors.ts).
import test from 'node:test'
import assert from 'node:assert/strict'
import { paidVendorsAllowed, paidVendorOn } from '../lib/paid-vendors.ts'

const OFF = { DAZL_PAID_VENDORS: '' }
async function withProcessEnv<T>(v: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const had = process.env.DAZL_PAID_VENDORS
  if (v === undefined) delete process.env.DAZL_PAID_VENDORS; else process.env.DAZL_PAID_VENDORS = v
  try { return await fn() } finally { if (had === undefined) delete process.env.DAZL_PAID_VENDORS; else process.env.DAZL_PAID_VENDORS = had }
}

test('the policy: nothing is allowed by default; only the vendors the operator names, in any case and spacing', async () => {
  await withProcessEnv(undefined, () => {
    assert.deepEqual([...paidVendorsAllowed({})], [])
    for (const v of ['apollo', 'pdl', 'zerobounce', 'openai', 'jina'] as const) assert.equal(paidVendorOn(v, {}), false, v)
  })
  assert.deepEqual([...paidVendorsAllowed({ DAZL_PAID_VENDORS: ' Apollo , PDL ,bogus' })].sort(), ['apollo', 'pdl'])
  // an empty value in a call's own env is an explicit "none", not "ask the process"
  await withProcessEnv('apollo', () => { assert.equal(paidVendorOn('apollo', OFF), false); assert.equal(paidVendorOn('apollo', {}), true) })
})
