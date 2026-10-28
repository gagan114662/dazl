// Step 4 (docs/PLATFORM.md): every API route handler is classified in test/tenant-isolation-manifest.ts, every
// session route refuses an unauthenticated caller, and each two-tenant test the manifest cites really exercises the
// route. A new route, or a route that loses its auth check, fails here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { ROUTES } from './tenant-isolation-manifest.ts'

const web = fileURLToPath(new URL('../', import.meta.url))
// Handlers that take resource ids and have no two-tenant test. Every one has a test now: a new id-taking route must
// come with its two-tenant test.
const PENDING_MAX = 0

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = path.join(dir, n)
    return statSync(p).isDirectory() ? routeFiles(p) : n === 'route.ts' ? [p] : []
  })
}

test('the manifest lists exactly the route handlers that exist', () => {
  const actual = routeFiles(path.join(web, 'app/api')).flatMap(f => {
    const p = path.relative(path.join(web, 'app/api'), path.dirname(f)).split(path.sep).join('/')
    return [...readFileSync(f, 'utf8').matchAll(/export (?:async )?(?:function|const) (GET|POST|PUT|PATCH|DELETE)\b/g)].map(m => `${m[1]} ${p}`)
  }).sort()
  const listed = ROUTES.map(r => `${r.method} ${r.path}`).sort()
  assert.deepEqual(listed, actual, 'add new routes to test/tenant-isolation-manifest.ts (and remove deleted ones)')
  assert.equal(new Set(listed).size, listed.length, 'no duplicates')
})

test('every session route calls requireUser; every public route says what authenticates it', () => {
  for (const r of ROUTES) {
    const src = readFileSync(path.join(web, 'app/api', r.path, 'route.ts'), 'utf8')
    if (r.auth === 'session') assert.match(src, /requireUser\(\)/, `${r.method} /api/${r.path}`)
    else assert.ok(r.note.length > 5, `${r.method} /api/${r.path}: public route needs a note`)
  }
})

test('each cited two-tenant test names the route it covers; the pending list does not grow', () => {
  for (const r of ROUTES) {
    if (r.auth !== 'session' || typeof r.crossTenant !== 'object') continue
    const file = path.join(web, 'test', r.crossTenant.covered)
    assert.ok(existsSync(file), `${r.method} /api/${r.path}: cited test ${r.crossTenant.covered} not found`)
    assert.ok(readFileSync(file, 'utf8').includes(`'${r.method} /api/${r.path}`), `${r.method} /api/${r.path}: not exercised in ${r.crossTenant.covered}`)
  }
  const pending = ROUTES.filter(r => r.auth === 'session' && r.crossTenant === 'pending')
  assert.ok(pending.length <= PENDING_MAX, `pending grew to ${pending.length}: ${pending.map(r => `${r.method} /api/${r.path}`).join(', ')}`)
})

const SCOPED = ROUTES.filter(r => r.auth === 'session' && r.crossTenant === 'session-scope').length

// The route runtimes load route modules through a resolver hook, so each runs in its own process.
for (const [name, file, expect] of [
  ['every session route refuses an unauthenticated caller and changes nothing', 'tenant-route-unauth-runtime.mts', /UNAUTH 105/],
  ["tenant B cannot read or change tenant A's rows through the id-taking lead, batch and reply routes", 'tenant-route-ids-runtime.mts', /COHORT 17/],
  ["tenant B cannot read or change tenant A's rows through the list, body-id and query-id routes, or any session-scope route", 'tenant-route-pending-runtime.mts',
    // 13 targeted handlers, then the sweep over every session-scope handler (the cohort counts both)
    new RegExp(`SWEPT ${SCOPED}\\b[\\s\\S]*COHORT ${13 + SCOPED}\\b`)],
] as const) {
  test(name, () => {
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
      '--loader', './test/helpers/tenant-route-loader.mjs', '--test', `./test/helpers/${file}`], { cwd: web, env, encoding: 'utf8', timeout: 120000 })
    assert.equal(r.error, undefined)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /# pass 1\b/)
    assert.match(r.stdout, expect)
  })
}
