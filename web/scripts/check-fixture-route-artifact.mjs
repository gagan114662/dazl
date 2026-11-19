// Fails closed on missing build metadata. Check the assembled artifact, not source or runtime env.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
if (variant === 'production') {
  // These literals are unique to the staging sequence creators, not their shared availability guard.
  // Route metadata alone cannot catch code bundled through an otherwise ordinary route or client chunk.
  const fixturePayloads = [
    'dazl sequence test - step 1 of 3',
    'dazl sequence test - reply stop check - step 1 of 2',
    'test-only-sequence-fixture',
    'This follow-up should never be sent.',
  ]
  function checkChunks(dir) {
    for (const entry of readdirSync(join(dist, dir), { withFileTypes: true })) {
      const relative = join(dir, entry.name)
      if (entry.isDirectory()) checkChunks(relative)
      else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) {
        const chunk = readFileSync(join(dist, relative))
        assert.ok(!fixturePayloads.some(marker => chunk.includes(marker)), `fixture payload shipped to production: ${relative}`)
      }
    }
  }
  checkChunks('server')
  checkChunks('static')
}
console.log(`Fixture route artifact verified: ${variant}`)
