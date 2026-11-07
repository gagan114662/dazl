// Shape and leak check for ONE request log line (lib/ops/request-log.ts requestLogLine), shared by the real-proxy child (proxy-runtime.mts) and the deterministic controls
// in request-log.test.ts.
//
// The line has exactly two fields that are random or clock-driven, and neither can carry request input: request_id (a random UUID, any digits) and ts (the clock, any digits,
// e.g. a legitimate ".555Z"). Each is checked for its OWN validity. The leak check runs on the fields that are derived from the request or fixed by the logger (level, type, method,
// path), so a digit run such as "555" in a timestamp or id can never look like a leaked phone number, while the same digits in the path still fail.
import assert from 'node:assert/strict'
import { isRequestId } from '../../lib/ops/request-log.ts'

export const INPUT_LEAKS = ['jane', 'secret', '555', 'evil', 'tok'] as const
const ISO_MS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/

export function assertRequestLogLine(line: string, leaks: readonly string[] = INPUT_LEAKS): Record<string, unknown> {
  const l = JSON.parse(line) as Record<string, unknown>
  assert.deepEqual(Object.keys(l).sort(), ['level', 'method', 'path', 'request_id', 'ts', 'type'], 'a request log line has exactly the fixed fields')
  assert.ok(typeof l.request_id === 'string' && isRequestId(l.request_id), `request_id is a random UUID, never the caller's value: ${String(l.request_id)}`)
  assert.ok(typeof l.ts === 'string' && ISO_MS.test(l.ts) && new Date(l.ts).toISOString() === l.ts, `ts is a valid ISO-8601 millisecond timestamp: ${String(l.ts)}`)
  const derived = JSON.stringify({ level: l.level, type: l.type, method: l.method, path: l.path })   // everything the request can influence
  for (const leak of leaks) assert.ok(!derived.includes(leak), `input-derived fields must not contain ${leak}: ${derived}`)
  return l
}
