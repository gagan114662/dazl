// The deletion state machine, its retry, a second request, the ledger re-application, the shared-workspace refusals
// and the export's redaction, on BOTH stores (review of PR #455: these ran on SQLite only). Two personal workspaces
// with a marked row in every tenant-scoped table (test/helpers/tenant-fixture.ts); the other tenant is byte-identical
// afterwards, identity rows included.
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { tenantFixture, rawTrigger, dropTrigger } from './helpers/tenant-fixture.ts'
import { deleteTenant, exportTenant, reapplyTombstones, tombstone, tombstoneLedgerEntry, EXPORT_EXCLUDED, TombstoneReapplyError, CREDENTIAL_TABLES } from '../lib/tenant/lifecycle.ts'
import { marker } from './helpers/tenant-seed.ts'

const A = 'both-tenant-aaaa', B = 'both-tenant-bbbb', C = 'both-team-cccc', NOW = 1_900_000_000
const BY = 'operator (synthetic both-engines test)'
const POLICY = { suppressions: 'retain' as const }
const fixture = (c: Parameters<Parameters<typeof bothEngines>[1]>[0]) => tenantFixture(c, [[A, 'ba'], [B, 'bb']])
// evidence_purge_audit is always kept (append-only audit, ALWAYS_RETAINED); users and organizations are in the snapshot
const emptyExcept = (snap: Record<string, string>, keep: string[]) => Object.entries(snap).filter(([t, r]) => ![...keep, 'evidence_purge_audit'].includes(t) && r !== '[]').map(([t]) => t)

bothEngines('state machine: staged to revoked (credentials gone, data kept); a failed erase rolls back whole and the deletion resumes to completed', async c => {
  const f = await fixture(c)
  const bBefore = await f.snap(B)
  assert.equal((await deleteTenant(c.db, A, { policy: POLICY, requestedBy: BY, now: NOW, until: 'revoked' })).state, 'revoked')
  const mid = await f.snap(A)
  for (const t of CREDENTIAL_TABLES) assert.equal(mid[t], '[]', `${t} revoked first`)
  assert.notEqual(mid.leads, '[]', 'data not yet erased')
  assert.notEqual(mid.users, '[]', 'the account exists until the erase')
  await rawTrigger(c, 'fail_erase', 'DELETE', 'scan_jobs', "SELECT RAISE(ABORT, 'simulated failure')")
  await assert.rejects(deleteTenant(c.db, A), /simulated failure/)
  assert.equal((await tombstone(c.db, A))!.state, 'cancelled', 'the step before the failed one holds')
  assert.notEqual((await f.snap(A)).leads, '[]', 'the failed step rolled back as a whole')
  await dropTrigger(c, 'fail_erase', 'scan_jobs')
  const t = await deleteTenant(c.db, A)
  assert.equal(t.state, 'completed', 'resumed without the policy being given again')
  assert.deepEqual(JSON.parse(t.retained!), { evidence_purge_audit: 1, suppressions: 1 })
  assert.deepEqual(emptyExcept(await f.snap(A), ['suppressions']), [], 'every other table, users and organizations included, is empty for A')
  assert.deepEqual(await f.snap(B), bBefore, 'B byte-identical, identity rows included')
  assert.equal((await deleteTenant(c.db, A)).state, 'completed', 'a completed deletion re-run is a no-op')
  assert.deepEqual(await f.snap(B), bBefore)
})

// Review (PR #455, R3-3): a second request with another policy must not silently resolve to the first one; and the
// step's own guard against another run moving the state (UPDATE ... WHERE state = from) is exercised.
bothEngines('a second request with a different policy is refused; a state moved by another run fails the step and rolls it back', async c => {
  await fixture(c)
  const t1 = await deleteTenant(c.db, A, { policy: POLICY, requestedBy: 'first', now: NOW, until: 'requested' })
  assert.equal(t1.state, 'requested')
  await assert.rejects(deleteTenant(c.db, A, { policy: { suppressions: 'erase' }, requestedBy: 'second' }), /already recorded \(state requested, requested by first\) with a different policy/)
  await assert.rejects(deleteTenant(c.db, A, { policy: { suppressions: 'retain', retainTables: ['scan_jobs'] }, requestedBy: 'second' }), /different policy/)
  const t2 = (await tombstone(c.db, A))!
  assert.equal(t2.policy, t1.policy); assert.equal(t2.requested_by, 'first'); assert.equal(t2.state, 'requested')
  assert.equal((await deleteTenant(c.db, A, { policy: POLICY, requestedBy: 'second', until: 'requested' })).state, 'requested', 'the same policy again is fine')
  // another run moves the state while this step runs: the step's state change finds 0 rows, the whole step rolls back
  await rawTrigger(c, 'other_run', 'DELETE', 'sessions', `UPDATE tenant_tombstones SET state = 'revoked' WHERE deleted_tenant = OLD.user_id`)
  await assert.rejects(deleteTenant(c.db, A), /expected state requested, another run moved it/)
  assert.equal((await tombstone(c.db, A))!.state, 'requested', 'rolled back, the other run\'s change included')
  assert.equal(Number((await c.db.get<{ n: number }>('SELECT count(*) AS n FROM sessions WHERE user_id = ?', [A]))!.n), 1, 'the credential delete rolled back too')
  await dropTrigger(c, 'other_run', 'sessions')
  assert.equal((await deleteTenant(c.db, A)).state, 'completed')
})

bothEngines('restored store: every ledger line is re-applied with its original request time; a refused line is reported and does not stop the others', async c => {
  const f = await fixture(c)
  // both erased whole, so the "restore" below can seed the same rows again (a retained suppression would collide)
  const ledger = [
    tombstoneLedgerEntry(await deleteTenant(c.db, A, { policy: { suppressions: 'erase' }, requestedBy: BY, now: NOW })),
    'not a ledger line',
    tombstoneLedgerEntry(await deleteTenant(c.db, B, { policy: { suppressions: 'erase' }, requestedBy: BY, now: NOW + 1 })),
  ]
  assert.ok(!ledger[0].includes('ba~') && !ledger[2].includes('bb~'), 'no tenant data in the ledger')
  // "restore": the rows are back and the tombstones are gone (a backup from before the deletions), and since the
  // backup someone else joined A's workspace
  await c.db.run('DELETE FROM tenant_tombstone_keys'); await c.db.run('DELETE FROM tenant_tombstones')
  await fixture(c)
  await c.db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'c', 'team', 'someone', 1)", [C])
  await c.db.run("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, 'both-other-dddd', 'viewer', 1)", [A])
  const aBefore = await f.snap(A)
  const err = await reapplyTombstones(c.db, ledger, NOW + 3600).then(() => assert.fail('expected a refusal'), (e: unknown) => e)
  assert.ok(err instanceof TombstoneReapplyError, String(err))
  assert.deepEqual(err.failed.map(x => x.tenant), [A, 'ledger line 2'])
  assert.match(err.failed[0].reason, /other members/)
  assert.deepEqual(err.applied, [{ tenant: B, state: 'completed' }])
  const b = (await tombstone(c.db, B))!
  assert.equal(b.state, 'completed'); assert.equal(Number(b.requested_at), NOW + 1, 'the original request time'); assert.equal(Number(b.completed_at), NOW + 3600)
  assert.equal(b.requested_by, `${BY} (re-applied after restore)`)
  assert.deepEqual(emptyExcept(await f.snap(B), []), [], 'B is gone again')
  assert.equal(await tombstone(c.db, A), undefined, 'the refused tenant has no tombstone')
  assert.deepEqual(await f.snap(A), aBefore, 'and nothing of it changed')
})

bothEngines('shared workspaces are refused, never guessed: a team workspace, other members, a founder in another workspace; nothing changes', async c => {
  const f = await fixture(c)
  await c.db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'c', 'team', 'someone', 1)", [C])
  const cases: [string, () => Promise<unknown>, RegExp][] = [
    ['team', () => c.db.run("UPDATE organizations SET kind = 'team' WHERE id = ?", [A]), /team workspaces cannot be deleted yet/],
    ['member', () => c.db.run("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, 'viewer', 1)", [A, B]), /other members/],
    ['elsewhere', () => c.db.run("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, 'viewer', 1)", [C, A]), /founder belongs to another workspace/],
  ]
  for (const [name, setup, why] of cases) {
    await setup()
    const before = await f.snap(A)
    await assert.rejects(deleteTenant(c.db, A, { policy: POLICY, requestedBy: BY }), why, name)
    assert.equal(await tombstone(c.db, A), undefined, `${name}: no tombstone`)
    assert.deepEqual(await f.snap(A), before, `${name}: nothing changed`)
    // undo for the next case
    await c.db.run("UPDATE organizations SET kind = 'personal' WHERE id = ?", [A])
    await c.db.run('DELETE FROM memberships WHERE (tenant_id = ? AND member_id = ?) OR (tenant_id = ? AND member_id = ?)', [A, B, C, A])
  }
  assert.equal((await deleteTenant(c.db, A, { policy: POLICY, requestedBy: BY })).state, 'completed', 'a personal workspace with its founder as sole member deletes')
})

// Review (PR #455, R3-4, R3-9): the export carries the workspace row and no token material.
bothEngines('export: every table the tenant has rows in plus its users and organizations rows, nothing of the other tenant, credentials and token hashes redacted, session state left out', async c => {
  await fixture(c)
  // distinct from the seed's markers, so their absence from the export is meaningful
  await c.db.run('UPDATE email_tokens SET token_hash = ? WHERE user_id = ?', ['TOKEN-HASH-OF-A-EMAIL', A])
  await c.db.run('UPDATE invitations SET token_hash = ? WHERE tenant_id = ?', ['TOKEN-HASH-OF-A-INVITE', A])
  const hashes = [
    ...(await c.db.all<{ h: string }>('SELECT token_hash AS h FROM email_tokens WHERE user_id = ?', [A])).map(r => r.h),
    ...(await c.db.all<{ h: string }>('SELECT token_hash AS h FROM invitations WHERE tenant_id = ?', [A])).map(r => r.h),
  ]
  assert.deepEqual(hashes, ['TOKEN-HASH-OF-A-EMAIL', 'TOKEN-HASH-OF-A-INVITE'])
  const e = await exportTenant(c.db, A, new Date(NOW * 1000))
  const json = JSON.stringify(e)
  assert.equal(e.tables.users?.length, 1)
  assert.equal(e.tables.organizations?.length, 1, 'the workspace row is exported')
  assert.equal(e.tables.organizations![0].id, A)
  assert.equal(e.tables.organizations![0].name, `${A} workspace`)
  for (const t of Object.keys(EXPORT_EXCLUDED)) assert.equal(e.tables[t], undefined, `${t} left out`)
  assert.ok(!json.includes('bb~'), 'nothing of the other tenant')
  for (const h of hashes) assert.ok(!json.includes(h), 'no token hash exported')
  for (const col of ['tenant_llm_keys.ciphertext', 'users.password_hash', 'users.salt', 'gmail_accounts.refresh_ct', 'email_tokens.token_hash', 'invitations.token_hash']) assert.ok(e.redacted_columns.includes(col), col)
  assert.ok(json.includes(marker('ba', 'leads')) && json.includes(marker('ba', 'lead_sources')), 'parent-scoped rows included')
})
