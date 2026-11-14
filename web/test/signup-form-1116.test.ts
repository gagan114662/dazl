// #1116: the sign-up form's native post (no hydration) through the real route (test/helpers/signup-form-1116-runtime.mts).
// The runtime loads routes through a resolver hook, so it runs in its own process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

test('#1116 a native sign-up form post creates the account and redirects with a code; cross-site forms are refused (real route)', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/workspace-session-loader.mjs', '--test', './test/helpers/signup-form-1116-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /SIGNUP FORM 1116 ok/)
})

test('#1116 the sign-up form posts to the sign-up route, not to its own page', () => {
  const src = readFileSync(fileURLToPath(new URL('../app/sign-up/sign-up-form.tsx', import.meta.url)), 'utf8')
  assert.match(src, /<form method="post" action="\/api\/auth\/signup" onSubmit=\{handleSubmit\}/, 'a native submit reaches the route that creates the account')
})
