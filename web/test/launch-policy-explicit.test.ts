// #800: a launch policy is accepted only when the owner stated every authority field. No field may be filled in by a
// default on the tenant's behalf: an absent exclusions list must not mean "exclude nobody". Policies already stored are
// read as before (the check is on acceptance input only), so existing acceptances are not changed.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { acceptLaunchPolicy, EXPLICIT_FIELDS, implicitFields, LAUNCH_POLICY_VERSION, migrateLaunchPolicy, readLaunchPolicy } from '../lib/outreach/launch-policy.ts'

const full = () => ({
  version: LAUNCH_POLICY_VERSION, sender: 'me@acme.example', audience: { playIds: ['play-1'] },
  exclusions: { domains: [] as string[], emails: [] as string[] },
  dailyCap: 20, spendCapUsd: 25, claims: { mayStatePrice: false, benchmarkUrls: [] as string[] },
  stops: { pauseOnAnyReply: true, maxBounceRate: 0.05 }, testInbox: 'me@acme.example',
})
const db = () => { const d = new Database(':memory:'); migrateLaunchPolicy(d); return d }
const drop = (o: Record<string, unknown>, path: string) => {
  const ks = path.split('.'); const last = ks.pop()!
  delete (ks.reduce((x, k) => x[k] as Record<string, unknown>, o) as Record<string, unknown>)[last]
  return o
}

test('a fully stated policy (empty lists included) is accepted', () => {
  assert.deepEqual(implicitFields(full()), [])
  assert.deepEqual(acceptLaunchPolicy(db(), 'A', full(), 1), { ok: true })
})

for (const f of EXPLICIT_FIELDS) {
  test(`omitting ${f} is refused by name and stores nothing`, () => {
    const d = db()
    const input = drop(full() as unknown as Record<string, unknown>, f)
    assert.deepEqual(implicitFields(input), [f])
    const r = acceptLaunchPolicy(d, 'A', input, 1)
    assert.equal(r.ok, false)
    assert.ok(!r.ok && r.problems.includes('field_not_explicit'))
    assert.equal(readLaunchPolicy(d, 'A'), null)
  })
}

test('a whole missing exclusions object is refused, never read as "exclude nobody"', () => {
  const rest: Record<string, unknown> = full(); delete rest.exclusions
  assert.deepEqual(implicitFields(rest), ['exclusions.domains', 'exclusions.emails'])
  const r = acceptLaunchPolicy(db(), 'A', rest, 1)
  assert.ok(!r.ok && r.problems.includes('field_not_explicit'))
})

test('wrong types are not explicit answers: "false" is not false, a string is not a list, null is not empty', () => {
  const p = full() as unknown as Record<string, Record<string, unknown>>
  p.claims.mayStatePrice = 'false'; p.stops.pauseOnAnyReply = 0; p.exclusions.domains = 'customer.example'; p.exclusions.emails = null
  assert.deepEqual(implicitFields(p), ['exclusions.domains', 'exclusions.emails', 'claims.mayStatePrice', 'stops.pauseOnAnyReply'])
  assert.ok(!acceptLaunchPolicy(db(), 'A', p, 1).ok)
})

test('a refused re-acceptance leaves the existing acceptance untouched', () => {
  const d = db()
  assert.deepEqual(acceptLaunchPolicy(d, 'A', full(), 1), { ok: true })
  const before = readLaunchPolicy(d, 'A')
  const noStops: Record<string, unknown> = full(); delete noStops.stops
  assert.equal(acceptLaunchPolicy(d, 'A', noStops, 2).ok, false)
  assert.deepEqual(readLaunchPolicy(d, 'A'), before)
})

test('a stored policy is read as before: the acceptance check does not apply to rows already accepted', () => {
  const d = db()
  assert.deepEqual(acceptLaunchPolicy(d, 'A', full(), 1), { ok: true })
  const row = d.prepare('SELECT policy FROM autopilot_launch_policy').get() as { policy: string }
  const stored = JSON.parse(row.policy); delete stored.exclusions
  d.prepare('UPDATE autopilot_launch_policy SET policy = ?').run(JSON.stringify(stored))
  assert.deepEqual(readLaunchPolicy(d, 'A')?.policy.exclusions, { domains: [], emails: [] })
})
