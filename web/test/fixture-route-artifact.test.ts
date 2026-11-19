import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('production artifact refuses bundled fixture payload even with clean route manifests', () => {
  const dist = mkdtempSync(join(tmpdir(), 'fixture-route-artifact-'))
  const checker = fileURLToPath(new URL('../scripts/check-fixture-route-artifact.mjs', import.meta.url))
  const check = () => spawnSync(process.execPath, [checker, 'production', dist], { encoding: 'utf8' })
  try {
    mkdirSync(join(dist, 'server/app/api/scan'), { recursive: true })
    mkdirSync(join(dist, 'server/chunks'))
    mkdirSync(join(dist, 'static/chunks'), { recursive: true })
    writeFileSync(join(dist, 'app-path-routes-manifest.json'), JSON.stringify({ '/api/scan/route': '/api/scan' }))
    writeFileSync(join(dist, 'server/app-paths-manifest.json'), JSON.stringify({ '/api/scan/route': 'app/api/scan/route.js' }))
    writeFileSync(join(dist, 'server/app/api/scan/route.js'), 'export {}')
    const clean = check()
    assert.equal(clean.status, 0, clean.stderr)

    for (const [chunk, token] of [
      ['server/chunks/ordinary.mjs', 'dazl sequence test - step 1 of 3'],
      ['static/chunks/ordinary.js', 'This follow-up should never be sent.'],
    ]) {
      const file = join(dist, chunk)
      writeFileSync(file, `export const synthetic = ${JSON.stringify(token)}`)
      const bad = check()
      assert.equal(bad.status, 1, bad.stdout + bad.stderr)
      assert.ok(bad.stderr.includes(`fixture payload shipped to production: ${chunk}`), bad.stderr)
      rmSync(file)
    }
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})
