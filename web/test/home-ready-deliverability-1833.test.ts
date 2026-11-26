// #1833: a ready row with rejected/no_mx deliverability shows 'This address can't receive email'. The data half runs in
// a child process (the real homeReady with its own store), like the #1040 harness; the row half is a source check on
// the checked list's details render.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('#1833 ready row deliverability (child process)', async () => {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/scan-route-loader.mjs', '--test-reporter=tap', '--test', './test/helpers/home-ready-deliverability-1833-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 1/); assert.match(r.stdout, /# fail 0/)
})

test('#1833 the checked row shows the undeliverable line instead of the address', () => {
  const src = readFileSync(new URL('../app/app/leads/checked/checked-client.tsx', import.meta.url), 'utf8')
  assert.match(src, /email_undeliverable/, 'the row keys on the undeliverable flag')
  assert.ok(src.includes("This address can't receive email"), 'the row shows the exact line')
})
