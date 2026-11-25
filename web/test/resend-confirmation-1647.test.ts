// #1647: a user blocked by "Confirm your email first" can press "Resend confirmation email". The component lives in
// app/resend-confirmation.tsx and the unauthenticated resend in app/api/auth/email/send-verification/route.ts; node
// --test cannot strip .tsx and the route needs the real session lookup, so the tests run in a child process with the
// repo's tsx loader and the workspace session loader (the #1571 and #357 runtimes). The rules are written at the top
// of test/helpers/resend-confirmation-1647-runtime.mts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

test('#1647 resend confirmation: same answer for every address, capped, signed-in path unchanged (real routes, no network)', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/workspace-session-loader.mjs', '--loader', './test/helpers/auth-after-loader.mjs', '--loader', './test/helpers/tsx-loader.mjs', '--test-reporter=tap', '--test', './test/helpers/resend-confirmation-1647-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 180000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('#1647 the verify page renders the resend block in the no-link and failed states', () => {
  const page = readFileSync(fileURLToPath(new URL('../app/verify/page.tsx', import.meta.url)), 'utf8')
  for (const state of ['none', 'unusable', 'uncertain', 'limited'])
    assert.match(page, new RegExp(`state === '${state}'[\\s\\S]{0,600}<ResendConfirmation`), `${state} offers resend`)
})
