// The recreation guard's UPDATE half (review hold on f1c713bb, PR #455): the invariant is that ownership and parent
// keys can never be MOVED under a tombstoned tenant or a deleted parent row, not only that rows cannot be inserted
// there. On both stores, with a marked row in every tenant-scoped table for two tenants A and B, A is deleted (or its
// deletion is in progress) and every way of re-pointing one of B's rows at A is refused: the tenant column of every
// directly scoped table, the parent key of every parent-scoped table (onto A's deleted parent, and onto A's retained
// or not-yet-erased parent), and the ids of users and organizations. B's data stays byte-identical, B's own ordinary
// updates (other columns, the same owner, another of B's parents) still succeed, and the guard count is held.
import assert from 'node:assert/strict'
import { bothEngines, type EngineCtx } from './helpers/engines.ts'
import { deleteTenant, tenantScope, tombstone, type Scope } from '../lib/tenant/lifecycle.ts'
import { guardTriggers, tableColumns, ACCOUNT_COLUMNS, UNGUARDED } from '../lib/db/tenant-guard.ts'
import { tenantFixture, type Fixture } from './helpers/tenant-fixture.ts'

const A = 'guard-tenant-aaaa', B = 'guard-tenant-bbbb', NOW = 1_900_000_000
const BY = 'operator (synthetic guard test)'
// Tables whose own triggers also refuse every UPDATE (append-only audit, immutable evidence copies): an ownership move
// there is refused with whichever guard fires first, which differs by engine.
const IMMUTABLE: Record<string, RegExp> = { evidence_purge_audit: /tenant deleted|append-only/, lead_evidence_copies: /tenant deleted|immutable/ }
// Tables with another BEFORE INSERT trigger: Postgres fires them in name order, so leads_only_while_running (the
// parent scan is gone) answers before tomb_leads there; the guard itself on a leads INSERT is held by the "late inserts
// under a deleted parent" and "parent chain onto a retained parent" cases.
const OTHER_INSERT: Record<string, RegExp> = { leads: /tenant deleted|only be added to a running job/ }

const fixture = (c: EngineCtx) => tenantFixture(c, [[A, 'ga'], [B, 'gb']])
const guarded = async (c: EngineCtx) => (await tenantScope(c.db)).filter(s => !UNGUARDED.has(s.table))
// The UPDATE that moves B's rows of one table under A: its tenant column, or its parent key onto A's parent row.
function move(s: Scope, f: Fixture): [string, string[]] {
  if (s.how === 'direct') return [`UPDATE "${s.table}" SET "${s.col}" = ? WHERE "${s.col}" = ?`, [A, B]]
  return [`UPDATE "${s.table}" SET "${s.col}" = ? WHERE "${s.col}" = ?`, [f.ids[A][s.parent], f.ids[B][s.parent]]]
}
async function refused(c: EngineCtx, sql: string, params: unknown[], what: string, why = /tenant deleted/) {
  await assert.rejects(c.db.run(sql, params as never), why, `${what}: ${sql}`)
}
const rows = async (c: EngineCtx, sql: string, params: unknown[]) => Number((await c.db.get<{ n: number }>(sql, params as never))?.n)

bothEngines('review negative: after a completed deletion, an UPDATE moving another tenant\'s row under the deleted tenant is refused', async c => {
  const f = await fixture(c)
  const bBefore = await f.snap(B)
  const t = await deleteTenant(c.db, A, { policy: { suppressions: 'erase' }, requestedBy: BY, now: NOW })
  assert.equal(t.state, 'completed')
  // the review's reproduction: B's tenant_memory row re-owned by A
  await refused(c, 'UPDATE tenant_memory SET tenant_id = ? WHERE tenant_id = ?', [A, B], 'tenant_memory ownership move')
  assert.equal(await rows(c, 'SELECT count(*) AS n FROM tenant_memory WHERE tenant_id = ?', [A]), 0, 'no row exists for the deleted tenant')
  assert.equal(await rows(c, 'SELECT count(*) AS n FROM tenant_memory WHERE tenant_id = ?', [B]), 1, 'B still owns its row')
  assert.deepEqual(await f.snap(B), bBefore, 'the other tenant is byte-identical')
})

bothEngines('every guarded table: direct ownership moves and parent-key moves under the deleted tenant are refused; users and organizations ids too', async c => {
  const f = await fixture(c)
  const bBefore = await f.snap(B)
  await deleteTenant(c.db, A, { policy: { suppressions: 'erase' }, requestedBy: BY, now: NOW })
  const scope = await guarded(c)
  assert.ok(scope.length >= 70, `${scope.length} guarded tables`)
  for (const s of scope) {
    const [sql, params] = move(s, f)
    await refused(c, sql, params, `${s.table} (${s.how} ${s.col})`, IMMUTABLE[s.table] ?? /tenant deleted/)
  }
  // the tenant's own identity rows: an account or workspace renamed onto the deleted id
  await refused(c, 'UPDATE users SET id = ? WHERE id = ?', [A, B], 'users.id')
  await refused(c, 'UPDATE organizations SET id = ? WHERE id = ?', [A, B], 'organizations.id')
  assert.deepEqual(await f.snap(B), bBefore, 'the other tenant is byte-identical after every refused move')
  assert.deepEqual(Object.entries(await f.snap(A)).filter(([t, v]) => t !== 'evidence_purge_audit' && v !== '[]').map(([t]) => t), [], 'nothing exists for the deleted tenant')
})

bothEngines('parent chain onto a retained parent: a lead moved to the deleted tenant\'s kept scan, a source to its kept lead, are refused; retained rows stay editable', async c => {
  const f = await fixture(c)
  const bBefore = await f.snap(B)
  const t = await deleteTenant(c.db, A, { policy: { suppressions: 'retain', retainTables: ['scan_jobs', 'leads', 'lead_sources'] }, requestedBy: BY, now: NOW })
  assert.equal(t.state, 'completed')
  assert.equal(await rows(c, 'SELECT count(*) AS n FROM scan_jobs WHERE id = ?', [f.ids[A].scan_jobs]), 1, 'A\'s scan job is retained (so a foreign key alone would allow the move)')
  const aAfter = await f.snap(A)
  await refused(c, 'UPDATE leads SET scan_job_id = ? WHERE scan_job_id = ?', [f.ids[A].scan_jobs, f.ids[B].scan_jobs], 'lead under the retained scan')
  await refused(c, 'UPDATE lead_sources SET lead_id = ? WHERE lead_id = ?', [f.ids[A].leads, f.ids[B].leads], 'source under the retained lead')
  await refused(c, 'UPDATE suppressions SET tenant_id = ? WHERE tenant_id = ?', [A, B], 'suppression re-owned by the deleted tenant (a retained table)')
  await refused(c, 'UPDATE scan_jobs SET user_id = ? WHERE user_id = ?', [A, B], 'scan re-owned by the deleted tenant (a retained table)')
  assert.deepEqual(await f.snap(A), aAfter, 'the retained rows are unchanged by the refused moves')
  assert.deepEqual(await f.snap(B), bBefore, 'the other tenant is byte-identical')
  // a retained row's other columns are still editable: retention keeps the rows usable, it does not freeze them
  assert.deepEqual(await c.db.run("UPDATE suppressions SET reason = 'manual' WHERE tenant_id = ?", [A]), { changes: 1 })
})

bothEngines('during a staged deletion (requested, revoked, cancelled): moves under the tenant and under its not-yet-erased parents are refused; the deletion then completes', async c => {
  const f = await fixture(c)
  const bBefore = await f.snap(B)
  const probe = async (stage: string) => {
    await refused(c, 'UPDATE tenant_memory SET tenant_id = ? WHERE tenant_id = ?', [A, B], `${stage}: tenant_memory`)
    await refused(c, 'UPDATE leads SET scan_job_id = ? WHERE scan_job_id = ?', [f.ids[A].scan_jobs, f.ids[B].scan_jobs], `${stage}: lead under A's scan`)
    await refused(c, 'UPDATE lead_sources SET lead_id = ? WHERE lead_id = ?', [f.ids[A].leads, f.ids[B].leads], `${stage}: source under A's lead`)
    await refused(c, 'UPDATE commenter_rows SET batch_id = ? WHERE batch_id = ?', [f.ids[A].commenter_batches, f.ids[B].commenter_batches], `${stage}: row under A's batch`)
    await refused(c, 'UPDATE users SET id = ? WHERE id = ?', [A, B], `${stage}: users.id`)
    await refused(c, 'UPDATE organizations SET id = ? WHERE id = ?', [A, B], `${stage}: organizations.id`)
    assert.deepEqual(await f.snap(B), bBefore, `${stage}: the other tenant is byte-identical`)
  }
  for (const until of ['requested', 'revoked', 'cancelled'] as const) {
    const t = await deleteTenant(c.db, A, { policy: { suppressions: 'erase' }, requestedBy: BY, now: NOW, until })
    assert.equal(t.state, until)
    assert.equal(await rows(c, 'SELECT count(*) AS n FROM scan_jobs WHERE id = ?', [f.ids[A].scan_jobs]), 1, `${until}: A's scan job still exists`)
    await probe(until)
  }
  assert.equal((await deleteTenant(c.db, A)).state, 'completed', 'the staged deletion resumes and completes after the refused moves')
  await probe('completed')
  assert.deepEqual(Object.entries(await f.snap(A)).filter(([t, v]) => t !== 'evidence_purge_audit' && v !== '[]').map(([t]) => t), [])
})

bothEngines('allowed: the other tenant\'s ordinary updates still succeed: other columns, the same owner, one of its own parents', async c => {
  const f = await fixture(c)
  await deleteTenant(c.db, A, { policy: { suppressions: 'erase' }, requestedBy: BY, now: NOW })
  assert.deepEqual(await c.db.run("UPDATE tenant_memory SET tone = 'warm' WHERE tenant_id = ?", [B]), { changes: 1 }, 'another column')
  assert.deepEqual(await c.db.run('UPDATE tenant_memory SET tenant_id = ? WHERE tenant_id = ?', [B, B]), { changes: 1 }, 'the same owner')
  assert.deepEqual(await c.db.run("UPDATE organizations SET name = 'renamed' WHERE id = ?", [B]), { changes: 1 }, 'the workspace profile')
  assert.deepEqual(await c.db.run('UPDATE users SET id = ? WHERE id = ?', [B, B]), { changes: 1 }, 'the same account id')
  // a lead moved between two of B's own scans, and back
  await c.db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES ('b-second-scan', ?, 'x', 'y', 'z')", [B])
  assert.deepEqual(await c.db.run('UPDATE leads SET scan_job_id = ? WHERE scan_job_id = ?', ['b-second-scan', f.ids[B].scan_jobs]), { changes: 1 }, 'a parent change within the same tenant')
  assert.deepEqual(await c.db.run('UPDATE leads SET scan_job_id = ? WHERE scan_job_id = ?', [f.ids[B].scan_jobs, 'b-second-scan']), { changes: 1 })
  assert.deepEqual(await c.db.run('UPDATE lead_sources SET lead_id = ? WHERE lead_id = ?', [f.ids[B].leads, f.ids[B].leads]), { changes: 1 }, 'the same parent')
  assert.equal(await rows(c, 'SELECT count(*) AS n FROM tenant_memory WHERE tenant_id = ?', [B]), 1)
  assert.equal((await tombstone(c.db, A))?.state, 'completed')
})

// Review (PR #455, R3-1): the UPDATE guard checked only the new value, so a tombstoned tenant's row could be moved OUT
// to another tenant and its data survive the erase under the new owner. Every guarded table, during the held
// deletion: moving A's row to B (its tenant column, or its parent key onto B's parent) is refused and A's data is
// unchanged; the reviewer's case, A's scan re-owned by B, first.
bothEngines('review negative (R3-1): during a held deletion, moving the deleted tenant\'s rows OUT to another tenant is refused, every guarded table', async c => {
  const f = await fixture(c)
  assert.equal((await deleteTenant(c.db, A, { policy: { suppressions: 'erase' }, requestedBy: BY, now: NOW, until: 'requested' })).state, 'requested')
  const aBefore = await f.snap(A), bBefore = await f.snap(B)
  await refused(c, 'UPDATE scan_jobs SET user_id = ? WHERE user_id = ?', [B, A], "the reviewer's case: A's scan re-owned by B")
  for (const s of await guarded(c)) {
    const [sql, params] = s.how === 'direct'
      ? [`UPDATE "${s.table}" SET "${s.col}" = ? WHERE "${s.col}" = ?`, [B, A]]
      : [`UPDATE "${s.table}" SET "${s.col}" = ? WHERE "${s.col}" = ?`, [f.ids[B][s.parent], f.ids[A][s.parent]]]
    await refused(c, sql, params, `${s.table} moved out of the deleted tenant`, IMMUTABLE[s.table])
  }
  await refused(c, 'UPDATE memberships SET member_id = ? WHERE member_id = ?', [B, A], "A's own membership re-pointed")
  assert.deepEqual(await f.snap(A), aBefore, 'nothing of A moved')
  assert.deepEqual(await f.snap(B), bBefore, 'nothing arrived at B')
  // the deletion completes; B's data is still only B's
  assert.equal((await deleteTenant(c.db, A)).state, 'completed')
  assert.deepEqual(await f.snap(B), bBefore)
})

// Review (PR #455, R3-5): the INSERT guard, registry-driven on both engines: after the deletion, a copy of B's row in
// every guarded table, re-owned by A (its tenant column, or its parent key onto A's deleted parent), is refused.
bothEngines('every guarded table: inserting a row for the deleted tenant, or under its deleted parent, is refused', async c => {
  const f = await fixture(c)
  const bBefore = await f.snap(B)
  assert.equal((await deleteTenant(c.db, A, { policy: { suppressions: 'erase' }, requestedBy: BY, now: NOW })).state, 'completed')
  const cols = await tableColumns(c.db)
  let swept = 0
  for (const s of await guarded(c)) {
    const cs = cols.get(s.table)!
    const [asA, ofB] = s.how === 'direct' ? [A, B] : [f.ids[A][s.parent], f.ids[B][s.parent]]
    const sql = `INSERT INTO "${s.table}" (${cs.map(x => `"${x}"`).join(', ')}) SELECT ${cs.map(x => x === s.col ? 'CAST(? AS TEXT)' : `"${x}"`).join(', ')} FROM "${s.table}" WHERE "${s.col}" = ?`
    await refused(c, sql, [asA, ofB], `a copy of B's ${s.table} row for the deleted tenant`, OTHER_INSERT[s.table])
    swept++
  }
  assert.ok(swept >= 70, `${swept} tables swept`)
  for (const [sql, params] of [
    ["INSERT INTO users (id, email, password_hash, salt) VALUES (?, 'again@example.test', 'x', 'y')", [A]],
    ["INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'again', 'personal', ?, 1)", [A, A]],
    ["INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, 'viewer', 1)", [B, A]],
  ] as [string, string[]][]) await refused(c, sql, params, 'identity rows')
  assert.deepEqual(await f.snap(B), bBefore, 'B byte-identical')
  assert.equal(await rows(c, 'SELECT count(*) AS n FROM tenant_memory WHERE tenant_id = ?', [A]), 0)
})

// Review (PR #455, R1-2): memberships.member_id names an account without being the row's tenant column, so during a
// deletion held at 'requested' the account could join another workspace and be deleted anyway, leaving a membership
// naming a deleted account (decision 9 forbids it). Now the guard refuses it, and the erase step re-checks.
bothEngines('decision 9 during a held deletion: the account cannot join another workspace or be moved into one; the erase step re-checks it', async c => {
  await fixture(c)
  const C = 'guard-team-cccc'
  await c.db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, 'team c', 'team', 'someone', 1)", [C])
  assert.equal((await deleteTenant(c.db, A, { policy: { suppressions: 'erase' }, requestedBy: BY, now: NOW, until: 'requested' })).state, 'requested')
  await refused(c, "INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, 'viewer', 2)", [C, A], 'the account under deletion accepting an invitation')
  await refused(c, 'UPDATE memberships SET member_id = ? WHERE tenant_id = ? AND member_id = ?', [A, B, B], "B's membership moved onto the account under deletion")
  assert.equal(await rows(c, 'SELECT count(*) AS n FROM memberships WHERE member_id = ? AND tenant_id <> ?', [A, A]), 0)
  assert.equal(await rows(c, 'SELECT count(*) AS n FROM memberships WHERE member_id = ? AND tenant_id = ?', [B, B]), 1, "B's membership unchanged")
  // defence in depth: on a store without the member_id guard, the first step finds the membership and stops before
  // anything is revoked
  await c.db.run(c.kind === 'pg' ? 'DROP TRIGGER tomb_memberships_member_id ON memberships' : 'DROP TRIGGER tomb_memberships_member_id')
  await c.db.run("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, 'viewer', 2)", [C, A])
  await assert.rejects(deleteTenant(c.db, A), /founder belongs to another workspace/)
  assert.equal((await tombstone(c.db, A))?.state, 'requested', 'nothing revoked, nothing erased')
  assert.equal(await rows(c, 'SELECT count(*) AS n FROM sessions WHERE user_id = ?', [A]), 1, 'credentials untouched')
  assert.equal(await rows(c, 'SELECT count(*) AS n FROM users WHERE id = ?', [A]), 1, 'the account still exists')
  assert.equal(await rows(c, 'SELECT count(*) AS n FROM tenant_memory WHERE tenant_id = ?', [A]), 1, 'its data too')
  // and if it arrives after the first step, the erase step finds it
  await c.db.run('DELETE FROM memberships WHERE tenant_id = ? AND member_id = ?', [C, A])
  assert.equal((await deleteTenant(c.db, A, { until: 'cancelled' })).state, 'cancelled')
  await c.db.run("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, 'viewer', 3)", [C, A])
  await assert.rejects(deleteTenant(c.db, A), /founder belongs to another workspace/)
  assert.equal((await tombstone(c.db, A))?.state, 'cancelled', 'stuck before the erase, for the operator')
  assert.equal(await rows(c, 'SELECT count(*) AS n FROM tenant_memory WHERE tenant_id = ?', [A]), 1, 'nothing erased')
  // the operator resolves it (the membership goes), the deletion resumes and completes with no membership naming A
  await c.db.run('DELETE FROM memberships WHERE tenant_id = ? AND member_id = ?', [C, A])
  assert.equal((await deleteTenant(c.db, A)).state, 'completed')
  assert.equal(await rows(c, 'SELECT count(*) AS n FROM memberships WHERE member_id = ?', [A]), 0)
})

// Review (PR #455, R7): a SET that keeps the same value is not a move; it is allowed even on the deleted tenant's
// retained rows, and the guard's chain lookups run only when the key changes.
bothEngines('allowed: a same-value SET of the guarded column on the deleted tenant\'s retained row', async c => {
  const f = await fixture(c)
  await deleteTenant(c.db, A, { policy: { suppressions: 'retain', retainTables: ['scan_jobs', 'leads'] }, requestedBy: BY, now: NOW })
  assert.deepEqual(await c.db.run('UPDATE suppressions SET tenant_id = ? WHERE tenant_id = ?', [A, A]), { changes: 1 }, 'a retained row, same owner')
  assert.deepEqual(await c.db.run('UPDATE leads SET scan_job_id = ? WHERE scan_job_id = ?', [f.ids[A].scan_jobs, f.ids[A].scan_jobs]), { changes: 1 }, 'a retained child, same parent')
  await refused(c, 'UPDATE suppressions SET tenant_id = ? WHERE tenant_id = ?', [B, A], 'but moving it out is still refused')
  await refused(c, 'UPDATE leads SET scan_job_id = ? WHERE scan_job_id = ?', [f.ids[B].scan_jobs, f.ids[A].scan_jobs], 'and so is moving the child out')
})

bothEngines('guard count: every guarded table has an INSERT and an UPDATE guard, users and organizations too', async c => {
  const scope = await guarded(c)
  const want = guardTriggers(scope).map(g => g.name).sort()
  const accountCols = Object.entries(ACCOUNT_COLUMNS).filter(([t]) => scope.some(s => s.table === t)).reduce((n, [, cs]) => n + cs.length, 0)
  assert.equal(want.length, 2 * (scope.length + 2 + accountCols), `${scope.length} guarded tables, users and organizations, ${accountCols} account column(s): two guards each`)
  assert.equal(want.length, 166)
  const live = c.kind === 'sqlite'
    ? (await c.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'tomb_%'")).map(r => r.name)
    : (await c.db.all<{ name: string }>("SELECT DISTINCT trigger_name AS name FROM information_schema.triggers WHERE trigger_schema = current_schema() AND trigger_name LIKE 'tomb_%'")).map(r => r.name)
  assert.deepEqual(live.sort(), want)
  for (const g of guardTriggers(scope)) assert.match(g.sql, g.name.startsWith('tomb_upd_') ? /BEFORE UPDATE OF \w+ ON/ : /BEFORE INSERT ON/, g.name)
})
