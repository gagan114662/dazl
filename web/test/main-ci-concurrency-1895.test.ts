import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const { load } = createRequire(import.meta.url)('js-yaml') as { load: (yaml: string) => unknown }

function concurrency(workflow: string) {
  const path = new URL(`../../.github/workflows/${workflow}.yml`, import.meta.url)
  const config = load(readFileSync(path, 'utf8')) as { concurrency: Record<string, unknown> }
  return config.concurrency
}

for (const workflow of ['web-ci', 'release-gate']) {
  test(`#1895 ${workflow} keeps active main push runs and still cancels stale pull request runs`, () => {
    const config = concurrency(workflow)
    assert.ok(String(config.group).includes(`github.event_name == 'push' && '${workflow}-main'`),
      'main pushes share a group so GitHub keeps only the newest pending run')
    assert.equal(config['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}")
  })
}

test('#1895 static-quality groups main pushes by commit SHA', () => {
  assert.equal(concurrency('static-quality').group,
    'static-quality-${{ github.event.pull_request.number || github.sha }}')
})
