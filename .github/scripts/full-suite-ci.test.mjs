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
test('full shards keep the full test list, ceiling and partition', () => {
  for (const name of ['sqlite-shard', 'postgres-shard']) {
    const body = job(name)
    assert.match(body, /timeout-minutes: 45/)
    assert.match(body, /SEL: ALL/)
    assert.ok(body.includes('all=$(ls test/*.test.ts test/crm-webhook-unknown-ui.test.mjs)'))
    assert.match(body, /shard: \[1, 2, 3, 4\]/)
    assert.ok(body.includes("'NF && (NR-1)%n==i-1'"))
  }
  assert.match(job('fast-pr'), /timeout-minutes: 20/)
})

test('adding or removing the label re-runs CI', () => {
  assert.match(wf, /^  pull_request:\n    types: \[opened, synchronize, reopened, labeled, unlabeled\]/m)
})

test('nothing else is loosened: migrations, pr-budget cancel detection, no manual success status on PRs', () => {
  const pg = job('postgres-shard')
  assert.match(pg, /npm run db:migrate \| grep -q 'applied \\\[\\\]'/, 'migrate-twice check kept')
  assert.match(pg, /test\/leads-read-pg-live\.test\.ts/, 'live leads-read contract kept')
  const b = job('pr-budget')
  assert.match(b, /if \[ "\$FAST" = cancelled \] \|\| \[ "\$R1" = cancelled \] \|\| \[ "\$R2" = cancelled \]; then/)
  assert.match(b, /exit 1/)
  for (const [req, shard] of [['test-sqlite', 'sqlite-shard'], ['test-postgres', 'postgres-shard']]) {
    const j = job(req)
    assert.ok(j.includes(`needs: [fast-pr, ${shard}]`), `${req} waits for fast checks and shards`)
    assert.ok(j.includes('[ "$FULL_CI" = true ] && [ "$SHARDS" = success ]'), `${req} requires shards to pass at the full tier`)
    assert.match(j, /if: always\(\)/, `${req} reports even when a shard fails`)
  }
  assert.match(job('main-green'), /needs: \[test-sqlite, test-postgres\]/)
  assert.match(job('main-green'), /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/)
  assert.equal((wf.match(/state=success/g) || []).length, 1, 'only main-green sets a success status')
})
