import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolveServedCommit } from '../lib/commit-marker.ts'

const SHA = '0123456789abcdef0123456789abcdef01234567'

test('build stamp beats env: an old build cannot report a newer commit', () => {
  const d = mkdtempSync('/tmp/cm-')
  writeFileSync(`${d}/.build-commit`, SHA + '\n')
  assert.equal(resolveServedCommit({ DAZL_COMMIT_SHA: 'f'.repeat(40) }, d), SHA)
  rmSync(d, { recursive: true, force: true })
})

test('env var is the last resort before unknown', () => {
  assert.equal(resolveServedCommit({ DAZL_COMMIT_SHA: SHA }, '/nonexistent'), SHA)
})

test('reads .git/HEAD symref + loose ref file', () => {
  const d = mkdtempSync('/tmp/cm-')
  mkdirSync(`${d}/.git/refs/heads`, { recursive: true })
  writeFileSync(`${d}/.git/HEAD`, 'ref: refs/heads/main\n')
  writeFileSync(`${d}/.git/refs/heads/main`, SHA + '\n')
  assert.equal(resolveServedCommit({}, d), SHA)
  rmSync(d, { recursive: true, force: true })
})

test('falls back to packed-refs when loose ref missing', () => {
  const d = mkdtempSync('/tmp/cm-')
  mkdirSync(`${d}/.git/refs/heads`, { recursive: true })
  writeFileSync(`${d}/.git/HEAD`, 'ref: refs/heads/main\n')
  writeFileSync(`${d}/.git/packed-refs`, `# pack-refs\n${SHA} refs/heads/main\n`)
  assert.equal(resolveServedCommit({}, d), SHA)
  rmSync(d, { recursive: true, force: true })
})

test('detached HEAD returns the sha directly', () => {
  const d = mkdtempSync('/tmp/cm-')
  mkdirSync(`${d}/.git`, { recursive: true })
  writeFileSync(`${d}/.git/HEAD`, SHA + '\n')
  assert.equal(resolveServedCommit({}, d), SHA)
  rmSync(d, { recursive: true, force: true })
})

test('unknown when nothing resolves - never a guess', () => {
  assert.equal(resolveServedCommit({}, '/nonexistent'), 'unknown')
})
