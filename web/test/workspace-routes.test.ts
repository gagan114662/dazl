// Workspaces through the real route handlers and the real session lookup (test/helpers/workspace-routes-runtime.mts).
// The runtime loads routes through a resolver hook, so it runs in its own process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ROUTES } from './tenant-isolation-manifest.ts'

const web = fileURLToPath(new URL('../', import.meta.url))

test('a member acts in the workspace they chose, within their role, until removed (real sessions, real routes)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/workspace-session-loader.mjs', '--test', './test/helpers/workspace-routes-runtime.mts'], { cwd: web, env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /WORKSPACE ROUTES ok/)
})

test('invite, join and switch through the routes; nothing of workspace A is reachable from workspace B', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/workspace-session-loader.mjs', '--test', './test/helpers/workspace-members-runtime.mts'], { cwd: web, env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /WORKSPACE MEMBERS ok/)
})

test("an account lists and revokes only its own sessions; revoked sessions fail at once (real sessions, real routes)", () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/workspace-session-loader.mjs', '--test', './test/helpers/session-routes-runtime.mts'], { cwd: web, env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /SESSION ROUTES ok[\s\S]*REAUTH ok/)
})


test('no read returns a secret, a ciphertext or a capability URL to any role; the Cal.com signing secret only to admins and owners (real sessions)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/workspace-session-loader.mjs', '--test', './test/helpers/role-reads-runtime.mts'], { cwd: web, env, encoding: 'utf8', timeout: 180000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  // every session GET route, as each of the four roles
  const gets = ROUTES.filter(x => x.auth === 'session' && x.method === 'GET').length
  assert.match(r.stdout, new RegExp(`ROLE READS ${gets * 4}\\b`))
})

test('forgot password reveals nothing; reset works once and signs out everywhere; verification works once (real routes)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/workspace-session-loader.mjs', '--test', './test/helpers/email-routes-runtime.mts'], { cwd: web, env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /EMAIL ROUTES ok/)
})

