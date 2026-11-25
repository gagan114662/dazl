import assert from 'node:assert/strict'
import test from 'node:test'
import { unexpectedStallWrites, type SmokeWrite, type SmokePageError } from './helpers/stall-write-quarantine.ts'

const origin = 'http://127.0.0.1:4000'
const frames = [{ file: '/_next/static/chunks/react.js', line: 31, col: 47398 }]
const error: SmokePageError = { path: '/app/settings', message: 'Minified React error #418; visit https://react.dev/errors/418', stack: `Error: Minified React error #418
    at r1 (${origin}${frames[0].file}:31:47398)` }
const write: SmokeWrite = { method: 'POST', url: `${origin}/api/client-errors`, body: JSON.stringify({ kind: 'error', type: 'Error', path: '/app/settings', frames }) }

test('the issue-tracked Settings React418 report alone is quarantined', () => {
  assert.deepEqual(unexpectedStallWrites([write], [error], origin), [])
})

const body = (changes: Record<string, unknown> = {}) => JSON.stringify({ kind: 'error', type: 'Error', path: '/app/settings', frames, ...changes })
const controls: [string, SmokeWrite, SmokePageError[]][] = [
  ['another route', { ...write, body: body({ path: '/app/leads' }) }, [{ ...error, path: '/app/leads' }]],
  ['another observed route', write, [{ ...error, path: '/app/leads' }]],
  ['a different React error', write, [{ ...error, message: 'Minified React error #419;' }]],
  ['a different Settings error', write, [{ ...error, message: 'Unrelated Settings failure' }]],
  ['a different endpoint', { ...write, url: `${origin}/api/send` }, [error]],
  ['a different origin', { ...write, url: 'https://foreign.example/api/client-errors' }, [error]],
  ['an endpoint query', { ...write, url: `${write.url}?other=1` }, [error]],
  ['a different method', { ...write, method: 'PUT' }, [error]],
  ['invalid JSON', { ...write, body: '{' }, [error]],
  ['a missing body', { ...write, body: null }, [error]],
  ['a null report', { ...write, body: 'null' }, [error]],
  ['an array report', { ...write, body: '[]' }, [error]],
  ['empty frames', { ...write, body: body({ frames: [] }) }, [error]],
  ['different frames', { ...write, body: body({ frames: [{ ...frames[0], col: 1 }] }) }, [error]],
  ['a boundary report', { ...write, body: body({ kind: 'boundary' }) }, [error]],
  ['a different error class', { ...write, body: body({ type: 'TypeError' }) }, [error]],
  ['an extra report field', { ...write, body: body({ extra: 'not allowlisted' }) }, [error]],
  ['no observed page error', write, []],
]
for (const [name, candidate, errors] of controls) test(`the no-writes guard retains ${name}`, () => {
  assert.deepEqual(unexpectedStallWrites([candidate], errors, origin), [`${candidate.method} ${new URL(candidate.url).pathname}`])
})
test('one observed error cannot excuse a second report', () => {
  assert.deepEqual(unexpectedStallWrites([write, write], [error], origin), ['POST /api/client-errors'])
})
test('an unrelated write still fails beside the quarantined report', () => {
  assert.deepEqual(unexpectedStallWrites([write, { ...write, url: `${origin}/api/send` }], [error], origin), ['POST /api/send'])
})
test('no writes needs no exception', () => {
  assert.deepEqual(unexpectedStallWrites([], [], origin), [])
})
