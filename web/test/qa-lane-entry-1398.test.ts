// #1398: what a real user can and cannot start on production.
// 1. The real handlers, run as a production server (test/helpers/qa-lane-entry-1398-runtime.mts): the only request that starts
//    the isolated Claude-only job is the first-run screen's own Claude Web Search opt-in, from an account with its own
//    Anthropic key. The three names in the audit, and every other way to post the lane's markers, start nothing.
// 2. The screens: no file a browser loads names a retired mode, and the only scan modes the app sends are the ordinary
//    first play and the website profile review.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const web = fileURLToPath(new URL('../', import.meta.url))

test('#1398 production server: only the first-run Claude Web Search opt-in starts the isolated Claude-only job', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' }
  for (const k of ['NODE_TEST_CONTEXT', 'DAZL_ENV', 'DAZL_COMPANY_FIRST_TENANT_ID', 'DAZL_SCAN_SHARED_QUEUE', 'DAZL_QUEUE_TENANTS', 'DATABASE_URL']) delete env[k]
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/scan-route-loader.mjs', '--test', '--test-reporter=tap', './test/helpers/qa-lane-entry-1398-runtime.mts'],
  { cwd: web, env, encoding: 'utf8', timeout: 90000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 6\b/); assert.match(r.stdout, /# fail 0\b/)
})

function sources(dir: string): string[] {
  return readdirSync(join(web, dir), { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name)
    return e.isDirectory() ? sources(p) : /\.tsx?$/.test(e.name) ? [p] : []
  })
}

test('#1398 the screens: no retired mode name, and the only scan modes sent are first5 and the website profile review', () => {
  const pages = sources('app').filter(p => !p.startsWith(join('app', 'api')))
  assert.ok(pages.includes(join('app', 'app', 'first-run.tsx')), 'the first-run screen is among the files read')
  const modes = new Map<string, string[]>()
  for (const p of pages) {
    const text = readFileSync(join(web, p), 'utf8')
    assert.doesNotMatch(text, /first5_claude_only|claude_only_pinned/, `${p} names a retired QA mode`)
    // A request body that sets mode: a quoted value or a named constant. Anything else (a variable) fails the test below.
    for (const m of text.matchAll(/\bmode:\s*('([^']*)'|"([^"]*)"|[A-Z][A-Z0-9_]*\b)/g)) {
      const value = m[2] ?? m[3] ?? m[1]
      modes.set(value, [...(modes.get(value) ?? []), p])
    }
  }
  const scanModes = [...modes.keys()].filter(v => /first5|claude|qa|review_v\d|_v\d+$/i.test(v)).sort()
  assert.deepEqual(scanModes, ['first5', 'website_profile_review_v1'], JSON.stringify([...modes]))
  assert.deepEqual([...new Set(modes.get('first5'))].sort(), [join('app', 'app', 'first-run.tsx'), join('app', 'app', 'manual-native-target.ts')])

  // The first-run screen offers the opt-in as one labelled box, and sends exactly the budget the server test above accepts.
  const firstRun = readFileSync(join(web, 'app', 'app', 'first-run.tsx'), 'utf8')
  assert.equal(firstRun.match(/data-testid="claude-search-opt-in"/g)?.length, 1)
  assert.match(firstRun, /const CLAUDE_SEARCH_POLICY = 'anthropic_estimated_v1'/)
  assert.match(firstRun, /\.\.\.\(useClaudeSearch \? \{ budget: \{ web_search: CLAUDE_SEARCH_POLICY \} \} : \{\}\)/)
  assert.equal(firstRun.match(/\bbudget:/g)?.length, 1, 'the first-run screen sets a budget in exactly one place')
  const manual = readFileSync(join(web, 'app', 'app', 'manual-native-target.ts'), 'utf8')
  assert.match(manual, /mode:'first5',budget:\{web_search:'anthropic_estimated_v1',target_review:'manual_v1'\}/)
})
