// #1471: /app/plays said "No saved plays yet" while Home listed a play that ran once. Both pages now read one list
// (GET /api/plays, lib/workspace-plays.ts). This runs the real route handlers on SQLite and Postgres
// (test/helpers/plays-one-source-1471-runtime.mts, under the route loader) and checks both pages list the same plays.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PG_URL } from './helpers/pg-test.ts'

test('#1471 Home and Plays list the same plays through the real routes', () => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/tenant-route-loader.mjs', '--test-reporter=tap', '--test', './test/helpers/plays-one-source-1471-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  // SQLite always runs; Postgres runs whenever DAZL_TEST_PG_URL is set (the CI postgres job), never silently skipped there
  assert.match(r.stdout, PG_URL ? /# pass 3\b/ : /# pass 2\b/)
  assert.match(r.stdout, /# fail 0\b/)
})
