import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// Refs #900: next-auth, @ai-sdk/anthropic and ai were direct deps with no consumers.
// Auth runs on auth-db.ts and model calls don't use these SDKs. Guard against silent re-adds.
const REMOVED = ['next-auth', '@ai-sdk/anthropic', 'ai']
const KEPT = ['nodemailer', 'pg-mem'] // real dynamic consumers (lib/system-mail.ts, test/leads-read-db.test.ts)

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
type DepMap = Record<string, string> | undefined
const all = (p: { dependencies?: DepMap, devDependencies?: DepMap, optionalDependencies?: DepMap, peerDependencies?: DepMap }) => ({ ...p.dependencies, ...p.devDependencies, ...p.optionalDependencies, ...p.peerDependencies })

test('removed packages are not direct deps in package.json or the lock root', () => {
  for (const name of REMOVED) {
    assert.equal(name in all(pkg), false, `${name} in package.json`)
    assert.equal(name in all(lock.packages['']), false, `${name} in lock root`)
    assert.equal(`node_modules/${name}` in lock.packages, false, `${name} still locked`)
  }
})

test('packages with real consumers are still declared', () => {
  for (const name of KEPT) assert.ok(name in all(pkg), `${name} missing`)
})

test('no source imports the removed packages', () => {
  const re = String.raw`(from|import\(|require\()\s*['"](next-auth|@ai-sdk/anthropic|ai)(/[^'"]*)?['"]`
  let out = ''
  try {
    out = execFileSync('git', ['grep', '-nE', re, '--', '.', ':!package-lock.json', ':!test/unused-direct-deps.test.ts'],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8' })
  } catch (e: unknown) { if ((e as { status?: unknown }).status !== 1) throw e }
  assert.equal(out, '')
})
