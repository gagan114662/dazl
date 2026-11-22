// #1398 (launch brief: no QA-only paths or fixtures in prod builds). Every test/QA fixture module lives in lib/staging-fixtures/, and only
// staging-only code reaches it: the route.staging.ts handlers (registered by the staging build alone, next.config.ts pageExtensions),
// the staging-only fixture UI shell, other lib/staging-fixtures modules, and tests. The ordinary app loads the shell only through a dynamic
// import behind the build-inlined NEXT_PUBLIC_DAZL_STAGING flag. Red on main before this PR: the fixtures sat in lib/scan and lib/outreach.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const WEB = new URL('..', import.meta.url).pathname
const files = (dir: string): string[] => readdirSync(join(WEB, dir)).flatMap(n => {
  const rel = join(dir, n)
  if (n === 'node_modules' || n.startsWith('.')) return []
  return statSync(join(WEB, rel)).isDirectory() ? files(rel) : /\.(?:ts|tsx|mts|mjs)$/.test(n) ? [rel] : []
})
const SHELL = 'app/app/leads/verification-fixture.tsx'

test('#1398 no fixture module outside lib/staging-fixtures', () => {
  const stray = [...files('lib'), ...files('app')].filter(f => !f.startsWith('lib/staging-fixtures/') && /(?:-fixture|fixture-action-result|real-company-check)\.ts$/.test(f))
  assert.deepEqual(stray, [])
})

test('#1398 only staging-only code imports lib/staging-fixtures; the app loads the fixture shell only behind the staging flag', () => {
  for (const f of [...files('lib'), ...files('app')]) {
    if (f.startsWith('lib/staging-fixtures/') || f.endsWith('.staging.ts') || f === SHELL) continue
    const src = readFileSync(join(WEB, f), 'utf8')
    assert.doesNotMatch(src, /from\s+['"][^'"]*\/staging-fixtures\/|import\(\s*['"][^'"]*\/staging-fixtures\//, `${f} imports a staging fixture`)
    assert.doesNotMatch(src, /from\s+['"]\.\/verification-fixture['"]/, `${f} statically imports the fixture shell`)
  }
  const leads = readFileSync(join(WEB, 'app/app/leads/leads-client.tsx'), 'utf8')
  assert.match(leads, /process\.env\.NEXT_PUBLIC_DAZL_STAGING === '1' \? dynamic\(\(\) => import\('\.\/verification-fixture'\)\) : \(\) => null/)
})
