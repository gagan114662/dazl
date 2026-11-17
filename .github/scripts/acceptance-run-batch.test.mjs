// Refusal control (Hermes-PC fix A3): healthy pages + a broken feature must FAIL, and only passing issues get a PASS line.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RUN = new URL('../../ops/acceptance/run-batch.mjs', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'acc-'))
const ok = join(dir, 'pages-ok.sh'); writeFileSync(ok, 'echo "pages 200"; exit 0\n')
const broken = join(dir, 'feature-broken.sh'); writeFileSync(broken, 'echo "pages 200 but feature returned no leads"; exit 1\n')
const run = (list) => { const m = join(dir, `m${Math.random()}.json`); writeFileSync(m, JSON.stringify(list)); return spawnSync(process.execPath, [RUN, m, 'https://x.test', 'abc'], { encoding: 'utf8' }) }

test('healthy pages plus a broken feature FAILS the batch, and the broken issue gets no PASS line', () => {
  const r = run([{ issue: 1, check: ok }, { issue: 2, check: broken }])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /PASS #1\b/)
  assert.doesNotMatch(r.stdout, /PASS #2\b/)
  assert.match(r.stdout, /FAIL #2/)
})
test('all checks passing exits 0 with a PASS line per issue', () => {
  const r = run([{ issue: 1, check: ok }, { issue: 3, check: ok }])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /PASS #1\b/); assert.match(r.stdout, /PASS #3\b/)
})
test('empty manifest FAILS (nothing proven)', () => { assert.equal(run([]).status, 1) })
test('missing check script FAILS that issue', () => {
  const r = run([{ issue: 4, check: join(dir, 'nope.sh') }]); assert.equal(r.status, 1); assert.doesNotMatch(r.stdout, /PASS #4/)
})
