// Refs #1463: every pull-request-triggered workflow has a top-level concurrency group keyed per PR, so a new push to a PR
// cancels that PR's older queued run instead of piling onto the shared runner queue. Outside a PR the group falls back to
// a per-run/per-SHA key (or, for the deploy builds, a ref key that is deliberate there), so a push to main never cancels
// the gate of an earlier main commit.
// Run: node --test '.github/scripts/*.test.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('../workflows/', import.meta.url))
const workflows = readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).map(f => ({ f, text: readFileSync(join(dir, f), 'utf8') }))
const onBlock = text => (text.match(/^on:\n((?:[ #].*\n|\n)*)/m)?.[1] ?? '')
const prTriggered = workflows.filter(w => /^ {2}pull_request(_target)?:/m.test(onBlock(w.text)))
const DEPLOY_BUILDS = new Set(['prod-prebuilt.yml', 'staging-prebuilt.yml'])
const concurrency = text => text.match(/^concurrency:\n((?: {2}.*\n)+)/m)?.[1] ?? null

test('every workflow writes its triggers as a block-style on: map, so none is skipped by the PR detection', () => {
  for (const { f, text } of workflows) assert.match(text, /^on:\n/m, `${f} uses a block-style on:`)
})

test('the PR-triggered workflow list is read from the real workflows', () => {
  for (const name of ['web-ci.yml', 'never-again-gates.yml', 'acceptance-gate.yml', 'static-quality.yml', 'production-literals-tests.yml'])
    assert.ok(prTriggered.some(w => w.f === name), `${name} is PR-triggered`)
})

test('every PR-triggered workflow has a top-level concurrency group keyed per PR', () => {
  for (const { f, text } of prTriggered) {
    const c = concurrency(text)
    assert.ok(c, `${f} declares a top-level concurrency block`)
    const group = c.match(/^ {2}group: *(.+)$/m)?.[1] ?? ''
    // the deploy builds group by ref on purpose (only main's newest build matters to the box); they run on a PR only when their own files change
    if (DEPLOY_BUILDS.has(f)) assert.match(group, /github\.ref/, `${f} groups by ref (got ${group})`)
    else assert.match(group, /github\.event\.pull_request\.number/, `${f} groups by PR number (got ${group})`)
  }
})

test('the workflows that had no group now cancel an older run of the same PR, and never a main commit\'s run', () => {
  for (const f of ['never-again-gates.yml', 'production-literals-tests.yml']) {
    const c = concurrency(workflows.find(w => w.f === f).text) ?? ''
    assert.match(c, new RegExp(`group: ${f.replace(/\.yml$/, '')}-\\$\\{\\{ github\\.event\\.pull_request\\.number \\|\\| github\\.run_id \\}\\}`), `${f} group falls back to the run id outside a PR`)
    assert.match(c, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/, `${f} cancels only on pull requests`)
  }
})
