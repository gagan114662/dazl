import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const workflow = readFileSync(new URL('../../.github/workflows/production-literals-tests.yml', import.meta.url), 'utf8')
const resolver = /<<'NODE' > "\$tmp\/ref"\n([\s\S]*?)\n\s+NODE\n/.exec(workflow)?.[1]
assert.ok(resolver, 'the workflow must resolve the ref from the event')

const sha = 'a'.repeat(40)
const push = { repository: { id: 1288615110 }, ref: 'refs/heads/main', after: sha }

function resolveRef(eventType: string, event: object) {
  const directory = mkdtempSync(join(tmpdir(), 'literal-ref-'))
  try {
    const file = join(directory, 'event.json')
    writeFileSync(file, JSON.stringify(event))
    return spawnSync(process.execPath, ['-', eventType, file, sha], { input: resolver, encoding: 'utf8' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('a main push selects its recorded commit even if the branch moves', () => {
  const result = resolveRef('push', push)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), sha)
  assert.match(workflow, /\[\[ "\$actual" == "\$GITHUB_SHA" \]\]/)
})

test('a mismatched push SHA is rejected', () => {
  assert.equal(resolveRef('push', { ...push, after: 'b'.repeat(40) }).status, 2)
})

test('a pull request still selects its merge ref', () => {
  const result = resolveRef('pull_request', {
    repository: push.repository,
    number: 42,
    pull_request: { number: 42, base: { ref: 'main', repo: push.repository } },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'refs/pull/42/merge')
})
