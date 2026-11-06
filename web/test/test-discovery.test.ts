// Refs #894: every real test file must be discovered by a canonical runner.
// The canonical web suite is `node --test test/*.test.ts` (package.json "test").
// Anything else named *.test.* / *.spec.* must be listed below with the entry
// point that runs it, or be an intentional fixture program.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const WEB = join(import.meta.dirname, '..')
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'coverage', 'preview'])
// Fixture programs that intentionally fail/skip/crash for the gate checker.
const FIXTURE_PREFIXES = ['test/fixtures/']
// Dedicated suites with their own entry points (see .github/workflows/static-quality.yml).
const OWN_ENTRY_POINTS = new Set([
  'scripts/quality/calibration.test.mjs',
  'scripts/quality/integration.test.mjs',
])

function walk(dir: string, out: string[]) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), out)
    } else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name)) {
      out.push(relative(WEB, join(dir, e.name)).split('\\').join('/'))
    }
  }
  return out
}

test('canonical test command still globs test/*.test.ts', () => {
  const pkg = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8'))
  assert.match(pkg.scripts.test, /--test test\/\*\.test\.ts\b/)
})

test('no real test file is stranded outside canonical discovery', () => {
  const stranded = walk(WEB, []).filter((f) => {
    if (/^test\/[^/]+\.test\.ts$/.test(f)) return false
    if (FIXTURE_PREFIXES.some((p) => f.startsWith(p))) return false
    if (OWN_ENTRY_POINTS.has(f)) return false
    return true
  })
  assert.deepEqual(stranded, [], `move these into web/test/ or register their entry point: ${stranded.join(', ')}`)
})

test('exempt own-entry-point suites are really wired into CI', () => {
  const wf = readFileSync(join(WEB, '..', '.github', 'workflows', 'static-quality.yml'), 'utf8')
  for (const f of OWN_ENTRY_POINTS) assert.ok(wf.includes(f), `${f} is exempt but not run by static-quality.yml`)
})
