// Refs #894: every real test file must be discovered by a canonical runner.
// The canonical web suite is `node --test test/*.test.ts` (package.json "test").
// Anything else named *.test.* / *.spec.* must be listed below with the entry
// point that runs it, or be an intentional fixture program.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { discovery, explicitlyRegistered } from './helpers/test-discovery.ts'

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

test('no real test file is stranded outside canonical discovery (explicit package.json test arguments count; nothing else does)', () => {
  const pkg = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8'))
  const r = discovery({ files: walk(WEB, []), script: pkg.scripts.test, fixturePrefixes: FIXTURE_PREFIXES, ownEntryPoints: OWN_ENTRY_POINTS })
  assert.deepEqual(r.stranded, [], `move these into web/test/ or register their entry point: ${r.stranded.join(', ')}`)
  assert.deepEqual(r.registeredButMissing, [], `package.json test names files that do not exist: ${r.registeredButMissing.join(', ')}`)
})

// Synthetic controls for the registration rule (no filesystem): the exact shape #955 adds, a truly stranded .mjs, and the ways a registration must NOT count.
const FIX = { fixturePrefixes: FIXTURE_PREFIXES, ownEntryPoints: OWN_ENTRY_POINTS }
const BASE = 'SITECRAWL_ENABLED=0 NEWS_SEARCH_ENABLED=0 node --experimental-strip-types --import ./test/helpers/net-fence.ts --test test/*.test.ts'
test('registered .mjs positive control: a test file named exactly after --test is discovered; a different .mjs is still stranded', () => {
  const files = ['test/a.test.ts', 'test/crm-webhook-unknown-ui.test.mjs', 'test/orphan.test.mjs']
  const script = `${BASE} test/crm-webhook-unknown-ui.test.mjs`
  assert.deepEqual(explicitlyRegistered(script), ['test/crm-webhook-unknown-ui.test.mjs'])
  const r = discovery({ files, script, ...FIX })
  assert.deepEqual(r.stranded, ['test/orphan.test.mjs'], 'the registered file is exempt, the unregistered one is not (no blanket .mjs exemption)')
  assert.deepEqual(r.registeredButMissing, [])
  assert.deepEqual(discovery({ files, script: BASE, ...FIX }).stranded, ['test/crm-webhook-unknown-ui.test.mjs', 'test/orphan.test.mjs'], 'without the registration both are stranded')
})
test('what does not count as a registration: globs, flags, other positions, paths outside test/, traversal, shell chains, near-miss names', () => {
  const none = (script: string) => assert.deepEqual(explicitlyRegistered(script), [], script)
  none(`${BASE} test/*.test.mjs`)                                  // a glob is a pattern, not a named file
  none(`${BASE} test/sub/**/*.test.mjs`)
  none(`${BASE} --test-reporter=spec`)                             // a flag
  none('node --import test/helpers/x.test.mjs --test test/*.test.ts') // before --test: an argument of another flag
  none(`${BASE} scripts/quality/calibration.test.mjs`)             // outside test/
  none(`${BASE} test/../scripts/x.test.mjs`)                        // traversal never matches a clean test/ path
  none(`${BASE} && node other.js test/x.test.mjs`)                 // after a shell operator
  none(`${BASE} test/x.test.mjs.bak`)                              // near-miss extension
  none(`${BASE} test/x.mjs`)                                       // not a test file name
  // the root ts glob is already discovery; naming a root ts file adds nothing and is not treated as an extra registration
  none(`${BASE} test/a.test.ts`)
  // a registration for a file that does not exist is reported, and exempts nothing real
  const r = discovery({ files: ['test/orphan.test.mjs'], script: `${BASE} test/typo.test.mjs`, ...FIX })
  assert.deepEqual(r.stranded, ['test/orphan.test.mjs']); assert.deepEqual(r.registeredButMissing, ['test/typo.test.mjs'])
  // two explicit files both count
  assert.deepEqual(explicitlyRegistered(`${BASE} test/one.test.mjs test/two.spec.cjs`), ['test/one.test.mjs', 'test/two.spec.cjs'])
})

test('exempt own-entry-point suites are really wired into CI', () => {
  const wf = readFileSync(join(WEB, '..', '.github', 'workflows', 'static-quality.yml'), 'utf8')
  for (const f of OWN_ENTRY_POINTS) assert.ok(wf.includes(f), `${f} is exempt but not run by static-quality.yml`)
})
