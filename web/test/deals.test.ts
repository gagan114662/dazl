// #366 (first slice): deals on both engines. A qualified conversation becomes a deal with a workspace member as owner,
// moves through audited stages and closes won (amount + currency) or lost (reason); history rebuilds any past stage;
// stale writes and concurrent edits never both win; revenue sums per currency without double counting; tenants are
// separate. Synthetic rows only.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { bothEngines } from './helpers/engines.ts'
import type { Db } from '../lib/db/client.ts'
import { assignDeal, createDeal, DealError, dealHistory, listDeals, moveDeal, reopenDeal, revenueReport, stageAt } from '../lib/pipeline/deals.ts'

async function seed(db: Db, t: string, opts: { reply?: string | null; booking?: boolean } = {}) {
  await db.run('INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, ?, 1)', [t, `${t}-owner`, 'owner'])
  await db.run('INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, ?, 1)', [t, `${t}-rep`, 'operator'])
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, 'b', 'i', 'l', 'running')", [`job-${t}`, t])
  for (const n of [1, 2]) await db.run("INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url) VALUES (?, ?, ?, ?, 's', 'https://news.example/a')", [`lead-${t}-${n}`, `job-${t}`, `Buyer ${n}`, `p${n}@buyer.example`])
  if (opts.reply !== null) await db.run('INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
    [`g-${t}`, t, `th-${t}`, `lead-${t}-1`, 'p1@buyer.example', 'Sounds interesting, tell me more', opts.reply ?? 'positive'])
  if (opts.booking) await db.run('INSERT INTO calcom_bookings (tenant_id, booking_uid, attendee_email, lead_id, created_at) VALUES (?, ?, ?, ?, 1)', [t, `bk-${t}`, 'p2@buyer.example', `lead-${t}-2`])
}
const err = async (f: () => Promise<unknown>) => { try { await f(); return null } catch (e) { return e instanceof DealError ? e.code : String(e) } }

bothEngines('only a qualified conversation starts a deal; the owner must be a workspace member; one open deal per lead', async ({ db }) => {
  await seed(db, 'A', { booking: true })
  assert.equal(await err(() => createDeal(db, 'A', { leadId: 'lead-A-1', ownerId: 'A-rep', actor: 'A-owner' })), null)
  // lead 2 has only a booking: qualified too
  assert.equal((await createDeal(db, 'A', { leadId: 'lead-A-2', ownerId: 'A-rep', actor: 'A-owner' })).stage, 'qualified')
  assert.equal(await err(() => createDeal(db, 'A', { leadId: 'lead-A-1', ownerId: 'A-rep', actor: 'A-owner' })), 'deal_exists')
  await seed(db, 'B', { reply: null })
  assert.equal(await err(() => createDeal(db, 'B', { leadId: 'lead-B-1', ownerId: 'B-rep', actor: 'B-owner' })), 'not_qualified', 'no reply, no booking')
  await db.run("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES ('gn', 'B', 'tn', 'lead-B-1', 'p1@buyer.example', 'No thanks', 'negative', 2)")
  assert.equal(await err(() => createDeal(db, 'B', { leadId: 'lead-B-1', ownerId: 'B-rep', actor: 'B-owner' })), 'not_qualified', 'a no is not a qualified conversation')
  await db.run("UPDATE inbound_messages SET classification = 'other' WHERE gmail_id = 'gn'")
  assert.equal(await err(() => createDeal(db, 'B', { leadId: 'lead-B-1', ownerId: 'A-rep', actor: 'B-owner' })), 'owner_not_member', "another workspace's member")
  assert.equal(await err(() => createDeal(db, 'B', { leadId: 'lead-A-2', ownerId: 'B-rep', actor: 'B-owner' })), 'not_found', "another tenant's lead")
  assert.equal(await err(() => createDeal(db, 'B', { leadId: 'lead-B-1', ownerId: 'B-rep', actor: 'B-owner' })), null)
})

bothEngines('stages: won needs amount and currency, lost a reason; a closed deal moves only after a reopen with a reason', async ({ db }) => {
  await seed(db, 'A')
  let d = await createDeal(db, 'A', { leadId: 'lead-A-1', ownerId: 'A-rep', actor: 'A-owner', now: 100 })
  d = await moveDeal(db, 'A', d.id, { to: 'meeting', actor: 'A-rep', version: d.version, now: 200 })
  d = await moveDeal(db, 'A', d.id, { to: 'proposal', actor: 'A-rep', version: d.version, amountMinor: 500000, currency: 'usd', now: 300 })
  assert.deepEqual([d.stage, d.amount_minor, d.currency], ['proposal', 500000, 'USD'])
  assert.equal(await err(() => moveDeal(db, 'A', d.id, { to: 'lost', actor: 'A-rep', version: d.version })), 'lost_needs_reason')
  assert.equal(await err(() => moveDeal(db, 'A', d.id, { to: 'won', actor: 'A-rep', version: d.version, currency: 'US' })), 'bad_currency')
  assert.equal(await err(() => moveDeal(db, 'A', d.id, { to: 'won', actor: 'A-rep', version: d.version, amountMinor: -5 })), 'bad_amount')
  d = await moveDeal(db, 'A', d.id, { to: 'won', actor: 'A-rep', version: d.version, closeDate: '2026-11-30', now: 400 })
  assert.deepEqual([d.stage, d.close_date], ['won', '2026-11-30'])
  assert.equal(await err(() => moveDeal(db, 'A', d.id, { to: 'negotiation', actor: 'A-rep', version: d.version })), 'closed')
  assert.equal(await err(() => reopenDeal(db, 'A', d.id, { actor: 'A-owner', version: d.version, reason: ' ' })), 'reopen_needs_reason')
  d = await reopenDeal(db, 'A', d.id, { actor: 'A-owner', version: d.version, reason: 'Contract fell through', now: 500 })
  d = await moveDeal(db, 'A', d.id, { to: 'lost', actor: 'A-rep', version: d.version, reason: 'Chose a competitor', now: 600 })
  assert.deepEqual([d.stage, d.close_reason], ['lost', 'Chose a competitor'])
  // the whole history, with who and when; any past stage can be rebuilt from it
  assert.deepEqual((await dealHistory(db, 'A', d.id)).map(e => [e.kind, e.from_stage, e.to_stage, e.actor, e.at]), [
    ['created', null, 'qualified', 'A-owner', 100], ['moved', 'qualified', 'meeting', 'A-rep', 200], ['moved', 'meeting', 'proposal', 'A-rep', 300],
    ['moved', 'proposal', 'won', 'A-rep', 400], ['reopened', 'won', 'qualified', 'A-owner', 500], ['moved', 'qualified', 'lost', 'A-rep', 600]])
  assert.deepEqual(await Promise.all([50, 150, 350, 450, 550, 700].map(t => stageAt(db, 'A', d.id, t))), [null, 'qualified', 'proposal', 'won', 'qualified', 'lost'])
})

bothEngines('a stale version is refused; two concurrent edits from the same version: exactly one wins', async ({ db }) => {
  await seed(db, 'A')
  const d = await createDeal(db, 'A', { leadId: 'lead-A-1', ownerId: 'A-rep', actor: 'A-owner' })
  const rs = await Promise.allSettled([
    moveDeal(db, 'A', d.id, { to: 'meeting', actor: 'A-rep', version: d.version }),
    assignDeal(db, 'A', d.id, { ownerId: 'A-owner', actor: 'A-owner', version: d.version }),
  ])
  assert.equal(rs.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(rs.filter(r => r.status === 'rejected' && (r.reason as DealError).code === 'stale').length, 1)
  assert.equal(await err(() => moveDeal(db, 'A', d.id, { to: 'proposal', actor: 'A-rep', version: d.version })), 'stale')
  assert.equal((await dealHistory(db, 'A', d.id)).length, 2, 'only the winner was recorded')
})

bothEngines('revenue: won summed per currency, never across currencies; each deal counted once; tenants separate', async ({ db }) => {
  await seed(db, 'A', { booking: true }); await seed(db, 'B')
  const won = async (t: string, lead: string, amount: number, currency: string) => {
    let d = await createDeal(db, t, { leadId: lead, ownerId: `${t}-rep`, actor: `${t}-owner` })
    d = await moveDeal(db, t, d.id, { to: 'won', actor: `${t}-rep`, version: d.version, amountMinor: amount, currency })
    return d
  }
  const d1 = await won('A', 'lead-A-1', 100000, 'USD')
  // the same lead won again after a reopen is still one deal, counted once with its final amount
  let r = await reopenDeal(db, 'A', d1.id, { actor: 'A-owner', version: d1.version, reason: 'Upsell renegotiated' })
  r = await moveDeal(db, 'A', d1.id, { to: 'won', actor: 'A-rep', version: r.version, amountMinor: 150000 })
  await won('A', 'lead-A-2', 90000, 'EUR')
  await won('B', 'lead-B-1', 999999, 'USD')
  assert.deepEqual(await revenueReport(db, 'A'), { open: { qualified: 0, meeting: 0, proposal: 0, negotiation: 0 }, won: [{ currency: 'EUR', deals: 1, amount_minor: 90000 }, { currency: 'USD', deals: 1, amount_minor: 150000 }], lost: 0 })
  assert.deepEqual((await listDeals(db, 'A')).map(d => d.lead_id).sort(), ['lead-A-1', 'lead-A-2'])
  // B cannot read or touch A's deal
  assert.deepEqual(await dealHistory(db, 'B', d1.id), [])
  assert.equal(await err(() => moveDeal(db, 'B', d1.id, { to: 'lost', actor: 'B-rep', version: r.version, reason: 'x' })), 'not_found')
  assert.equal(await err(() => assignDeal(db, 'A', d1.id, { ownerId: 'B-rep', actor: 'A-owner', version: r.version })), 'owner_not_member')
})

test("routes: 'GET /api/deals' and 'POST /api/deals' through the real handler, roles and tenants", () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs',
    '--test', './test/helpers/deals-route-runtime.mts'], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 1\b/)
})
