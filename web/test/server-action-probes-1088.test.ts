// #1088: a request with a Next-Action header is answered 400 by proxy.ts, because this app has no server actions. The first
// test is the guard for that premise: the day someone adds a server action, it fails and says what to change.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isServerActionProbe, SERVER_ACTION_PROBE_MATCHER } from '../lib/ops/server-action-probe.ts'

const web = fileURLToPath(new URL('../', import.meta.url))

test("the app has no server actions (no 'use server' directive in any source file)", () => {
  const files = execFileSync('git', ['ls-files', 'app', 'lib', 'components', 'proxy.ts'], { cwd: web, encoding: 'utf8' }).split('\n').filter(f => /\.(ts|tsx|mts|js|jsx|mjs)$/.test(f))
  assert.ok(files.length > 100, 'the source files were listed')
  const using = files.filter(f => /^\s*['"]use server['"]/m.test(readFileSync(`${web}${f}`, 'utf8')))
  assert.deepEqual(using, [], "a server action was added: proxy.ts answers every Next-Action request with 400, so it would never run. Narrow isServerActionProbe (e.g. to ids missing from the build's server-reference-manifest) before adding one.")
})

test('a request with a Next-Action header is a probe, whatever its case; others are not', () => {
  assert.equal(isServerActionProbe(new Headers({ 'Next-Action': 'x' })), true)
  assert.equal(isServerActionProbe(new Headers({ 'next-action': '7f0000000000000000000000000000000000000000' })), true)
  assert.equal(isServerActionProbe(new Headers({ 'content-type': 'text/plain;charset=UTF-8', accept: 'text/x-component' })), false)
})

test('proxy.ts answers the probe first (before the session lookup) with a 400, and runs for it on every path', () => {
  const src = readFileSync(`${web}proxy.ts`, 'utf8')
  const probeAt = src.indexOf('if (isServerActionProbe(req.headers))'), sessionAt = src.indexOf('signedIn(')
  assert.ok(probeAt > 0 && probeAt < sessionAt, 'the probe is answered before any session lookup')
  assert.match(src.slice(probeAt, probeAt + 400), /status: 400/)
  // Next reads `config` statically, so the matcher is written out in proxy.ts: it must be the one this module names
  const m = /export const config = \{ matcher: (\[.*\]) \}/.exec(src)
  assert.ok(m, 'the matcher is one literal line')
  // the literal, read as JSON (single quotes and bare keys normalised): no evaluation of source text
  const literal = JSON.parse(m![1].replace(/'/g, '"').replace(/([{,]\s*)([a-z]+):/g, '$1"$2":'))
  assert.deepEqual(literal, ['/app/:path*', '/api/:path*', SERVER_ACTION_PROBE_MATCHER])
})
// The behaviour itself (a real POST with Next-Action -> 400 on a production build, and an ordinary page still 200) is checked by
// test/smoke/app-pages.smoke.mjs, which CI runs on the built app.
