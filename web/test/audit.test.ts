// Durable audit trail (lib/audit.ts, #371), on both engines: append-only in the database, redacted summaries, an
// attributable event for every member, session and recovery action built so far, and searches scoped to one workspace.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPasswordUser, createSession } from '../lib/auth-db.ts'
import { linkGoogle } from '../lib/auth-google.ts'
import { AUDIT_RETAIN_S, purgeAudit, record, redact, searchAudit } from '../lib/audit.ts'
import { requestEmailChange, requestReset, resetPassword, verifyEmail } from '../lib/email-ownership.ts'
import { listSessions, revokeAllSessions, revokeSession } from '../lib/sessions.ts'
import { MemberError, acceptInvitation, changeRole, createInvitation, removeMember, revokeInvitation } from '../lib/workspace-members.ts'
import type { Db } from '../lib/db/client.ts'
import { bothEngines } from './helpers/engines.ts'

const NOW = Math.floor(Date.now() / 1000)
async function users(db: Db, ...ids: string[]) {
  for (const id of ids) await createPasswordUser({ id, email: `${id.toLowerCase()}@example.test`, name: id, business_name: id, password_hash: 'h', salt: 's' }, db)
  for (const id of ids) await db.run('UPDATE users SET email_verified_at = 1 WHERE id = ?', [id])
}
const actions = async (db: Db, tenant: string) => (await searchAudit(db, tenant)).map(e => `${e.decision} ${e.action} ${e.actor_id}${e.resource_id ? ` ${e.resource_id}` : ''}`).reverse()
const all = (db: Db) => db.all<Record<string, unknown>>('SELECT * FROM audit_events')

bothEngines('events are append-only in the database; only the retention purge deletes, and only old events', async ({ db }) => {
  await record(db, { tenantId: 'A', actorId: 'A', action: 'x.old', resourceType: 't' }, NOW - AUDIT_RETAIN_S - 10)
  await record(db, { tenantId: 'A', actorId: 'A', action: 'x.new', resourceType: 't' }, NOW)
  await assert.rejects(db.run("UPDATE audit_events SET action = 'tampered'"))
  await assert.rejects(db.run('DELETE FROM audit_events'))
  assert.equal((await all(db)).length, 2)
  assert.equal(await purgeAudit(db, { now: NOW }), 1)
  assert.deepEqual((await searchAudit(db, 'A')).map(e => e.action), ['x.new'])
  assert.equal((await db.all('SELECT * FROM audit_purge_gate')).length, 0, 'the gate exists only inside the purge')
  await assert.rejects(db.run('DELETE FROM audit_events'), 'still append-only after a purge')
})

test('summaries keep short scalars only: no secrets, tokens, hashes or message content', () => {
  assert.deepEqual(redact({ role: 'admin', count: 3, ok: true, none: null, password: 'hunter22', api_key: 'x', token: 't', reply_body: 'hi', text: 'msg',
    note: 'a'.repeat(121), nested: { a: 1 }, hexy: 'f'.repeat(64), stripe: 'sk_live_abc', 'bad key': 1 }), { role: 'admin', count: 3, ok: true, none: null })
})

bothEngines('member changes: each allowed change and each policy refusal is an attributable event; no token is recorded', async ({ db }) => {
  await users(db, 'A', 'D', 'O', 'N')
  await db.run("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES ('A', 'D', 'admin', 1), ('A', 'O', 'operator', 1)")
  const owner = { tenantId: 'A', actorId: 'A', role: 'owner' as const, correlationId: 'req-1' }, admin = { tenantId: 'A', actorId: 'D', role: 'admin' as const }
  await changeRole(db, admin, 'O', 'viewer')
  await assert.rejects(changeRole(db, admin, 'A', 'viewer'), (e: unknown) => e instanceof MemberError && e.code === 'forbidden')
  await assert.rejects(changeRole(db, owner, 'A', 'admin'), (e: unknown) => e instanceof MemberError && e.code === 'last_owner')
  const inv = await createInvitation(db, owner, 'n@example.test', 'operator')
  await acceptInvitation(db, { actorId: 'N', email: 'n@example.test' }, inv.token)
  const inv2 = await createInvitation(db, owner, 'x@example.test', 'viewer')
  await revokeInvitation(db, owner, inv2.id)
  await removeMember(db, owner, 'O')
  assert.deepEqual(await actions(db, 'A'), [
    'allowed member.role_changed D O', 'denied member.role_changed D A', 'denied member.role_changed A A',
    `allowed invitation.created A ${inv.id}`, `allowed invitation.accepted N ${inv.id}`, `allowed invitation.created A ${inv2.id}`,
    `allowed invitation.revoked A ${inv2.id}`, 'allowed member.removed A O'])
  const ev = await searchAudit(db, 'A')
  assert.deepEqual(ev.find(e => e.action === 'member.role_changed' && e.decision === 'allowed')!.summary, { from: 'operator', to: 'viewer' })
  assert.equal(ev.find(e => e.decision === 'denied' && e.actor_id === 'A')!.summary.reason, 'last_owner')
  assert.equal(ev.find(e => e.action === 'member.removed')!.correlation_id, 'req-1')
  const text = JSON.stringify(await all(db))
  for (const t of [inv.token, inv2.token]) assert.ok(!text.includes(t))
  assert.deepEqual(await searchAudit(db, 'D'), [], "another workspace's search sees none of A's events")
})

bothEngines('sessions and recovery: revokes, password reset, email change and Google linking are recorded on the account', async ({ db }) => {
  await users(db, 'P')
  const s1 = await createSession('P', db); await createSession('P', db)
  const [first] = await listSessions(db, 'P', null)
  await revokeSession(db, 'P', first.public_id, 'P')
  await revokeAllSessions(db, 'P', { by: 'P', reason: 'revoked_all' })
  await requestReset(db, 'p@example.test')
  const token = /reset#t=([a-f0-9]{64})/.exec((await db.get<{ body: string }>("SELECT body FROM system_mail_outbox WHERE subject LIKE 'Reset%'"))!.body)![1]
  await resetPassword(db, token, { password_hash: 'new', salt: 'new' })
  await requestEmailChange(db, 'P', 'p2@example.test')
  const change = /verify#t=([a-f0-9]{64})/.exec((await db.get<{ body: string }>("SELECT body FROM system_mail_outbox WHERE to_email = 'p2@example.test'"))!.body)![1]
  await verifyEmail(db, change)
  await linkGoogle(db, 'P', { sub: 'g-p', email: 'p2@example.test', name: 'P' })
  assert.deepEqual(await actions(db, 'P'), [`allowed session.revoked P ${first.public_id}`, 'allowed session.revoked_all P P', 'allowed account.password_reset P P',
    'allowed session.revoked_all P P', 'allowed account.email_changed P P', 'allowed account.google_linked P P'])
  const rec = (await searchAudit(db, 'P')).filter(e => e.action === 'session.revoked_all').map(e => e.summary.reason)
  assert.deepEqual(rec.sort(), ['recovery', 'revoked_all'])
  const text = JSON.stringify(await all(db))
  for (const t of [s1, token, change]) assert.ok(!text.includes(t), 'no session or link token in the trail')
})
