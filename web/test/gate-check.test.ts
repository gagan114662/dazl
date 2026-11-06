// scripts/gate-check.mjs (PR #641 review 6633107161 point 2): tag coverage is not proof. A gate PASS needs at
// least one executed, non-skipped test whose own NAME carries #N; comments, describe titles, longer numbers,
// skipped/todo tests, crashing files and unrelated failures in the same file never count as green.
// Fixtures live in test/fixtures/gate-check/ (never scanned by the real gate, never run by npm test).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gate, main, filesDeclaring, ISSUE_RE } from '../scripts/gate-check.mjs'

const FIX = ['test/fixtures/gate-check']

function cnt(r: ReturnType<typeof gate>) {
  assert.ok(r.c, r.reason)
  return r.c
}

function run(argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = main(argv, FIX, (s: string) => out.push(s), (s: string) => err.push(s))
  return { code, out: out.join('\n'), err: err.join('\n') }
}

test('a test named #N that executes and passes is PASS, with executed/skipped counts printed', () => {
  const r = gate('4201', FIX)
  assert.equal(r.ok, true, r.reason)
  assert.deepEqual(r.files, ['test/fixtures/gate-check/pass.test.mjs'])
  assert.equal(cnt(r).executed, 1)
  assert.equal(cnt(r).passed, 1)
  assert.equal(cnt(r).skipped, 0)
  const cli = run(['4201'])
  assert.equal(cli.code, 0)
  assert.match(cli.out, /GATE #4201: PASS .*tagged executed=1 passed=1 failed=0 skipped=0 todo=0/)
  assert.match(cli.out, /never closes an issue/)
})

test('#N only in a comment is FAIL (not tag coverage)', () => {
  const r = gate('4202', FIX)
  assert.equal(r.ok, false)
  assert.deepEqual(r.files, [])
  assert.match(r.reason, /no test is NAMED/)
})

test('#N only in a describe() title is FAIL: the test itself must carry the tag', () => {
  assert.equal(gate('4203', FIX).ok, false)
})

test('only skipped/todo tagged tests: 0 executed is FAIL, and the skip/todo counts are printed', () => {
  const r = gate('4204', FIX)
  assert.equal(r.ok, false)
  assert.equal(cnt(r).executed, 0)
  assert.equal(cnt(r).skipped, 1)
  assert.equal(cnt(r).todo, 1)
  assert.match(r.reason, /no tagged test executed/)
  const cli = run(['4204'])
  assert.equal(cli.code, 1)
  assert.match(cli.out, /GATE #4204: FAIL .*executed=0 .*skipped=1 todo=1/)
})

test('a failing tagged test is FAIL even when another tagged test passes, and the failure is named', () => {
  const r = gate('4205', FIX)
  assert.equal(r.ok, false)
  assert.equal(cnt(r).failed, 1)
  assert.equal(cnt(r).passed, 1)
  assert.match(run(['4205']).err, /#4205 tagged and failing/)
})

test('an untagged failure in a tagged file is FAIL: nothing failing is ever called unrelated', () => {
  const r = gate('4206', FIX)
  assert.equal(r.ok, false)
  assert.equal(cnt(r).otherFailed, 1)
  assert.equal(cnt(r).exit, 1)
})

test('a longer number does not tag its prefix (fixture 42070 vs 4207)', () => {
  assert.deepEqual(filesDeclaring('4207', FIX), [])
  assert.equal(gate('4207', FIX).ok, false)
})

test('a file that crashes at import time is FAIL even though it declares a tagged test', () => {
  const r = gate('4208', FIX)
  assert.equal(r.ok, false)
  assert.notEqual(cnt(r).exit, 0)
})

test('an issue mentioned only in a comment of a file that tags another issue is FAIL', () => {
  assert.equal(gate('4209', FIX).ok, true)
  assert.equal(gate('4210', FIX).ok, false)
})

test('one FAIL among several issues makes the whole run exit 1; duplicates and a leading # are folded', () => {
  const r = run(['4201', '#4201', '4202'])
  assert.equal(r.code, 1)
  assert.equal(r.out.match(/GATE #4201:/g)?.length, 1)
  assert.match(r.out, /GATE #4202: FAIL/)
})

test('malformed issue arguments are usage errors (exit 2), never regex fragments or a silent pass', () => {
  for (const bad of [[], ['.*'], ['0'], ['01'], ['12345678'], [''], ['#'], ['5 69'], ['569x'], ['-1'], ['１２'], ['--list']]) {
    const r = run(bad)
    assert.equal(r.code, 2, JSON.stringify(bad))
    assert.equal(r.out, '', JSON.stringify(bad))
  }
  assert.throws(() => filesDeclaring('.*', FIX), /not an issue number/)
  assert.equal(ISSUE_RE.test('569'), true)
})

test('--list is a static scan of test NAMES and reports only issues with a named test', () => {
  const r = run(['--list', '4201', '4202', '4203', '4204', '4207', '4209', '4210'])
  assert.equal(r.code, 0)
  assert.equal(r.out, 'numbers=4201,4204,4209')
  assert.equal(run(['--list', 'abc']).code, 2)
})

test('the real gate never scans test/fixtures, so fixture tags cannot vouch for a real issue', () => {
  assert.deepEqual(filesDeclaring('4201'), [])
})
