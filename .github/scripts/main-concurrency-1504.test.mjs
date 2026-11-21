// Refs #1504: on push to main, web-ci, release-gate and release-preflight share one concurrency group per workflow and a
// newer main push cancels the older run; and every web-ci PR run type-checks the whole of web/ in shard 1 (npm run
// check:unused = tsc --noEmit over all of web/ plus unused symbols), not only the changed files.
// Run: node --test '.github/scripts/*.test.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const wf = name => readFileSync(fileURLToPath(new URL(`../workflows/${name}.yml`, import.meta.url)), 'utf8')
const concurrency = text => {
  const m = text.match(/^concurrency:\n {2}group: *(.+)\n {2}cancel-in-progress: *(.+)$/m)
  assert.ok(m, 'top-level concurrency block with group and cancel-in-progress')
  return { group: m[1].trim(), cancel: m[2].trim() }
}
// Evaluate the small GitHub expression subset these blocks use, for a given event context.
const evalExpr = (expr, ctx) => {
  const inner = expr.match(/^\$\{\{\s*([\s\S]+?)\s*\}\}$/)
  if (!inner) return expr
  const js = inner[1]
    .replace(/github\.event\.pull_request\.number/g, 'ctx.pr')
    .replace(/github\.event_name/g, 'ctx.event').replace(/github\.run_id/g, 'ctx.runId').replace(/github\.sha/g, 'ctx.sha')
    .replace(/github\.ref/g, 'ctx.ref')
    .replace(/format\('([^']*)',\s*([^)]+)\)/g, (_m, f, a) => `(${JSON.stringify(f)}).replace('{0}', String(${a}))`)
  return String(Function('ctx', `return (${js})`)(ctx))
}
const groupFor = (text, ctx) => {
  const { group } = concurrency(text)
  return group.replace(/\$\{\{[\s\S]+?\}\}/g, e => evalExpr(e, ctx))
}
const push = { event: 'push', pr: undefined, runId: 111, sha: 'aaa', ref: 'refs/heads/main' }
const push2 = { ...push, runId: 222, sha: 'bbb' }
const pr = { event: 'pull_request', pr: 1504, runId: 333, sha: 'ccc', ref: 'refs/pull/1504/merge' }
const dispatch = { event: 'workflow_dispatch', pr: undefined, runId: 444, sha: 'ddd', ref: 'refs/heads/main' }

for (const [name, mainGroup] of [['web-ci', 'web-ci-main'], ['release-gate', 'release-gate-main'], ['release-preflight', 'release-preflight-main']]) {
  test(`${name}: every push to main shares the ${mainGroup} group and cancels the older run`, () => {
    const text = wf(name)
    assert.equal(groupFor(text, push), mainGroup)
    assert.equal(groupFor(text, push2), mainGroup, 'a second main push lands in the same group')
    assert.equal(evalExpr(concurrency(text).cancel, push), 'true', 'cancel-in-progress is true on push')
  })
  test(`${name}: pull requests keep their own per-PR group and still cancel; a manual run is never cancelled`, () => {
    const text = wf(name)
    assert.equal(groupFor(text, pr), `${name}-1504`)
    assert.equal(evalExpr(concurrency(text).cancel, pr), 'true')
    if (/workflow_dispatch:/.test(text)) {
      assert.notEqual(groupFor(text, dispatch), mainGroup, 'a workflow_dispatch run is not in the main push group')
      assert.equal(evalExpr(concurrency(text).cancel, dispatch), 'false')
    }
  })
}

test('web-ci shard 1 runs the full-repo type check (npm run check:unused) on pull requests too, not only changed-file lint', () => {
  const text = wf('web-ci')
  const step = text.match(/- name: ([^\n]*)\n {8}if: matrix\.shard == 1\n(?: {8}.*\n)*? {8}run: \|\n((?: {10}.*\n)+)/)
  assert.ok(step, 'a shard-1 lint/typecheck step exists in sqlite-shard')
  const body = step[2]
  const prBranch = body.match(/if \[ "\$\{\{ github\.event_name \}\}" = pull_request \]; then\n([\s\S]*?)(?:\n {10}else|\n {10}fi)/)
  const runsUnconditionally = /^ {10}npm run check:unused\s*$/m.test(body)
  assert.ok(runsUnconditionally || (prBranch && /npm run check:unused/.test(prBranch[1])),
    'npm run check:unused runs for pull_request events in shard 1')
  assert.match(body, /npx eslint/, 'changed-file eslint still runs on pull requests')
})
