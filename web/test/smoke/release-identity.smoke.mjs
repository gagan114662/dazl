// Release identity and readiness on the production build (issue #362). NOT part of `npm test`. Run after a build:
//   npm run test:smoke:release
// Writes the release manifest (ops/release-manifest.mjs write), starts the build with a complete synthetic test-mode
// environment (throwaway master key, sk_test_/whsec_ values generated here; nothing reaches Stripe: network fence), then:
// - `release-manifest.mjs check` passes: the exact commit, the exact build, and /api/ready ok;
// - a manifest naming another commit, or another build id, fails the check (a stale or wrong release is caught);
// - the same commit and build id with one chunk's bytes changed on disk while the server runs fails the check (the
//   static tree is verified byte for byte, not just that the build exists);
// - without the required environment, /api/ready is 503 and the check fails (readiness is really checked).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { root, startServer } from './harness.mjs'

const tool = path.join(root, '../ops/release-manifest.mjs')
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-release-'))
const manifestPath = path.join(tmp, 'release.json')
const run = (...args) => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' })
const w = run('write', root, manifestPath)
assert.equal(w.status, 0, w.stderr)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
assert.match(manifest.commit, /^[0-9a-f]{40}$/)
console.log(`ok   manifest: ${manifest.commit} build ${manifest.build_id}, ${manifest.static_files} static files`)

const fence = path.join(root, 'test/helpers/net-fence.ts')
const readyEnv = {
  NODE_OPTIONS: `--experimental-strip-types --import ${fence} --import ${path.join(root, 'test/smoke/stripe-test-env.mjs')}`,
  SMOKE_MASTER_B64: randomBytes(32).toString('base64'), SMOKE_STRIPE_SK: 'sk_test_smoke' + randomBytes(6).toString('hex'),
  SMOKE_STRIPE_WHSEC: 'whsec_' + randomBytes(12).toString('hex'), STRIPE_PRICE_PRO: 'price_smoke',
}
const variant = (name, patch) => { const f = path.join(tmp, `${name}.json`); writeFileSync(f, JSON.stringify({ ...manifest, ...patch })); return f }
let srv
try {
  srv = await startServer({ env: readyEnv })
  const ok = run('check', manifestPath, srv.base)
  assert.equal(ok.status, 0, `check failed on the release it was built from: ${ok.stderr}${ok.stdout}`)
  console.log(`ok   check passes: ${ok.stdout.trim()}`)
  const wrongCommit = run('check', variant('commit', { commit: 'f'.repeat(40) }), srv.base)
  assert.equal(wrongCommit.status, 1); assert.match(wrongCommit.stderr, /serves commit/)
  const wrongBuild = run('check', variant('build', { build_id: 'build-not-this-one' }), srv.base)
  assert.equal(wrongBuild.status, 1); assert.match(wrongBuild.stderr, /build build-not-this-one: its _buildManifest\.js is not among/)
  console.log('ok   another commit or another build id fails the check')
  // one chunk changed on disk (same commit, same build id), restored right after
  const chunk = Object.keys(manifest.static).find(f => f.startsWith('chunks/') && f.endsWith('.js'))
  const file = path.join(root, '.next/static', chunk), size = readFileSync(file).length
  appendFileSync(file, '\n/* changed after the build */\n')
  let changed
  try { changed = run('check', manifestPath, srv.base) } finally { truncateSync(file, size) }
  assert.equal(changed.status, 1, changed.stdout); assert.match(changed.stderr, new RegExp(`1 of ${manifest.static_files} static files differ from the manifest: ${chunk.replace(/[.]/g, '\\.')} \\(different bytes\\)`))
  assert.equal(run('check', manifestPath, srv.base).status, 0, 'passes again once the chunk is restored')
  console.log(`ok   the same commit and build id with one chunk changed (${chunk}) fails the check`)
  srv.stop(); srv = null

  srv = await startServer() // the harness default: no master key, no Stripe values
  const notReady = run('check', manifestPath, srv.base)
  assert.equal(notReady.status, 1); assert.match(notReady.stderr, /not ready \(HTTP 503/)
  console.log('ok   without the required environment the check fails as not ready')
} finally {
  srv?.stop(); rmSync(tmp, { recursive: true, force: true })
}
console.log('\nRelease identity: exact commit, exact build and readiness are all checked.')
