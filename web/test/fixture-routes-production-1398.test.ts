// #1398: a fixture route cannot answer on production, one test per route.
// A fixture handler is a file named route.staging.ts. Next only turns a file into a route when its name is "route." plus one
// of the configured pageExtensions, and next.config.ts adds 'staging.ts' to that list only when the build runs with
// DAZL_ENV=staging. So a production build has no handler at the fixture URL and Next answers 404 before any of our code runs.
// This test reads the real next.config.ts under each environment and applies that naming rule to the real files.
// The built artifact itself is checked by scripts/check-fixture-route-artifact.mjs in the release gate and the production
// build workflow; the last test here keeps that script's list equal to the fixture routes on disk.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUTE_TEMPLATES } from '../lib/ops/routes.ts'

const web = fileURLToPath(new URL('../', import.meta.url))
const FIXTURE_ROUTES = ['/api/leads/ranking-fixture', '/api/leads/tech-fixture', '/api/leads/verification-fixture', '/api/outreach/inbox/fixture', '/api/outreach/sequences/fixture']

// The pageExtensions the real config yields for a build run with this DAZL_ENV (undefined = not set at all).
function pageExtensions(dazlEnv: string | undefined): string[] {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of ['NODE_TEST_CONTEXT', 'DAZL_ENV']) delete env[k]
  if (dazlEnv !== undefined) env.DAZL_ENV = dazlEnv
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e',
    "const c = (await import('./next.config.ts')).default; console.log(JSON.stringify(c.pageExtensions))"], { cwd: web, env, encoding: 'utf8', timeout: 30000 })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout) as string[]
}
// Next's App Router rule: a route handler is a file named exactly "route.<page extension>".
const handlerFiles = (route: string, exts: string[]) => readdirSync(join(web, 'app', route)).filter(f => exts.some(e => f === `route.${e}`))

const PRODUCTION = pageExtensions(undefined)
const STAGING = pageExtensions('staging')

test('#1398 the production build registers no staging file name; only DAZL_ENV=staging exactly does', () => {
  assert.deepEqual(PRODUCTION, ['tsx', 'ts', 'jsx', 'js'])
  assert.deepEqual(STAGING, ['staging.ts', 'tsx', 'ts', 'jsx', 'js'])
  for (const other of ['production', '', 'Staging', 'staging ', '1', 'true']) assert.deepEqual(pageExtensions(other), PRODUCTION, JSON.stringify(other))
})

for (const route of FIXTURE_ROUTES) {
  test(`#1398 ${route}: no handler in a production build, one in a staging build`, () => {
    assert.deepEqual(readdirSync(join(web, 'app', route)), ['route.staging.ts'], 'the only file is the staging handler')
    assert.deepEqual(handlerFiles(route, PRODUCTION), [], 'production: Next finds no route here and answers 404')
    assert.deepEqual(handlerFiles(route, STAGING), ['route.staging.ts'], 'staging: the handler is registered')
  })
}

test('#1398 the five routes above are every fixture route, and the release check on the built artifact names the same five', () => {
  // every directory under app/api whose handler is staging-only, or whose path says fixture
  const found: string[] = []
  const walk = (dir: string) => {
    const entries = readdirSync(join(web, 'app', dir), { withFileTypes: true })
    if (/fixture/i.test(dir) && entries.some(e => e.isFile() && /^route\./.test(e.name)) || entries.some(e => e.isFile() && /\.staging\.[cm]?[jt]sx?$/.test(e.name))) found.push(dir)
    for (const e of entries) if (e.isDirectory()) walk(`${dir}/${e.name}`)
  }
  walk('/api')
  assert.deepEqual(found.sort(), [...FIXTURE_ROUTES].sort())
  assert.deepEqual(ROUTE_TEMPLATES.filter(r => /fixture/i.test(r)).sort(), [...FIXTURE_ROUTES].sort())
  const checker = readFileSync(join(web, 'scripts', 'check-fixture-route-artifact.mjs'), 'utf8')
  const listed = /for \(const p of \[([^\]]+)\]\)/.exec(checker)?.[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')) ?? []
  assert.deepEqual(listed.sort(), [...FIXTURE_ROUTES].sort())
  // no page or component outside /api is a staging-only file, so nothing else changes between the two builds
  const stagingNamed: string[] = []
  const all = (dir: string) => { for (const e of readdirSync(join(web, dir), { withFileTypes: true })) { if (e.isDirectory()) all(join(dir, e.name)); else if (/\.staging\.[cm]?[jt]sx?$/.test(e.name)) stagingNamed.push(join(dir, e.name)) } }
  all('app')
  assert.deepEqual(stagingNamed.sort(), FIXTURE_ROUTES.map(r => join('app', r, 'route.staging.ts')).sort())
})
