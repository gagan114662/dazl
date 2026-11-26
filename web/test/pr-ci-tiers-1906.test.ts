import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

type Step = { 'working-directory'?: string; if?: string; run?: string }
type Job = { if?: string; env?: Record<string, string>; needs?: string[]; steps: Step[] }
type Workflow = { on: { pull_request: { types: string[]; paths?: string[] } }; env?: Record<string, string>; jobs: Record<string, Job> }
const { load } = createRequire(import.meta.url)('js-yaml') as { load: (yaml: string) => unknown }
const read = (name: string) => load(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8')) as Workflow
const full = "${{ github.event_name == 'push' || github.event_name == 'merge_group' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') || contains(github.event.pull_request.labels.*.name, 'ready-to-merge') || contains(github.event.pull_request.labels.*.name, 'quest-approved') }}"

for (const name of ['web-ci', 'release-gate', 'release-preflight']) {
  test(`#1906 ${name} starts on label changes and on workflow-only PRs`, () => {
    const workflow = read(name)
    if (name === 'web-ci') assert.deepEqual(workflow.on.pull_request.paths, ['load/**', '**'])
    else assert.equal(workflow.on.pull_request.paths, undefined)
    assert.ok(workflow.on.pull_request.types.includes('labeled'))
    assert.ok(workflow.on.pull_request.types.includes('unlabeled'))
  })
}

test('#1906 required database checks block an unlabeled PR and require passing shards on a labeled PR', () => {
  const { jobs } = read('web-ci')
  for (const shard of ['sqlite-shard', 'postgres-shard']) assert.equal(jobs[shard].if, full)
  assert.equal(jobs['fast-pr'].if, "github.event_name == 'pull_request'")
  const steps = jobs['fast-pr'].steps.map(step => step.run).join('\n')
  assert.match(steps, /eslint/)
  assert.match(steps, /npm run check:unused/)
  assert.match(steps, /affected-tests\.mjs/)
  for (const name of ['test-sqlite', 'test-postgres']) {
    const job = jobs[name]
    assert.ok(job.needs?.includes('fast-pr'))
    assert.equal(job.env?.FULL_CI, full)
    const script = job.steps[0].run!
    for (const [tier, fast, shards, expected] of [
      ['false', 'success', 'skipped', 1], ['false', 'failure', 'skipped', 1],
      ['true', 'success', 'success', 0], ['true', 'skipped', 'success', 0],
      ['true', 'success', 'skipped', 1], ['true', 'success', 'failure', 1],
    ] as const) {
      const run = spawnSync('bash', ['-e', '-c', script], {
        encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '/dev/null', FULL_CI: tier, FAST: fast, SHARDS: shards, EVENT: fast === 'skipped' ? 'push' : 'pull_request' },
      })
      assert.equal(run.status, expected, run.stdout + run.stderr)
      if (tier === 'false' && fast === 'success') assert.match(run.stdout, /add ready-to-merge or quest-approved/i)
    }
  }
})

for (const [name, jobs] of [['release-gate', ['browser', 'migrations', 'package', 'package-staging']], ['release-preflight', ['fail-closed']]] as const) {
  test(`#1906 ${name} keeps required check names and reports deferral without heavy steps`, () => {
    const workflow = read(name)
    assert.equal(workflow.env?.FULL_CI, full)
    for (const id of jobs) {
      const [deferred, ...heavy] = workflow.jobs[id].steps
      assert.equal(deferred.if, "env.FULL_CI != 'true'")
      assert.match(deferred.run ?? '', /full suite deferred until ready-to-merge/)
      assert.ok(heavy.length > 0 && heavy.every(step => step.if?.includes("env.FULL_CI == 'true'")))
    }
  })
}

test('#1906 an unlabeled PR cannot pass the full-suite check even when every other required check passes', () => {
  const gate = read('web-ci').jobs['full-suite']
  assert.ok(gate, 'branch protection needs a full-suite check')
  assert.equal(gate.if, 'always()')
  assert.equal(gate.env?.FULL_CI, full)
  assert.deepEqual(gate.needs, ['test-sqlite', 'test-postgres'])
  const script = gate.steps[0].run!
  for (const [tier, sqlite, postgres, expected] of [
    ['false', 'success', 'success', 1],
    ['true', 'success', 'success', 0],
    ['true', 'failure', 'success', 1],
    ['true', 'success', 'skipped', 1],
  ] as const) {
    const run = spawnSync('bash', ['-e', '-c', script], {
      encoding: 'utf8',
      env: { ...process.env, FULL_CI: tier, SQLITE: sqlite, POSTGRES: postgres },
    })
    assert.equal(run.status, expected, run.stdout + run.stderr)
    if (tier === 'false') assert.match(run.stdout, /add ready-to-merge or quest-approved/i)
  }
})

for (const name of ['web-ci', 'release-gate', 'release-preflight']) {
  test(`#1906 ${name} can report full-suite deferral without a checkout`, () => {
    const deferred = Object.entries(read(name).jobs).flatMap(([id, job]) =>
      job.steps.filter(step => step.run?.includes('full suite deferred until ready-to-merge'))
        .map(step => ({ id, step })))
    assert.ok(deferred.length, 'the workflow reports full-suite deferral')
    for (const { id, step } of deferred) {
      assert.equal(step['working-directory'], '.', `${id} must run from the runner workspace root`)
    }
  })
}
