// Fails closed on missing build metadata. Check the assembled route registry, not source or runtime env.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const [variant, dist = '.next'] = process.argv.slice(2)
assert.ok(variant === 'production' || variant === 'staging', 'usage: check-fixture-route-artifact.mjs production|staging [.next]')
const routes = JSON.parse(readFileSync(join(dist, 'app-path-routes-manifest.json'), 'utf8'))
const modules = JSON.parse(readFileSync(join(dist, 'server/app-paths-manifest.json'), 'utf8'))
assert.equal(routes['/api/scan/route'], '/api/scan', 'artifact is missing ordinary scan route')
assert.ok(existsSync(join(dist, 'server', modules['/api/scan/route'])), 'artifact is missing ordinary scan module')
for (const p of ['/api/leads/ranking-fixture', '/api/leads/tech-fixture', '/api/leads/verification-fixture', '/api/outreach/inbox/fixture', '/api/outreach/sequences/fixture']) {
  const key = p + '/route'
  if (variant === 'staging') {
    assert.equal(routes[key], p, `missing staging fixture route: ${p}`)
    assert.ok(existsSync(join(dist, 'server', modules[key])), `missing staging fixture module: ${p}`)
  } else {
    assert.ok(!Object.values(routes).includes(p) && !(key in modules), `fixture route shipped to production: ${p}`)
    assert.ok(!existsSync(join(dist, 'server/app', p)), `fixture module shipped to production: ${p}`)
  }
}
console.log(`Fixture route artifact verified: ${variant}`)
