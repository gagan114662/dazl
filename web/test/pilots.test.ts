// Outcome-based pilots (lib/pilots/pilot.ts, #399) in STAGING only: the stub sender records and sends nothing, every
// account, address and company is invented, and no clock or network is touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assignArms, authorityHash, checkAuthority, ingest, liveGate, pause, replay, report, resume, startPilot, stubSender, tick, wilson, PilotError, type Account, type Authority, type OutcomeEvent, type SendPort } from '../lib/pilots/pilot.ts'

const AUTH = (over: Partial<Authority> = {}): Authority => ({
  pilot_id: 'pilot-synthetic-1', tenant_id: 'tenant-A',
  customer_authorization: { signed_by: 'owner@customer.example', signed_at: '2026-10-01T00:00:00Z', record_ref: 'authz/synthetic-1' },
  audience: { cohorts: ['agency', 'saas'], countries: ['CA', 'GB'] },
  exclusions: { domains: ['competitor.example'], emails: ['ceo@blocked.example'], companies: ['Existing Customer Ltd'] },
  offers: ['offer-audit', 'offer-trial'], channels: ['email'],
  sender: { identity: 'pilot@customer.example', verified: true },
  volume: { max_contacts: 100, max_sends_per_day: 50 }, spend: { max_usd: 100, usd_per_send: 0.05 },
  horizon: { start: '2026-11-02', end: '2026-11-30' },
  stop: { max_bounce_rate: 0.1, max_complaint_rate: 0.01, min_sends_for_rates: 10 },
  arms: [
    { id: 'A', offer_id: 'offer-audit', sequence: [{ step: 1, delay_days: 0, template_ref: 'a1' }, { step: 2, delay_days: 3, template_ref: 'a2' }] },
    { id: 'B', offer_id: 'offer-trial', sequence: [{ step: 1, delay_days: 0, template_ref: 'b1' }, { step: 2, delay_days: 3, template_ref: 'b2' }] },
  ],
  seed: 11, ...over,
})
const acct = (i: number, over: Partial<Account> = {}): Account => ({ key: `acc-${String(i).padStart(3, '0')}`, company: `Synthetic Co ${i}`, domain: `co${i}.example`, country: i % 2 ? 'CA' : 'GB', cohort: i % 3 ? 'agency' : 'saas', contact: { email: `founder@co${i}.example`, verified: true }, identity_verified: true, ...over })
const ACCOUNTS = Array.from({ length: 40 }, (_, i) => acct(i + 1))
const prov = (p: ReturnType<typeof startPilot>, account: string) => ({ pilot_id: p.authority.pilot_id, arm: p.state.prospects.get(account)!.arm, account })

test('launch is not authority: staging unless a customer record, a verified sender, finite bounds and the deployment flag all hold', () => {
  assert.deepEqual(liveGate(AUTH(), { DAZL_PILOTS_LIVE: '1' }), { mode: 'live', missing: [] })
  assert.equal(liveGate(AUTH(), {}).mode, 'staging')
  const m = liveGate(AUTH({ customer_authorization: null, sender: { identity: 'x@y.example', verified: false }, volume: { max_contacts: Infinity, max_sends_per_day: 5 }, spend: { max_usd: 0, usd_per_send: 0.05 } }), { DAZL_PILOTS_LIVE: '1' })
  assert.equal(m.mode, 'staging')
  assert.deepEqual(m.missing.map(x => x.split(' ')[0]), ['no', 'sender', 'volume', 'spend'])
  assert.match(m.missing[0], /an issue or plan is not launch authority/)
  assert.equal(startPilot(AUTH(), ACCOUNTS, {}).mode, 'staging')
  assert.throws(() => checkAuthority(AUTH({ arms: [{ id: 'A', offer_id: 'offer-unapproved', sequence: [{ step: 1, delay_days: 0, template_ref: 'x' }] }] })), (e: unknown) => e instanceof PilotError && /not approved/.test((e as Error).message))
  assert.notEqual(authorityHash(AUTH()), authorityHash(AUTH({ seed: 12 })))
})

test('randomised by cohort, balanced, reproducible; never the same prospect in two arms', () => {
  const dupes = [...ACCOUNTS, acct(901, { domain: 'co5.example', contact: { email: 'sales@co5.example', verified: true } }), acct(902, { domain: 'other.example', contact: { email: 'founder@co7.example', verified: true } })]
  const { assigned, skipped } = assignArms(AUTH(), dupes)
  assert.equal(assigned.length, 40)
  assert.deepEqual(new Set(assigned.map(x => x.email)).size, 40)
  assert.equal(skipped.filter(s => /never contacted from two arms/.test(s.reason)).length, 2)
  for (const pair of [['acc-005', 'acc-901'], ['acc-007', 'acc-902']]) assert.equal(assigned.filter(x => pair.includes(x.account)).length, 1, pair.join('/')) // same domain / same address: one of each pair
  for (const cohort of ['agency', 'saas']) { const c = assigned.filter(x => x.cohort === cohort); const a = c.filter(x => x.arm === 'A').length; assert.ok(Math.abs(a - (c.length - a)) <= 1, cohort) }
  assert.deepEqual(assignArms(AUTH(), [...dupes].reverse()), { assigned, skipped })               // input order does not matter
  assert.notDeepEqual(assignArms(AUTH({ seed: 99 }), dupes).assigned.map(x => x.arm), assigned.map(x => x.arm))
})

test('fail closed without approvals: unverified identity or contact, outside the audience or excluded is skipped; out-of-authority is escalated', () => {
  const { assigned, skipped } = assignArms(AUTH(), [
    acct(1, { identity_verified: false }), acct(2, { contact: { email: 'x@co2.example', verified: false } }), acct(3, { contact: null }),
    acct(4, { cohort: 'retail' }), acct(5, { country: 'US' }), acct(6, { domain: 'competitor.example' }), acct(7, { contact: { email: 'ceo@blocked.example', verified: true } }), acct(8, { company: 'Existing Customer Ltd' }),
    acct(9, { needs: { offer: 'offer-discount' } }), acct(10, { needs: { channel: 'linkedin' } }), acct(11, { needs: { sender: 'founder@other.example' } }), acct(12),
  ])
  assert.deepEqual(assigned.map(x => x.account), ['acc-012'])
  const r = Object.fromEntries(skipped.map(s => [s.account, [s.reason.split(':')[0].split(' ').slice(0, 3).join(' '), s.escalate]]))
  assert.deepEqual(r['acc-001'], ['identity not verified', false]); assert.deepEqual(r['acc-002'], ['no verified contact', false]); assert.deepEqual(r['acc-003'], ['no verified contact', false])
  assert.deepEqual(r['acc-004'], ['cohort retail is', false]); assert.deepEqual(r['acc-005'], ['country US is', false])
  for (const k of ['acc-006', 'acc-007', 'acc-008']) assert.deepEqual(r[k], ['excluded by the', false], k)
  for (const k of ['acc-009', 'acc-010', 'acc-011']) assert.equal(r[k][1], true, k)                  // escalated, not sent for approval
})

test('idempotent: re-running a day, or retrying after a crash mid-pass, never sends twice', async () => {
  const p = startPilot(AUTH(), ACCOUNTS.slice(0, 10), {})
  const out = stubSender()
  assert.equal((await tick(p, '2026-11-02', out)).sent, 10)
  assert.equal((await tick(p, '2026-11-02', out)).sent, 0)
  // a crash after the sender accepted 3 but before they were logged: on retry the sender sees the same action ids
  const q = startPilot(AUTH(), ACCOUNTS.slice(0, 10), {})
  let n = 0; const crashing: SendPort = { send: async m => { out.outbox.push(m); if (++n === 4) throw new Error('process killed'); return { ok: true } } }
  await assert.rejects(tick(q, '2026-11-02', crashing))
  await tick(q, '2026-11-02', out)
  const ids = out.outbox.slice(10).map(m => m.action_id)
  assert.equal(new Set(q.log.filter(e => e.t === 'send').map(e => (e as { action_id: string }).action_id)).size, 10) // 10 logged sends, each once
  assert.ok(ids.filter(id => ids.indexOf(id) !== ids.lastIndexOf(id)).length <= 2, 'only the unlogged in-flight action is offered again, with the same id (the provider dedupes on it)')
  // follow-ups wait for their delay, then go once
  assert.equal((await tick(p, '2026-11-04', out)).sent, 0)
  assert.equal((await tick(p, '2026-11-05', out)).sent, 10)
  assert.equal((await tick(p, '2026-11-09', out)).sent, 0)                                               // the sequence is done
})

test('pause stops sending until resumed; the horizon, the spend bound and the daily volume each stop or cap it', async () => {
  const p = startPilot(AUTH(), ACCOUNTS.slice(0, 10), {}); const out = stubSender()
  pause(p, '2026-11-02', 'customer asked to pause')
  assert.deepEqual(await tick(p, '2026-11-02', out), { sent: 0, skipped: ['pilot is paused: customer asked to pause'] })
  resume(p, '2026-11-03'); assert.equal((await tick(p, '2026-11-03', out)).sent, 10)
  const late = startPilot(AUTH(), ACCOUNTS.slice(0, 3), {}); await tick(late, '2026-12-01', out)
  assert.deepEqual([late.state.status, late.state.status_reason], ['stopped', 'horizon reached'])
  const poor = startPilot(AUTH({ spend: { max_usd: 0.2, usd_per_send: 0.05 } }), ACCOUNTS.slice(0, 10), {})
  assert.equal((await tick(poor, '2026-11-02', out)).sent, 4); assert.deepEqual([poor.state.status, poor.state.status_reason], ['stopped', 'spend bound reached'])
  const slow = startPilot(AUTH({ volume: { max_contacts: 100, max_sends_per_day: 3 } }), ACCOUNTS.slice(0, 10), {})
  assert.equal((await tick(slow, '2026-11-02', out)).sent, 3); assert.equal((await tick(slow, '2026-11-03', out)).sent, 3)
})

test('a reply, opt-out or bounce stops that prospect at once; an opt-out suppresses the address for every arm; a health anomaly stops the pilot', async () => {
  const p = startPilot(AUTH(), ACCOUNTS.slice(0, 20), {}); const out = stubSender()
  await tick(p, '2026-11-02', out)
  const [a, b, c] = ['acc-001', 'acc-002', 'acc-003']
  ingest(p, '2026-11-03', { kind: 'reply', account: a, provenance: prov(p, a), qualification: 'unknown' })
  ingest(p, '2026-11-03', { kind: 'opt_out', account: b, provenance: prov(p, b) })
  ingest(p, '2026-11-03', { kind: 'bounce', account: c, provenance: prov(p, c) })
  await tick(p, '2026-11-05', out)
  const followed = out.outbox.filter(m => m.step === 2).map(m => m.to)
  assert.equal(followed.length, 17)
  for (const k of [a, b, c]) assert.ok(!followed.includes(p.state.prospects.get(k)!.email), k)
  assert.ok(p.state.suppressed.has('founder@co2.example'))
  // bounces past the registered rate stop the whole pilot
  const q = startPilot(AUTH(), ACCOUNTS.slice(0, 20), {}); await tick(q, '2026-11-02', out)
  for (const k of ['acc-004', 'acc-005', 'acc-006']) ingest(q, '2026-11-03', { kind: 'bounce', account: k, provenance: prov(q, k) })
  assert.equal(q.state.status, 'stopped'); assert.match(q.state.status_reason, /health: bounce rate 0.150 over 0.1/)
  assert.equal((await tick(q, '2026-11-05', out)).sent, 0)
})

test('outcomes per arm, with denominators and intervals: held meetings only, qualified by an independent verdict; foreign emails never count', async () => {
  const p = startPilot(AUTH(), ACCOUNTS.slice(0, 20), {}); const out = stubSender()
  await tick(p, '2026-11-02', out)
  const inArm = (arm: string) => [...p.state.prospects.entries()].filter(([, x]) => x.arm === arm).map(([k]) => k)
  const [a1, a2, a3, a4] = inArm('A')
  const ev = (e: Record<string, unknown> & { account: string }): OutcomeEvent => ({ ...e, provenance: prov(p, e.account) } as unknown as OutcomeEvent)
  ingest(p, '2026-11-04', ev({ kind: 'reply', account: a1, qualification: 'qualified' }))
  ingest(p, '2026-11-04', ev({ kind: 'reply', account: a2, qualification: 'qualified' }))
  ingest(p, '2026-11-04', ev({ kind: 'reply', account: a3, qualification: 'unknown' }))       // unknown is not qualified
  ingest(p, '2026-11-06', ev({ kind: 'meeting', account: a1, meeting_id: 'm1', status: 'scheduled' }))
  ingest(p, '2026-11-09', ev({ kind: 'meeting', account: a1, meeting_id: 'm1', status: 'held' }))
  ingest(p, '2026-11-06', ev({ kind: 'meeting', account: a2, meeting_id: 'm2', status: 'scheduled' }))
  ingest(p, '2026-11-08', ev({ kind: 'meeting', account: a2, meeting_id: 'm2', status: 'no_show' }))
  ingest(p, '2026-11-06', ev({ kind: 'meeting', account: a4, meeting_id: 'm3', status: 'cancelled' }))
  // a benchmark-generated email's reply, and another pilot's, carry other provenance: ignored
  ingest(p, '2026-11-04', { kind: 'reply', account: a4, qualification: 'qualified', provenance: { pilot_id: 'benchmark-batch', arm: 'A', account: a4 } })
  ingest(p, '2026-11-04', { kind: 'meeting', account: a4, meeting_id: 'm9', status: 'held', provenance: { pilot_id: 'pilot-other', arm: 'A', account: a4 } })
  const r = report(p)
  const A = r.arms.find(x => x.arm === 'A')!
  assert.deepEqual([A.contacted, A.qualified_conversations, A.replies, A.replies_unknown_qualification, A.meetings_held, A.meetings_not_held], [10, 2, 3, 1, 1, { cancelled: 1, no_show: 1, scheduled: 0 }])
  assert.deepEqual(A.qualified_rate, wilson(2, 10)); assert.deepEqual(A.held_rate, wilson(1, 10))
  assert.deepEqual([A.spend_usd, A.cost_per_qualified_usd, A.cost_per_held_meeting_usd], [0.5, 0.25, 0.5])
  const B = r.arms.find(x => x.arm === 'B')!
  assert.deepEqual([B.contacted, B.qualified_conversations, B.meetings_held, B.cost_per_held_meeting_usd], [10, 0, 0, null])
  assert.equal(r.foreign_events_ignored, 2)
  assert.match(r.note, /STAGING: stub sender, nothing was sent/)
  assert.equal(wilson(0, 0), null)
})

test('auditable: replaying the log rebuilds the exact state', async () => {
  const p = startPilot(AUTH(), ACCOUNTS.slice(0, 12), {}); const out = stubSender()
  await tick(p, '2026-11-02', out)
  ingest(p, '2026-11-03', { kind: 'opt_out', account: 'acc-002', provenance: prov(p, 'acc-002') })
  pause(p, '2026-11-04', 'x'); resume(p, '2026-11-05'); await tick(p, '2026-11-05', out)
  const r = replay(p.authority, structuredClone(p.log))
  assert.deepEqual([...r.prospects.entries()], [...p.state.prospects.entries()])
  assert.deepEqual([r.status, r.spent_usd, r.sends, [...r.sent].sort(), [...r.suppressed]], [p.state.status, p.state.spent_usd, p.state.sends, [...p.state.sent].sort(), [...p.state.suppressed]])
  assert.ok(p.log.filter(e => e.t === 'send').every(e => (e as { mode: string }).mode === 'staging'))
})
