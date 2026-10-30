// Recovery drill with the app (issue #360): a synthetic production-shaped backup (test/helpers/recovery-fixture.mts) is
// drilled with --app pointing at this checkout's production build. NOT part of `npm test`. Run after a build:
//   npm run test:smoke:recovery
// Requires every step to pass, the app to answer ready on the restored copy with sending disabled (tick refused), and
// the busiest tenant's scans, leads, key status and leads page to read back. Prints the measured times.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { root, notRun } from './harness.mjs'

if (!existsSync(path.join(root, '.next/BUILD_ID'))) notRun('no production build (run npm run build first)')
const { fixtureBackup } = await import('../helpers/recovery-fixture.mts')
const T = mkdtempSync(path.join(tmpdir(), 'dazl-recovery-smoke-'))
try {
  const fx = await fixtureBackup(T)
  const report = path.join(T, 'report.json')
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/backup/recovery-drill.mts', '--backup', fx.backup, '--key-file', fx.keyFile, '--work-dir', path.join(T, 'work'), '--app', root, '--report', report], { cwd: root, encoding: 'utf8', timeout: 180_000 })
  console.log(r.stdout + r.stderr)
  assert.equal(r.status, 0)
  const j = JSON.parse(readFileSync(report, 'utf8'))
  const appStep = j.steps.find(s => s.step.startsWith('app'))
  assert.ok(appStep?.ok, 'app step passed')
  assert.equal(appStep.detail.tick_status, 404, 'tick refused: sending disabled')
  assert.ok(appStep.detail.leads_read > 0 && appStep.detail.scans_read > 0, 'scans and leads read back')
  console.log(`ok   recovery drill with the app: ready in ${appStep.detail.ready_ms} ms, whole drill ${j.measured_rto_ms} ms, RPO at drill ${j.rpo_at_drill_s} s`)
} finally { rmSync(T, { recursive: true, force: true }) }
