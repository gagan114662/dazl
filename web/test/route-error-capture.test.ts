// Every API route that catches an error and answers 5xx itself (instead of rethrowing to Next's onRequestError, which
// already reports it) must hand the error to the central reporter (lib/ops/errors.ts captureError). A failure a route
// swallows into a 500/502/503 would otherwise never reach the logs or the Sentry-compatible hook. Static: reads the
// route sources, runs nothing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const web = fileURLToPath(new URL('../', import.meta.url))
const routes = (dir: string): string[] => readdirSync(dir).flatMap(n => {
  const p = join(dir, n)
  return statSync(p).isDirectory() ? routes(p) : n === 'route.ts' ? [p] : []
})

// The body of each `catch (x) { ... }` / `catch { ... }` block, by brace matching (strings in these files hold no braces
// that matter for this: a stray one only shifts a block's end, and the test then reads more, never less).
function catchBlocks(src: string): string[] {
  const out: string[] = []
  const re = /catch\s*(\([^)]*\))?\s*\{/g
  for (let m; (m = re.exec(src));) {
    let depth = 1, i = m.index + m[0].length
    for (; i < src.length && depth > 0; i++) depth += src[i] === '{' ? 1 : src[i] === '}' ? -1 : 0
    out.push(src.slice(m.index + m[0].length, i - 1))
  }
  return out
}
// answers 5xx from inside the block: a literal 5xx status, or a status computed by a failure mapper (draftFailure)
const answers5xx = (b: string) => /status:\s*5\d\d/.test(b) || /status:\s*f\.status/.test(b)
const rethrows = (b: string) => /\bthrow\b/.test(b)
// Known, expected refusals that are not failures: a feature the operator has not configured.
const configRefusal = (b: string) => /instanceof\s+\w+Error\s*&&\s*e\.kind === 'config'/.test(b)

test('every API route that swallows an error into a 5xx reports it through captureError', () => {
  const offenders: string[] = []
  for (const f of routes(join(web, 'app', 'api'))) {
    for (const b of catchBlocks(readFileSync(f, 'utf8'))) {
      if (answers5xx(b) && !rethrows(b) && !configRefusal(b) && !b.includes('captureError(')) offenders.push(`${relative(web, f)}: ${b.trim().split('\n')[0].slice(0, 100)}`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('the guard itself: finds a swallowed 5xx, accepts a reported or rethrown one', () => {
  const blocks = catchBlocks(`try { a() } catch (e) { return NextResponse.json({ error: 'x' }, { status: 502 }) }
    try { b() } catch (e) { captureError(e, ctx); return NextResponse.json({}, { status: 500 }) }
    try { c() } catch (e) { if (e instanceof X) return NextResponse.json({}, { status: 400 }); throw e }
    try { d() } catch { return NextResponse.json({ error: 'Bad payload' }, { status: 400 }) }`)
  assert.equal(blocks.length, 4)
  assert.deepEqual(blocks.map(b => answers5xx(b) && !rethrows(b) && !b.includes('captureError(')), [true, false, false, false])
})
