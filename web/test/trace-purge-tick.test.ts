import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pgSkip } from './helpers/pg-test.ts'

// The real tick route and captured-trace retention (PR #463 review): zero deletions unless capture is on or a retention
// was set explicitly; at most 500 rows per tick under the lease fence (test/helpers/trace-purge-tick-runtime.mts), with
// the trace store on SQLite and on Postgres.
const run = (engine: 'sqlite' | 'pg') => {
  const env: NodeJS.ProcessEnv = { ...process.env, TRACE_PURGE_TICK_ENGINE: engine }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs', '--test', './test/helpers/trace-purge-tick-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, new RegExp(`^(?:# )?engine ${engine}$`, "m"))   // the tap reporter prefixes console output with "# "
  // the tap reporter (CI, piped) prints "# pass 3"; the spec reporter (a newer node on a terminal) prints "ℹ pass 3"
  assert.match(r.stdout, /^(?:# |ℹ )pass 3$/m)
  assert.match(r.stdout, /^(?:# |ℹ )fail 0$/m)
}
test('[sqlite] tick route: trace purge deletes nothing with capture unset/off/invalid; purges past the retention when on or explicitly set; bounded per tick', () => run('sqlite'))
test('[pg] tick route: trace purge deletes nothing with capture unset/off/invalid; purges past the retention when on or explicitly set; bounded per tick', { skip: pgSkip }, () => run('pg'))
