// Refs #1099 (Hermes F1 on #1273): a reviewer-applied `full-suite-ci` label gives web-ci's two PR test jobs the existing
// 45-minute full-suite ceiling AND forces the ALL suite. Unlabeled PRs keep the 5-minute affected-only budget; main is
// unchanged; pr-budget still fails on a cancelled job. Run: node --test '.github/scripts/*.test.mjs' (never-again-gates.yml).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const wf = readFileSync(path.join(repo, '.github/workflows/web-ci.yml'), 'utf8')
const job = name => {
  const m = wf.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:\\n|(?![\\s\\S]))`, 'm'))
  assert.ok(m, `job ${name} missing`)
  return m[1]
}
const TIMEOUT = "timeout-minutes: ${{ github.event_name == 'pull_request' && !contains(github.event.pull_request.labels.*.name, 'full-suite-ci') && 5 || 45 }}"
const FULL_ENV = "FULL_SUITE: ${{ contains(github.event.pull_request.labels.*.name, 'full-suite-ci') }}"
const SELECT = 'if [ "$FULL_SUITE" = true ]; then sel=ALL; else sel=$(node .github/scripts/affected-tests.mjs'

// mirror of the TIMEOUT expression, so the on/off cases are spelled out
const timeoutFor = (event, labels) => (event === 'pull_request' && !labels.includes('full-suite-ci') ? 5 : 45)

test('label on/off: both PR test jobs use the 45-min ceiling only with full-suite-ci', () => {
  for (const name of ['test-sqlite', 'test-postgres']) {
    const lines = job(name).split('\n').map(l => l.trim())
    assert.ok(lines.includes(TIMEOUT), `${name}: timeout must honour the full-suite-ci label`)
  }
  assert.equal(timeoutFor('pull_request', []), 5, 'unlabeled PR keeps 5 minutes')
  assert.equal(timeoutFor('pull_request', ['launch']), 5, 'other labels keep 5 minutes')
  assert.equal(timeoutFor('pull_request', ['full-suite-ci']), 45, 'labeled PR gets 45')
  assert.equal(timeoutFor('push', []), 45, 'main unchanged')
})

test('full-suite selection: the label forces ALL, otherwise affected-tests decides', () => {
  for (const name of ['test-sqlite', 'test-postgres']) {
    const j = job(name)
    const lines = j.split('\n').map(l => l.trim())
    assert.ok(lines.includes(FULL_ENV), `${name}: selection step reads the label`)
    assert.ok(j.includes(SELECT), `${name}: label => sel=ALL`)
    assert.match(j, /\[ "\$SEL" = ALL \]; then npm test/, `${name}: ALL still runs the whole npm test suite`)
  }
})

test('adding or removing the label re-runs CI', () => {
  assert.match(wf, /^  pull_request:\n    types: \[opened, synchronize, reopened, labeled, unlabeled\]/m)
})

test('nothing else is loosened: migrations, pr-budget cancel detection, no manual success status on PRs', () => {
  const pg = job('test-postgres')
  assert.match(pg, /npm run db:migrate \| grep -q 'applied \\\[\\\]'/, 'migrate-twice check kept')
  assert.match(pg, /test\/leads-read-pg-live\.test\.ts/, 'live leads-read contract kept')
  const b = job('pr-budget')
  assert.match(b, /if \[ "\$R1" = cancelled \] \|\| \[ "\$R2" = cancelled \]; then/)
  assert.match(b, /exit 1/)
  assert.match(job('main-green'), /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/)
  assert.equal((wf.match(/state=success/g) || []).length, 1, 'only main-green sets a success status')
})
