import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('carried context admission: real routes, isolated SQLite, fenced providers', () => {
  const env={...process.env}; delete env.NODE_TEST_CONTEXT
  const r=spawnSync(process.execPath,['--experimental-strip-types','--no-warnings','--import','./test/helpers/net-fence.ts','--loader','./test/helpers/scan-route-loader.mjs','--test','--test-reporter=tap','./test/helpers/carried-context-349-runtime.mts'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env,encoding:'utf8',timeout:60000})
  assert.equal(r.error,undefined)
  assert.equal(r.status,0,r.stdout+r.stderr)
  assert.match(r.stdout,/# fail 0/)
})
