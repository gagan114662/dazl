import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { requireScorecardWorkspace } from '../lib/company-first/scorecard-workspace.ts'

const active = 'a'.repeat(64)
const rotated = 'b'.repeat(64)
const scope = { tenantId: 'scorecard-test-team', actorId: 'scorecard-test-owner', workspaceRevision: active }

bothEngines('protected scorecard workspace is default-off and bound to a live current owner and revision', async ({ db }) => {
  for (const id of [scope.actorId, 'scorecard-test-second', 'scorecard-test-missing-role']) {
    await db.run('INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, ?, ?)', [id, id + '@example.invalid', 'fixture', 'fixture'])
  }
  for (const id of [scope.tenantId, 'scorecard-test-other']) {
    await db.run("INSERT INTO organizations (id, kind, created_by, created_at) VALUES (?, 'team', ?, 1)", [id, scope.actorId])
    await db.run("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, 'owner', 1)", [id, scope.actorId])
  }
  await db.run("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, 'operator', 1)", [scope.tenantId, 'scorecard-test-second'])
  const allowed = (overrides: Partial<typeof scope> = {}) => db.tx(t => requireScorecardWorkspace(t, { ...scope, ...overrides }))
  const revise = (on: number, revision: string | null) => db.run('UPDATE organizations SET company_first_scorecard_enabled = ?, company_first_scorecard_revision = ? WHERE id = ?', [on, revision, scope.tenantId])

  assert.equal(await allowed(), false, 'missing revision and flag default off')
  await revise(0, active)
  assert.equal(await allowed(), false, 'revision alone is never consent')
  await revise(1, null)
  assert.equal(await allowed(), false, 'enabled without a valid revision cannot admit')
  await revise(1, active)
  assert.equal(await allowed(), true)
  assert.equal(await allowed({ tenantId: 'scorecard-test-other' }), false, 'even its owner cannot run in another disabled workspace')
  assert.equal(await allowed({ tenantId: 'scorecard-test-unknown' }), false)
  assert.equal(await allowed({ actorId: 'scorecard-test-second' }), false, 'operate is not protected scorecard authority')
  assert.equal(await allowed({ actorId: 'scorecard-test-missing-role' }), false)
  assert.equal(await allowed({ workspaceRevision: active.toUpperCase() }), false)
  await revise(1, rotated)
  assert.equal(await allowed(), false, 'old tickets cannot cross a revision bump')
  assert.equal(await allowed({ workspaceRevision: rotated }), true)
  await db.run("UPDATE memberships SET role = 'admin' WHERE tenant_id = ? AND member_id = ?", [scope.tenantId, scope.actorId])
  assert.equal(await allowed({ workspaceRevision: rotated }), false, 'current role, not role at ticket issuance')
  await db.run("UPDATE memberships SET role = 'owner' WHERE tenant_id = ? AND member_id = ?", [scope.tenantId, scope.actorId])
  await db.run("INSERT INTO tenant_tombstones (deleted_tenant, requested_at, requested_by, state, policy) VALUES (?, 1, ?, 'requested', '{}')", [scope.actorId, scope.actorId])
  assert.equal(await allowed({ workspaceRevision: rotated }), false, 'account tombstoned even when workspace is not')
  await db.run('DELETE FROM tenant_tombstones WHERE deleted_tenant = ?', [scope.actorId])
  await db.run("INSERT INTO tenant_tombstones (deleted_tenant, requested_at, requested_by, state, policy) VALUES (?, 1, ?, 'requested', '{}')", [scope.tenantId, scope.actorId])
  assert.equal(await allowed({ workspaceRevision: rotated }), false, 'workspace tombstone independently refuses')
})
